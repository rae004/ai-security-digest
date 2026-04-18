#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { StorageStack } from '../lib/stacks/storage-stack';

const app = new cdk.App();

new StorageStack(app, 'AiSecurityDigestStorageStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'AI Security Digest — S3 storage layer',
});

// CDK NAG: AWS Solutions checks on the entire app
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
