#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { IngestionStack } from '../lib/stacks/ingestion-stack';
import { ProcessorStack } from '../lib/stacks/processor-stack';
import { StorageStack } from '../lib/stacks/storage-stack';

const app = new cdk.App();

const storageStack = new StorageStack(app, 'AiSecurityDigestStorageStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'AI Security Digest — S3 storage layer',
});

const ingestionStack = new IngestionStack(app, 'AiSecurityDigestIngestionStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'AI Security Digest — Scraper Lambdas + sources.json deployment',
  configBucket: storageStack.configBucket,
  rawArticlesBucket: storageStack.rawArticlesBucket,
});
ingestionStack.addDependency(storageStack);

const processorStack = new ProcessorStack(app, 'AiSecurityDigestProcessorStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'AI Security Digest — Bedrock processor Lambda',
  rawArticlesBucket: storageStack.rawArticlesBucket,
  processedArticlesBucket: storageStack.processedArticlesBucket,
});
processorStack.addDependency(storageStack);

// CDK NAG: AWS Solutions checks on the entire app
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
