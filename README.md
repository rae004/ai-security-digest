# AI Security Digest

A fully serverless daily email digest pipeline for AI and security intelligence. It scrapes curated sources, uses AWS Bedrock (Claude Sonnet 4.6) to summarize and triage findings by relevance and severity, and delivers a formatted report via Amazon SES — every morning at 06:00 UTC.

---

## Architecture

```
EventBridge Scheduler (daily 06:00 UTC)
        │
        ▼
Step Functions Express Workflow
  ├── Parallel Scrape
  │     ├── Lambda: rss-scraper    (Krebs, THN, Schneier, SANS ISC, AWS blogs)
  │     ├── Lambda: nvd-scraper    (NVD REST API v2)
  │     ├── Lambda: arxiv-scraper  (ArXiv API)
  │     └── Lambda: x-scraper      (X/Twitter stub — disabled by default)
  │           │
  │           ▼  raw JSON → S3 raw-articles/
  ├── Lambda: processor
  │     └── Bedrock Claude Sonnet 4.6 — summarize + triage each article
  │           │
  │           ▼  analyzed JSON → S3 processed-articles/
  ├── Lambda: filter
  │     └── Severity/category filter → deduplication (7-day seen-ID window)
  │           │
  │           ▼  digest payload → S3 digests/
  └── Lambda: notifier
        └── SES → daily HTML email digest
```

---

## CDK Stacks

Six stacks are deployed to `us-east-1` under the `CDK_DEFAULT_ACCOUNT`:

| Stack | Name | Purpose |
|---|---|---|
| `StorageStack` | `AiSecurityDigestStorageStack` | S3 buckets (KMS-encrypted, versioned) |
| `IngestionStack` | `AiSecurityDigestIngestionStack` | Scraper Lambdas + `sources.json` seed |
| `ProcessorStack` | `AiSecurityDigestProcessorStack` | Bedrock processor Lambda |
| `OrchestrationStack` | `AiSecurityDigestOrchestrationStack` | Step Functions pipeline + Filter/Notifier Lambdas |
| `ObservabilityStack` | `AiSecurityDigestObservabilityStack` | CloudWatch Dashboard, alarms, AWS Budget |
| `SchedulerStack` | `AiSecurityDigestSchedulerStack` | EventBridge Scheduler (daily trigger) |

### S3 Buckets

| Bucket | Lifecycle | Purpose |
|---|---|---|
| `ai-security-digest-config-{account}` | Retained | `sources.json` config |
| `ai-security-digest-raw-{account}` | 7 days | Raw scraped articles |
| `ai-security-digest-processed-{account}` | 30 days | Bedrock-analyzed articles |
| `ai-security-digest-digests-{account}` | 90 days | Digest payloads + seen-ID files |

All buckets use SSE-KMS with a shared customer-managed key (annual rotation), S3 access logging, enforced SSL, and block-all public access.

---

## Sources

### RSS / Atom Feeds

| Source | Focus |
|---|---|
| Krebs on Security | Threat intelligence, breaches |
| The Hacker News | Vulnerability disclosures, exploits |
| Bruce Schneier | Security analysis and policy |
| SANS Internet Storm Center | Daily threat summaries |
| AWS Security Blog | AWS security advisories and best practices |
| AWS Machine Learning Blog | AWS ML/AI product announcements |

### APIs

| Source | Notes |
|---|---|
| NVD REST API v2 | Recent CVEs — no API key required (rate-limited); API key support is a future enhancement |
| ArXiv API | Recent AI and security research papers — toggleable |

### Social (stub)

| Source | Notes |
|---|---|
| X / Twitter | Stub implementation — returns 0 articles. Requires a paid X API key to enable. Set `enabled: true` in `sources.json` once a key is available. |

Sources are driven by `config/sources.json`, seeded to S3 on deploy. What requires redeployment depends on the change:

- **Toggle any existing source on/off** — S3 update only
- **Add a new RSS/Atom feed URL** — S3 update only (the RSS Lambda iterates all enabled entries)
- **Add a new API scraper type** (e.g., GitHub) — requires a new Lambda and CDK redeployment; each API type (`nvd`, `arxiv`) has its own dedicated Lambda
- **Add a new X/social handle** — S3 update only, once the X scraper is implemented; currently a stub that always returns 0 articles

---

## AI Triage

Each article is analyzed by Bedrock Claude Sonnet 4.6 and tagged with:

```typescript
interface AnalyzedArticle {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceType: 'rss' | 'nvd' | 'arxiv' | 'x';
  content: string;
  publishedAt: string;
  scrapedAt: string;
  summary: string;          // 2–3 sentence Bedrock summary
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  relevance: {
    category: 'BEDROCK_AGENTCORE' | 'AI_GENERAL' | 'AWS_SECURITY' | 'OTHER';
    score: number;          // 0–100
    reasoning: string;
  };
  affectedProducts: string[];
}
```

### Filter Thresholds

Articles are included in the digest if their severity meets or exceeds the minimum for their category:

| Category | Minimum Severity | Rationale |
|---|---|---|
| `BEDROCK_AGENTCORE` | INFO (always include) | Core focus of the digest |
| `AI_GENERAL` | MEDIUM | Central purpose — AI security news |
| `AWS_SECURITY` | HIGH | Non-AI AWS items only when severe |
| `OTHER` | CRITICAL | Off-topic items only at highest severity |

Included articles are sorted by severity descending, then by relevance score descending.

### Deduplication

The filter Lambda maintains a 7-day rolling window of sent article IDs in `digests/sent-ids/YYYY-MM-DD.json`. Articles included in a previous digest are silently skipped, preventing duplicates across daily runs.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.9 |
| Runtime | Node.js 22.x (all Lambdas) |
| IaC | AWS CDK v2 (`aws-cdk-lib` ^2.248) |
| AI | AWS Bedrock — Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`) |
| Orchestration | AWS Step Functions (Express Workflow) |
| Scheduler | EventBridge Scheduler (L2) |
| Email | Amazon SES |
| Config | SSM Parameter Store |
| XML parsing | `fast-xml-parser` |
| Testing | Jest 30 + `ts-jest` |
| Linting | ESLint 10 + `@typescript-eslint` strict |
| Security | CDK NAG `AwsSolutionsChecks` |

---

## Project Structure

```
ai-security-digest/
├── bin/
│   └── app.ts                          # CDK entry point — stack instantiation
├── lib/
│   └── stacks/
│       ├── storage-stack.ts            # S3 buckets + KMS key
│       ├── ingestion-stack.ts          # Scraper Lambdas + sources.json BucketDeployment
│       ├── processor-stack.ts          # Bedrock processor Lambda
│       ├── orchestration-stack.ts      # Step Functions + Filter/Notifier Lambdas
│       ├── observability-stack.ts      # CloudWatch Dashboard, alarms, Budget
│       └── scheduler-stack.ts          # EventBridge Scheduler (daily trigger)
├── src/
│   └── lambda/
│       ├── scrapers/
│       │   ├── rss/index.ts            # RSS/Atom feed scraper
│       │   ├── nvd/index.ts            # NVD REST API v2 scraper
│       │   ├── arxiv/index.ts          # ArXiv API scraper
│       │   └── x/index.ts              # X/Twitter stub
│       ├── processor/
│       │   ├── index.ts                # Bedrock triage + summarization
│       │   └── bedrock-client.ts       # Bedrock Runtime client
│       ├── filter/index.ts             # Severity filter + deduplication
│       ├── notifier/index.ts           # SES email formatter + sender
│       └── shared/
│           ├── s3-client.ts            # getJsonFromS3 / putJsonToS3
│           ├── ssm-client.ts           # getParameter helper
│           └── types.ts                # Shared interfaces
├── config/
│   └── sources.json                    # Seeded into the config S3 bucket on deploy
├── docs/
│   ├── plan.md                         # Architecture decisions and build phases
│   └── aws-deployment-steps.md         # Step-by-step AWS deployment guide
├── test/
│   ├── unit/
│   │   ├── processor/processor.test.ts
│   │   └── filter/filter.test.ts
│   └── cdk/
│       ├── ingestion-stack.test.ts
│       ├── processor-stack.test.ts
│       ├── orchestration-stack.test.ts
│       └── scheduler-stack.test.ts
├── jest.config.js
├── tsconfig.json
└── cdk.json
```

---

## npm Scripts

| Script | Command | Description |
|---|---|---|
| `build` | `tsc` | Compile TypeScript |
| `watch` | `tsc -w` | Watch mode |
| `test` | `jest` | Run all tests |
| `lint` | `eslint . --ext .ts` | Lint check |
| `lint:fix` | `eslint . --ext .ts --fix` | Lint + auto-fix |
| `cdk` | `cdk` | CDK CLI passthrough |

---

## Prerequisites

- Node.js 22 (via NVM recommended)
- AWS CLI v2 with SSO configured (`aws sso login`)
- AWS CDK v2 (`npm install -g aws-cdk`)
- CDK bootstrap run at least once in `us-east-1` for your account
- A verified SES domain or email address in `us-east-1`
  - For arbitrary recipients, your account must have SES production access (out of sandbox)

---

## Deployment

Full step-by-step instructions — including SES domain verification, Route 53 DKIM setup, SSM parameter configuration, and smoke-testing — are in [`docs/aws-deployment-steps.md`](docs/aws-deployment-steps.md).

**Quick deploy** (after SSO login and CDK bootstrap):

```bash
npm run build
npx cdk synth
npx cdk deploy --all
```

**Post-deploy: configure email**

```bash
# Set verified sender (SES identity must exist)
aws ssm put-parameter \
  --name /ai-security-digest/sender \
  --value "no-reply@YOUR_DOMAIN" \
  --overwrite

# Set comma-separated recipients
aws ssm put-parameter \
  --name /ai-security-digest/recipients \
  --value "you@example.com" \
  --overwrite
```

---

## Configuration

### `config/sources.json`

Controls which sources are scraped. Seeded to S3 on deploy. Toggling existing sources and adding new RSS feed URLs only requires editing the S3 object — see the note above for what does and doesn't require redeployment.

```json
{
  "rss": [
    { "name": "Krebs on Security",         "url": "https://krebsonsecurity.com/feed/",                          "enabled": true },
    { "name": "The Hacker News",           "url": "https://feeds.feedburner.com/TheHackersNews",                "enabled": true },
    { "name": "Bruce Schneier",            "url": "https://www.schneier.com/feed/atom",                        "enabled": true },
    { "name": "SANS Internet Storm Center","url": "https://isc.sans.edu/rssfeed_full.xml",                     "enabled": true },
    { "name": "AWS Security Blog",         "url": "https://aws.amazon.com/blogs/security/feed/",               "enabled": true },
    { "name": "AWS Machine Learning Blog", "url": "https://aws.amazon.com/blogs/machine-learning/feed/",       "enabled": true }
  ],
  "apis": [
    { "name": "NVD",   "type": "nvd",   "enabled": true },
    { "name": "ArXiv", "type": "arxiv", "enabled": true }
  ],
  "social": [
    { "name": "Simon Willison", "platform": "x", "handle": "simonw",      "enabled": false },
    { "name": "Trail of Bits",  "platform": "x", "handle": "trailofbits", "enabled": false }
  ]
}
```

### SSM Parameters

| Parameter | Description |
|---|---|
| `/ai-security-digest/sender` | Verified SES sender address (e.g. `no-reply@YOUR_DOMAIN`) |
| `/ai-security-digest/recipients` | Comma-separated recipient email addresses |

Both parameters are created with placeholder values on deploy and must be updated before the first run.

### Schedule

The pipeline runs daily at **06:00 UTC** by default. To change the schedule:

```bash
aws scheduler update-schedule \
  --name ai-security-digest-daily \
  --schedule-expression "cron(0 8 * * ? *)" \
  --flexible-time-window '{"Mode":"OFF"}'
```

---

## Observability

- **CloudWatch Dashboard**: `AI-Security-Digest` — pipeline executions, Lambda errors, processor p95 duration, SES send/bounce metrics
- **Alarms** (SNS → email):
  - Lambda errors — one alarm per function (threshold: ≥1 error in 5 min)
  - Step Functions pipeline failures (threshold: ≥1 failure in 5 min)
  - SES bounce rate ≥ 5% (SES auto-suspends at 10%)
- **AWS Budget**: $20/month cap with alerts at 80% and 100%
- **X-Ray**: enabled on all Lambdas and the Step Functions state machine

**Subscribe your email to the alarm topic** after deploy (the SNS topic ARN is in the `AiSecurityDigestObservabilityStack` outputs):

```bash
aws sns subscribe \
  --topic-arn <AlarmTopicArn> \
  --protocol email \
  --notification-endpoint you@example.com
```

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint

# Synthesize CloudFormation (no deploy)
npx cdk synth
```

All tests must pass and `npm run lint` must be clean before deploying. CDK NAG `AwsSolutionsChecks` runs at synth time — any unsuppressed finding will fail the CDK NAG test suite.

---

## Estimated Cost

| Service | Est. Cost / month |
|---|---|
| Lambda (all 7 functions, daily runs) | ~$0.10 |
| Step Functions Express Workflow | ~$0.01 |
| Bedrock Claude Sonnet 4.6 | ~$2–8 (varies with article volume) |
| S3 (4 buckets + access logs) | ~$0.05 |
| Amazon SES | ~$0.00 (under free tier for low volume) |
| EventBridge Scheduler | ~$0.00 |
| CloudWatch (Dashboard + alarms) | ~$0.50 |
| **Total** | **~$3–10 / month** |

A $20/month AWS Budget alarm is deployed by default.

---

## Security

| Control | Implementation |
|---|---|
| Encryption at rest | SSE-KMS on all S3 buckets and the SNS alarm topic; annual key rotation |
| Encryption in transit | `enforceSSL` on all S3 buckets; SNS resource policy denies non-SSL publishes |
| IAM least-privilege | Each Lambda has a scoped role — read/write only the buckets it needs |
| No hardcoded secrets | Sender/recipient config via SSM; X API key (when enabled) via Secrets Manager |
| CDK NAG | `AwsSolutionsChecks` applied to the entire app; all findings either resolved or suppressed with documented reasons |
| S3 access logging | All data buckets log to a dedicated access-logs bucket |
| S3 versioning | Enabled on all buckets |
| Block public access | Enabled on all buckets |

---

## Future Upgrades

- **X/Twitter scraper**: implement once a paid X API key is available; set `enabled: true` in `sources.json` to activate
- **NVD API key**: add SSM-backed `NVD_API_KEY` environment variable to remove NVD rate limiting
- **Agent Core**: upgrade path if the analysis step needs multi-step autonomous reasoning (e.g. CVE deep-dive)
- **Slack integration**: deliver digest to a Slack channel alongside or instead of email
- **Web dashboard**: S3-hosted static site for browsing historical digests
