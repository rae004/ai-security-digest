import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Aspects } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { IngestionStack } from '../../lib/stacks/ingestion-stack';

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('IngestionStack', () => {
  let app: cdk.App;
  let stack: IngestionStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    const env = { account: '123456789012', region: 'us-east-1' };

    const mockDeps = new cdk.Stack(app, 'MockDeps', { env });

    const configBucket = s3.Bucket.fromBucketName(mockDeps, 'ConfigBucket', 'mock-config-bucket');
    const rawArticlesBucket = s3.Bucket.fromBucketName(
      mockDeps,
      'RawBucket',
      'mock-raw-articles-bucket',
    );

    stack = new IngestionStack(app, 'TestIngestionStack', {
      env,
      configBucket,
      rawArticlesBucket,
    });

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    template = Template.fromStack(stack);
    app.synth();
  });

  // ── CDK NAG ───────────────────────────────────────────────────────────────────

  test('no unsuppressed CDK NAG errors', () => {
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    expect(errors).toHaveLength(0);
  });

  test('no unsuppressed CDK NAG warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    expect(warnings).toHaveLength(0);
  });

  // ── Lambda functions ──────────────────────────────────────────────────────────

  test('creates 4 scraper Lambdas plus the BucketDeployment helper (5 total)', () => {
    // BucketDeployment adds one CDK-managed Lambda (python runtime)
    template.resourceCountIs('AWS::Lambda::Function', 5);
  });

  test('the 4 scraper Lambdas all use nodejs22.x runtime', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs22.x' },
    });
    expect(Object.keys(functions)).toHaveLength(4);
  });

  test('RSS scraper has 5-minute timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Scrapes enabled RSS/Atom feeds and writes raw articles to S3',
      Timeout: 300,
    });
  });

  test('X scraper stub has 2-minute timeout and 128MB memory', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'X/Twitter scraper stub — requires paid X API key to activate',
      Timeout: 120,
      MemorySize: 128,
    });
  });

  // ── CloudFormation outputs ────────────────────────────────────────────────────

  test('outputs RssScraperFunctionName', () => {
    template.hasOutput('RssScraperFunctionName', {});
  });

  test('outputs NvdScraperFunctionName', () => {
    template.hasOutput('NvdScraperFunctionName', {});
  });

  test('outputs ArxivScraperFunctionName', () => {
    template.hasOutput('ArxivScraperFunctionName', {});
  });
});
