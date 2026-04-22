#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { IngestionStack } from '../lib/stacks/ingestion-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';
import { OrchestrationStack } from '../lib/stacks/orchestration-stack';
import { ProcessorStack } from '../lib/stacks/processor-stack';
import { SchedulerStack } from '../lib/stacks/scheduler-stack';
import { StorageStack } from '../lib/stacks/storage-stack';

const app = new cdk.App();

// ── User-configurable context values (set in cdk.json or via --context flag) ──
const region         = (app.node.tryGetContext('ai-security-digest:region')           as string) ?? 'us-east-1';
const monthlyBudget  = Number(app.node.tryGetContext('ai-security-digest:monthlyBudgetUsd') ?? 20);
const scheduleHour   = (app.node.tryGetContext('ai-security-digest:scheduleHour')     as string) ?? '6';
const scheduleMinute = (app.node.tryGetContext('ai-security-digest:scheduleMinute')   as string) ?? '0';

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

const storageStack = new StorageStack(app, 'AiSecurityDigestStorageStack', {
  env,
  description: 'AI Security Digest — S3 storage layer',
});

const ingestionStack = new IngestionStack(app, 'AiSecurityDigestIngestionStack', {
  env,
  description: 'AI Security Digest — Scraper Lambdas + sources.json deployment',
  configBucket: storageStack.configBucket,
  rawArticlesBucket: storageStack.rawArticlesBucket,
});
ingestionStack.addDependency(storageStack);

const processorStack = new ProcessorStack(app, 'AiSecurityDigestProcessorStack', {
  env,
  description: 'AI Security Digest — Bedrock processor Lambda',
  rawArticlesBucket: storageStack.rawArticlesBucket,
  processedArticlesBucket: storageStack.processedArticlesBucket,
  digestsBucket: storageStack.digestsBucket,
});
processorStack.addDependency(storageStack);

const orchestrationStack = new OrchestrationStack(app, 'AiSecurityDigestOrchestrationStack', {
  env,
  description: 'AI Security Digest — Filter Lambda + Step Functions pipeline',
  processedArticlesBucket: storageStack.processedArticlesBucket,
  digestsBucket: storageStack.digestsBucket,
  rssScraperFn: ingestionStack.rssScraperFn,
  nvdScraperFn: ingestionStack.nvdScraperFn,
  arxivScraperFn: ingestionStack.arxivScraperFn,
  xScraperFn: ingestionStack.xScraperFn,
  processorFn: processorStack.processorFn,
});
orchestrationStack.addDependency(ingestionStack);
orchestrationStack.addDependency(processorStack);

const observabilityStack = new ObservabilityStack(app, 'AiSecurityDigestObservabilityStack', {
  env,
  description: 'AI Security Digest — CloudWatch Dashboard, alarms, and AWS Budget',
  stateMachine: orchestrationStack.stateMachine,
  scraperFunctions: [
    { fn: ingestionStack.rssScraperFn, label: 'RssScraper' },
    { fn: ingestionStack.nvdScraperFn, label: 'NvdScraper' },
    { fn: ingestionStack.arxivScraperFn, label: 'ArxivScraper' },
    { fn: ingestionStack.xScraperFn, label: 'XScraper' },
  ],
  processorFn: { fn: processorStack.processorFn, label: 'Processor' },
  filterFn: { fn: orchestrationStack.filterFn, label: 'Filter' },
  notifierFn: { fn: orchestrationStack.notifierFn, label: 'Notifier' },
  monthlyBudgetUsd: monthlyBudget,
});
observabilityStack.addDependency(orchestrationStack);

const schedulerStack = new SchedulerStack(app, 'AiSecurityDigestSchedulerStack', {
  env,
  description: 'AI Security Digest — EventBridge Scheduler (daily pipeline trigger)',
  stateMachine: orchestrationStack.stateMachine,
  scheduleCron: {
    hour: scheduleHour,
    minute: scheduleMinute,
    timeZone: cdk.TimeZone.ETC_UTC,
  },
});
schedulerStack.addDependency(orchestrationStack);

// CDK NAG: AWS Solutions checks on the entire app
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
