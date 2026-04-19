# AI Security Intelligence Digest — Architecture Plan

## Project Overview

A fully serverless, daily email digest pipeline that scrapes curated AI/security sources, uses AWS Bedrock (Claude) to summarize and triage findings by relevance and severity, and delivers a formatted report via SES. Config-driven so sources can be added/toggled without code changes.

---

## Key Decisions

### On Agent Core

Agent Core is best suited for open-ended, multi-turn agentic workflows where an LLM needs to decide *which tools to call and when*. This pipeline is **deterministic**: scrape → analyze → filter → email on a fixed schedule. Agent Core would add cost and complexity without meaningful benefit here.

**Decision:** Step Functions for orchestration, Bedrock (Claude Sonnet 4.6) invoked directly from Lambda for analysis. Agent Core left as a future upgrade path if the analysis step needs to become more autonomous (e.g. "go find more about this CVE").

### AWS Authentication

AWS SSO with the default profile. No `process.env` credential objects — CDK and SDK use the ambient SSO session. Do not interfere with configured SSO profiles.

### Region

`us-east-1`

---

## Architecture Overview

```
EventBridge Scheduler (daily)
        │
        ▼
Step Functions State Machine
  ├── Parallel Scrape
  │     ├── Lambda: rss-scraper       (Krebs, THN, Schneier, SANS, AWS blogs)
  │     ├── Lambda: nvd-scraper       (NVD REST API v2)
  │     ├── Lambda: arxiv-scraper     (ArXiv API — toggleable)
  │     └── Lambda: x-scraper         (X/Twitter — toggleable, disabled by default)
  │           │
  │           ▼ (raw articles → S3 raw/)
  ├── Lambda: processor
  │     └── Bedrock Claude — summarize + triage each article
  │           │
  │           ▼ (analyzed articles → S3 processed/)
  ├── Lambda: filter
  │     └── Priority filter: Bedrock/AgentCore → AI → severe AWS
  │           │
  │           ▼ (digest payload → S3 digests/)
  └── Lambda: notifier
        └── SES → daily email digest
```

---

## Source Configuration

A `sources.json` file stored in S3 (writable without redeployment) drives all scraper behavior. Adding a new source = edit the JSON in S3. No redeployment needed.

```jsonc
{
  "rss": [
    { "name": "Krebs on Security",   "url": "https://krebsonsecurity.com/feed/", "enabled": true },
    { "name": "The Hacker News",     "url": "https://feeds.feedburner.com/TheHackersNews", "enabled": true },
    { "name": "Bruce Schneier",      "url": "https://www.schneier.com/feed/atom", "enabled": true },
    { "name": "SANS ISC",            "url": "https://isc.sans.edu/rssfeed_full.xml", "enabled": true },
    { "name": "AWS Security Blog",   "url": "https://aws.amazon.com/blogs/security/feed/", "enabled": true },
    { "name": "AWS Machine Learning Blog", "url": "https://aws.amazon.com/blogs/machine-learning/feed/", "enabled": true }
  ],
  "apis": [
    { "name": "NVD",    "type": "nvd",    "enabled": true },
    { "name": "ArXiv",  "type": "arxiv",  "enabled": true }
  ],
  "social": [
    { "name": "Simon Willison", "platform": "x", "handle": "simonw",       "enabled": false },
    { "name": "Trail of Bits",  "platform": "x", "handle": "trailofbits",  "enabled": false }
  ]
}
```

**Notes:**
- X/Twitter sources are disabled by default — require a paid X API key stored in Secrets Manager to enable
- ArXiv is toggleable — set `enabled: false` if it generates too much noise
- New sources added to this file take effect on the next scheduled run

---

## AI Triage Schema

Each article gets analyzed by Bedrock and tagged:

```typescript
interface AnalyzedArticle {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary: string;           // 2-3 sentence Bedrock summary
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  relevance: {
    category: 'BEDROCK_AGENTCORE' | 'AI_GENERAL' | 'AWS_SECURITY' | 'OTHER';
    score: number;           // 0–100
    reasoning: string;       // why this was flagged
  };
  affectedProducts: string[];
}
```

**Filter rule:** Include if `category !== 'OTHER'` OR `severity === 'CRITICAL'`.

---

## Project Structure

```
ai-security-digest/
├── bin/
│   └── app.ts                          # CDK entry point
├── lib/
│   └── stacks/
│       ├── storage-stack.ts            # S3 buckets
│       ├── ingestion-stack.ts          # EventBridge + scrapers
│       ├── processing-stack.ts         # Step Functions + processor/filter
│       └── notification-stack.ts       # SES + notifier Lambda
├── src/
│   └── lambda/
│       ├── scrapers/
│       │   ├── rss/index.ts
│       │   ├── nvd/index.ts
│       │   ├── arxiv/index.ts
│       │   └── x/index.ts
│       ├── processor/index.ts          # Bedrock invocation + triage
│       ├── filter/index.ts
│       ├── notifier/index.ts           # SES email formatter
│       └── shared/
│           ├── bedrock-client.ts
│           ├── s3-client.ts
│           └── types.ts                # Shared interfaces
├── config/
│   └── sources.json                    # Seeded into S3 on deploy
├── docs/
│   └── plan.md                         # This file
├── test/
│   ├── unit/
│   │   ├── processor.test.ts
│   │   ├── filter.test.ts
│   │   └── notifier.test.ts
│   └── cdk/
│       └── nag.test.ts                 # CDK NAG assertions
├── .eslintrc.js
├── jest.config.ts
├── tsconfig.json
└── cdk.json
```

---

## CDK Stack Design

### StorageStack
- S3 bucket: `raw-articles` (7-day lifecycle)
- S3 bucket: `processed-articles` (30-day lifecycle)
- S3 bucket: `digests` (90-day lifecycle)
- S3 bucket: `config` (sources.json lives here)
- All buckets: SSE-KMS, versioned, block public access, access logging enabled

### IngestionStack
- EventBridge Scheduler: daily cron (configurable)
- Step Functions Express Workflow — cheaper than Standard for short executions
- 4 scraper Lambdas (Node 22, arm64, 256MB, 5min timeout)
- IAM: least-privilege per Lambda (scoped to only the S3 prefix it writes to)

### ProcessingStack
- Processor Lambda (Node 22, arm64, 512MB, 10min timeout)
  - Bedrock `InvokeModel` permission scoped to specific model ARN
- Filter Lambda (Node 22, arm64, 256MB, 2min timeout)

### NotificationStack
- SES: verified identity (us-east-1, out of sandbox)
- Notifier Lambda
- SSM Parameter: `/ai-security-digest/recipients` — comma-separated email list
  - Adding/removing recipients = update SSM param, no redeployment needed

### ObservabilityStack (cross-cutting)
- CloudWatch Dashboard
- Alarms: Lambda errors, Step Functions failures, SES bounce rate
- AWS Budget: $20/month threshold with SNS → email alert
- X-Ray tracing on all Lambdas and Step Functions

---

## Well-Architected Alignment

| Pillar | Implementation |
|---|---|
| **Security** | KMS encryption at rest, TLS in transit, least-privilege IAM per Lambda, no hardcoded secrets, X API key in Secrets Manager, CDK NAG AwsSolutionsChecks |
| **Reliability** | Step Functions retries + catch states, Lambda DLQs, S3 versioning, idempotent scraper design |
| **Performance Efficiency** | arm64 Lambdas, parallel scrape state in Step Functions, S3 for state hand-off between steps |
| **Cost Optimization** | Express Workflows, S3 lifecycle policies, Budget alarm, arm64 savings, Bedrock pay-per-token |
| **Operational Excellence** | Structured JSON logs, X-Ray tracing, CloudWatch Dashboard, source config in S3 (no redeploy) |

---

## CDK NAG

```typescript
// bin/app.ts
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
```

All rule suppressions documented with `reason` strings inline in the stack code. No blanket suppressions.

---

## ESLint & Testing

- **ESLint:** `@typescript-eslint` recommended + strict rules, no `any`, enforce explicit return types
- **Jest:** Unit tests for processor (triage logic), filter (relevance scoring), notifier (email formatting)
- **CDK NAG test:** Assertions that no unresolved NAG findings exist at synth time

---

## Estimated AWS Cost

| Service | Est. Cost/month |
|---|---|
| Lambda (all functions) | ~$0.10 |
| Step Functions Express | ~$0.01 |
| Bedrock Claude Sonnet 4.6 | ~$2–8 (depends on article volume) |
| S3 | ~$0.05 |
| SES | ~$0.00 (under free tier for low volume) |
| EventBridge Scheduler | ~$0.00 |
| CloudWatch | ~$0.50 |
| **Total** | **~$3–10/month** |

Budget alarm set at $20/month.

---

## Build Phases

| Phase | Deliverable |
|---|---|
| **1** | CDK project scaffolding, ESLint + Jest config, CDK NAG wired, StorageStack |
| **2** | Scraper Lambdas (RSS + NVD + ArXiv), shared types, sources.json seeded to S3 |
| **3** | Processor Lambda (Bedrock triage + summarization) |
| **4** | Filter Lambda + Step Functions state machine wiring all scrapers → processor → filter |
| **5** | SES Notifier Lambda + email digest template |
| **6** | Observability: CloudWatch Dashboard, alarms, Budget |
| **7** | Unit tests + CDK NAG clean pass |

---

## Open Items / Future Upgrades

- X/Twitter scraper: implement once a paid X API key is available; set `enabled: false` in sources.json until then
- Agent Core: upgrade path if the analysis step needs multi-step autonomous reasoning (e.g. CVE deep-dive)
- Web dashboard: future phase if email is not enough
- Slack integration: future phase alongside or instead of email
