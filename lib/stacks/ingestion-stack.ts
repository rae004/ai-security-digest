import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { BundlingOptions, NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface IngestionStackProps extends cdk.StackProps {
  configBucket: s3.IBucket;
  rawArticlesBucket: s3.IBucket;
}

export class IngestionStack extends cdk.Stack {
  public readonly rssScraperFn: lambda.IFunction;
  public readonly nvdScraperFn: lambda.IFunction;
  public readonly arxivScraperFn: lambda.IFunction;
  public readonly xScraperFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);

    const { configBucket, rawArticlesBucket } = props;

    // ── Shared Lambda config ───────────────────────────────────────────────────
    const scraperDir = path.join(__dirname, '../../src/lambda/scrapers');

    const commonBundling: BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
      target: 'node22',
      minify: true,
      sourceMap: false,
    };

    const commonEnv: Record<string, string> = {
      CONFIG_BUCKET: configBucket.bucketName,
      RAW_ARTICLES_BUCKET: rawArticlesBucket.bucketName,
      NODE_OPTIONS: '--enable-source-maps',
    };

    // ── RSS scraper ────────────────────────────────────────────────────────────
    const rssFn = new NodejsFunction(this, 'RssScraper', {
      description: 'Scrapes enabled RSS/Atom feeds and writes raw articles to S3',
      entry: path.join(scraperDir, 'rss/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: commonEnv,
      bundling: commonBundling,
    });

    // ── NVD scraper ────────────────────────────────────────────────────────────
    const nvdFn = new NodejsFunction(this, 'NvdScraper', {
      description: 'Queries NVD API v2 for recent CVEs and writes raw articles to S3',
      entry: path.join(scraperDir, 'nvd/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        ...commonEnv,
        // NVD_API_KEY: inject via SSM Parameter if available (see README)
      },
      bundling: commonBundling,
    });

    // ── ArXiv scraper ──────────────────────────────────────────────────────────
    const arxivFn = new NodejsFunction(this, 'ArxivScraper', {
      description: 'Queries ArXiv API for recent AI/security papers and writes raw articles to S3',
      entry: path.join(scraperDir, 'arxiv/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: commonEnv,
      bundling: commonBundling,
    });

    // ── X (Twitter) scraper stub ───────────────────────────────────────────────
    const xFn = new NodejsFunction(this, 'XScraper', {
      description: 'X/Twitter scraper stub — requires paid X API key to activate',
      entry: path.join(scraperDir, 'x/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 128,
      environment: commonEnv,
      bundling: commonBundling,
    });

    this.rssScraperFn = rssFn;
    this.nvdScraperFn = nvdFn;
    this.arxivScraperFn = arxivFn;
    this.xScraperFn = xFn;

    // ── IAM grants ─────────────────────────────────────────────────────────────
    configBucket.grantRead(rssFn);
    configBucket.grantRead(nvdFn);
    configBucket.grantRead(arxivFn);
    configBucket.grantRead(xFn);

    rawArticlesBucket.grantPut(rssFn);
    rawArticlesBucket.grantPut(nvdFn);
    rawArticlesBucket.grantPut(arxivFn);

    // ── sources.json → config bucket ──────────────────────────────────────────
    const sourcesDeployment = new BucketDeployment(this, 'SourcesDeployment', {
      sources: [Source.asset(path.join(__dirname, '../../config'))],
      destinationBucket: configBucket,
      prune: false, // never delete existing manual edits to sources.json
    });

    // ── CloudFormation outputs ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RssScraperFunctionName', {
      value: rssFn.functionName,
      description: 'RSS scraper Lambda function name',
    });
    new cdk.CfnOutput(this, 'NvdScraperFunctionName', {
      value: nvdFn.functionName,
      description: 'NVD scraper Lambda function name',
    });
    new cdk.CfnOutput(this, 'ArxivScraperFunctionName', {
      value: arxivFn.functionName,
      description: 'ArXiv scraper Lambda function name',
    });

    // ── CDK NAG suppressions ───────────────────────────────────────────────────
    const scraperFunctions = [rssFn, nvdFn, arxivFn, xFn];
    for (const fn of scraperFunctions) {
      NagSuppressions.addResourceSuppressions(
        fn,
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
        ],
        true, // apply to role and inline policy children
      );
    }

    // BucketDeployment uses an internal CDK custom-resource Lambda
    NagSuppressions.addResourceSuppressions(
      sourcesDeployment,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CDK BucketDeployment custom resource uses AWSLambdaBasicExecutionRole.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK BucketDeployment requires S3 wildcard for asset upload.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'CDK BucketDeployment uses a CDK-managed Lambda runtime.',
        },
      ],
      true,
    );
  }
}
