import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Aspects } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ProcessorStack } from '../../lib/stacks/processor-stack';

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('ProcessorStack', () => {
  let app: cdk.App;
  let stack: ProcessorStack;
  let template: Template;

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

    stack = new ProcessorStack(app, 'TestProcessorStack', {
      env,
      rawArticlesBucket,
      processedArticlesBucket,
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

  test('IAM role grants bedrock:InvokeModel on the Claude 3.5 Sonnet ARN', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Resource: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0',
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
