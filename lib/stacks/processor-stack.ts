import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { BundlingOptions, NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface ProcessorStackProps extends cdk.StackProps {
  rawArticlesBucket: s3.IBucket;
  processedArticlesBucket: s3.IBucket;
}

// Bedrock model ARN for Claude 3.5 Sonnet v2 — us-east-1 on-demand
const BEDROCK_MODEL_ARN =
  'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0';

export class ProcessorStack extends cdk.Stack {
  public readonly processorFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ProcessorStackProps) {
    super(scope, id, props);

    const { rawArticlesBucket, processedArticlesBucket } = props;

    // ── Processor Lambda ───────────────────────────────────────────────────────
    const bundling: BundlingOptions = {
      // Bundle Bedrock Runtime — not all Lambda runtimes include it by default
      externalModules: ['@aws-sdk/client-s3'],
      target: 'node22',
      minify: true,
      sourceMap: false,
    };

    const processorFn = new NodejsFunction(this, 'ProcessorFunction', {
      description: 'Invokes Bedrock Claude to triage and summarize raw articles',
      entry: path.join(__dirname, '../../src/lambda/processor/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(15), // up to ~200 articles × Bedrock RTT
      memorySize: 512,
      environment: {
        RAW_ARTICLES_BUCKET: rawArticlesBucket.bucketName,
        PROCESSED_ARTICLES_BUCKET: processedArticlesBucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling,
    });

    this.processorFn = processorFn;

    // ── IAM grants ─────────────────────────────────────────────────────────────
    rawArticlesBucket.grantRead(processorFn);
    processedArticlesBucket.grantPut(processorFn);

    // Bedrock: scoped to the specific model ARN — no wildcard needed
    processorFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeModel',
        actions: ['bedrock:InvokeModel'],
        resources: [BEDROCK_MODEL_ARN],
      }),
    );

    // ── CloudFormation outputs ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ProcessorFunctionName', {
      value: processorFn.functionName,
      description: 'Processor Lambda function name',
    });

    // ── CDK NAG suppressions ───────────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      processorFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole is required for CloudWatch Logs; no broader managed policy is attached.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 GetObject/PutObject grants require a key-prefix wildcard; access is scoped to specific named buckets.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'nodejs22.x is the latest stable Node.js Lambda runtime available.',
        },
      ],
      true,
    );
  }
}
