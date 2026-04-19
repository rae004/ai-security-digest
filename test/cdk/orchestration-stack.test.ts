import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Aspects } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { OrchestrationStack } from '../../lib/stacks/orchestration-stack';

// ── Test helpers ───────────────────────────────────────────────────────────────

function mockFn(scope: cdk.Stack, id: string): lambda.IFunction {
  return lambda.Function.fromFunctionArn(
    scope,
    id,
    `arn:aws:lambda:us-east-1:123456789012:function:${id}`,
  );
}

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('OrchestrationStack', () => {
  let app: cdk.App;
  let stack: OrchestrationStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    const env = { account: '123456789012', region: 'us-east-1' };

    const mockDeps = new cdk.Stack(app, 'MockDeps', { env });

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

    stack = new OrchestrationStack(app, 'TestOrchestrationStack', {
      env,
      processedArticlesBucket,
      digestsBucket,
      rssScraperFn: mockFn(mockDeps, 'RssFn'),
      nvdScraperFn: mockFn(mockDeps, 'NvdFn'),
      arxivScraperFn: mockFn(mockDeps, 'ArxivFn'),
      xScraperFn: mockFn(mockDeps, 'XFn'),
      processorFn: mockFn(mockDeps, 'ProcessorFn'),
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

  test('creates exactly 2 Lambda functions (filter, notifier)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  test('filter Lambda is described correctly', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Filters and sorts analyzed articles into a DigestPayload written to S3',
      Runtime: 'nodejs22.x',
      Timeout: 120,
    });
  });

  test('notifier Lambda is described correctly', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Reads DigestPayload from S3 and sends the daily email via SES',
      Runtime: 'nodejs22.x',
      Timeout: 120,
    });
  });

  // ── IAM policy — SES ──────────────────────────────────────────────────────────

  test('notifier Lambda role grants SES SendEmail on identity ARN', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ses:SendEmail', 'ses:SendRawEmail']),
            Resource: Match.stringLikeRegexp('arn:aws:ses:us-east-1:.*:identity/\\*'),
          }),
        ]),
      }),
    });
  });

  // ── SSM parameters ────────────────────────────────────────────────────────────

  test('creates SSM parameter for sender address', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/ai-security-digest/sender',
      Type: 'String',
    });
  });

  test('creates SSM parameter for recipients', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/ai-security-digest/recipients',
      Type: 'String',
    });
  });

  // ── Step Functions state machine ──────────────────────────────────────────────

  test('creates exactly one state machine', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  });

  test('state machine is EXPRESS type', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'EXPRESS',
    });
  });

  test('state machine has X-Ray tracing enabled', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      TracingConfiguration: { Enabled: true },
    });
  });

  test('state machine has CloudWatch logging configured', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      LoggingConfiguration: Match.objectLike({
        Level: 'ERROR',
        IncludeExecutionData: false,
      }),
    });
  });

  // ── CloudWatch log group ──────────────────────────────────────────────────────

  test('creates a CloudWatch log group for state machine logs', () => {
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
  });

  // ── CloudFormation outputs ────────────────────────────────────────────────────

  test('outputs StateMachineArn', () => {
    template.hasOutput('StateMachineArn', {});
  });

  test('outputs FilterFunctionName', () => {
    template.hasOutput('FilterFunctionName', {});
  });

  test('outputs NotifierFunctionName', () => {
    template.hasOutput('NotifierFunctionName', {});
  });

  test('outputs PostDeploySteps with SSM commands', () => {
    template.hasOutput('PostDeploySteps', {
      Description: 'Run these commands after verifying your SES identity to activate email delivery',
    });
  });
});
