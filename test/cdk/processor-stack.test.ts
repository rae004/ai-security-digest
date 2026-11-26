import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ProcessorStack } from '../../lib/stacks/processor-stack';

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('ProcessorStack', () => {
  let app: cdk.App;
  let stack: ProcessorStack;
  let template: Template;
  let nagReport: cdk.PolicyValidationPluginReport;

  beforeAll(() => {
    app = new cdk.App();
    const env = { account: '123456789012', region: 'us-east-1' };

    const mockDeps = new cdk.Stack(app, 'MockDeps', { env });

    const rawArticlesBucket = s3.Bucket.fromBucketName(
      mockDeps,
      'RawBucket',
      'mock-raw-articles-bucket',
    );
    const processedArticlesBucket = s3.Bucket.fromBucketName(
      mockDeps,
      'ProcessedBucket',
      'mock-processed-articles-bucket',
    );
    const digestsBucket = s3.Bucket.fromBucketName(
      mockDeps,
      'DigestsBucket',
      'mock-digests-bucket',
    );

    stack = new ProcessorStack(app, 'TestProcessorStack', {
      env,
      rawArticlesBucket,
      processedArticlesBucket,
      digestsBucket,
    });

    nagReport = new AwsSolutionsChecks(app, { verbose: true }).validateScope(stack);
    template = Template.fromStack(stack);
    app.synth();
  });

  // ── CDK NAG ───────────────────────────────────────────────────────────────────

  test('no unacknowledged CDK NAG errors', () => {
    expect(nagReport.violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  test('no unacknowledged CDK NAG warnings', () => {
    expect(nagReport.violations.filter((v) => v.severity !== 'error')).toEqual([]);
  });

  // ── Lambda function ───────────────────────────────────────────────────────────

  test('creates exactly 1 Lambda function', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
  });

  test('processor Lambda uses NODEJS_22_X runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  test('processor Lambda has 15-minute timeout and 512MB memory', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 900,
      MemorySize: 512,
    });
  });

  test('processor Lambda description is set', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Invokes Bedrock Claude to triage and summarize raw articles',
    });
  });

  // ── IAM policy — Bedrock ──────────────────────────────────────────────────────

  test('IAM role grants bedrock:InvokeModel on both the inference profile and foundation model ARNs', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Resource: Match.arrayWith([
              'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0',
              'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
            ]),
          }),
        ]),
      }),
    });
  });

  // ── CloudFormation outputs ────────────────────────────────────────────────────

  test('outputs ProcessorFunctionName', () => {
    template.hasOutput('ProcessorFunctionName', {});
  });
});
