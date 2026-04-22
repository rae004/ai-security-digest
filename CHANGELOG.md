# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.2] - 2026-04-22

### Fixed

- Pre-filter seen article IDs in the processor Lambda before invoking Bedrock — articles already included in a previous digest are skipped entirely, eliminating redundant Bedrock calls regardless of scrape volume
- Scraper lookback window reduced from 48 hours to 26 hours (24h + 2h drift buffer) via Step Functions payload, preventing re-scraping of the previous day's articles on every daily run
- NVD scraper now filters to HIGH (≥ 7.0) and CRITICAL (≥ 9.0) CVEs at the API level via `cvssV3Severity`, eliminating 70-80% of NVD volume before it reaches the processor Lambda; rejected/withdrawn CVEs excluded via `noRejected`

### Changed

- Moved seen-IDs logic (`loadSeenIds`, `saveSeenIds`) to `src/lambda/shared/seen-ids.ts` so both the processor and filter Lambdas share one implementation
- NVD `parseNvdResponse` prepends the CVSS score and severity label to article content (`CVSS 9.8 (CRITICAL). <description>`) so the processor Lambda has structured severity context for Bedrock

---

## [1.0.1] - 2026-04-21

### Fixed

- Switch Step Functions state machine from Express to Standard Workflow. Express Workflows are hard-capped at 5 minutes by AWS; the processor Lambda processing 300+ articles via sequential Bedrock calls exceeds this limit. Standard Workflows support executions up to 1 year with negligible cost difference at once-daily frequency.

### Added

- `ExecutionsTimedOut` CloudWatch alarm (`ai-security-digest-pipeline-timeouts`) — fires on the first timeout and pages via SNS, same behaviour as the existing failure alarm (+$0.10/month)
- Orange `Timed Out` metric line on the Pipeline Executions dashboard widget alongside the existing `Succeeded` and `Failed` lines

---

## [1.0.0] - 2026-04-20

Initial release of the AI Security Digest pipeline.

### Added

- **StorageStack** — 4 KMS-encrypted, versioned S3 buckets: config, raw articles (7-day lifecycle), processed articles (30-day lifecycle), digests (90-day lifecycle); shared CMK with annual rotation; S3 access logging on all buckets
- **IngestionStack** — RSS/Atom scraper Lambda (Krebs, The Hacker News, Bruce Schneier, SANS Internet Storm Center, AWS Security Blog, AWS ML Blog); NVD REST API v2 scraper; ArXiv API scraper; X/Twitter stub (disabled by default); `sources.json` seeded to S3 via BucketDeployment — add or toggle RSS feeds without redeployment
- **ProcessorStack** — Bedrock Lambda invoking Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`) via cross-region inference profile to summarize and triage each article with severity (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW`/`INFO`) and relevance category (`BEDROCK_AGENTCORE`/`AI_GENERAL`/`AWS_SECURITY`/`OTHER`); deduplicates articles within a single run by ID
- **OrchestrationStack** — Step Functions Express Workflow (30-min timeout, X-Ray, ERROR-level CloudWatch Logs) wiring all scrapers → processor → filter → notifier in a parallel fan-out/fan-in pattern; Filter Lambda applying per-category severity thresholds and a 7-day rolling seen-ID deduplication window (stored in `digests/sent-ids/YYYY-MM-DD.json`); Notifier Lambda sending HTML email digest via SES with sender/recipient config via SSM Parameter Store
- **SchedulerStack** — EventBridge Scheduler L2 triggering the pipeline daily at 06:00 UTC; schedule time configurable via `cdk.json` context
- **ObservabilityStack** — CloudWatch Dashboard (`AI-Security-Digest`) with pipeline execution, Lambda error, processor p95 duration, and SES send/bounce widgets; per-Lambda error alarms + Step Functions failure alarm + SES bounce-rate alarm (≥5%) all routed to KMS-encrypted SNS topic; AWS Budget at configurable monthly cap (default $20) with alerts at 80% and 100%
- **CDK NAG** — `AwsSolutionsChecks` applied to the entire app; all findings resolved or suppressed with documented reasons
- **User-configurable context** — `cdk.json` context keys for `region`, `monthlyBudgetUsd`, `scheduleHour`, `scheduleMinute`; no TypeScript changes needed to customise deployment
- **CI** — GitHub Actions workflow running lint, build, test, and CDK synth as parallel jobs on every pull request
- **Tests** — 205 tests across 13 suites covering filter logic, processor deduplication, and CDK NAG assertions for all stacks
- **Docs** — Full `README.md` and step-by-step `docs/aws-deployment-steps.md` deployment guide

[1.0.0]: https://github.com/rae004/ai-security-digest/releases/tag/v1.0.0
