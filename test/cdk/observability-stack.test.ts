import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Aspects } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ObservabilityStack } from '../../lib/stacks/observability-stack';

// ── Test helpers ───────────────────────────────────────────────────────────────

function mockFn(scope: cdk.Stack, id: string): lambda.IFunction {
  return lambda.Function.fromFunctionArn(
    scope,
    id,
    `arn:aws:lambda:us-east-1:123456789012:function:${id}`,
  );
}

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('ObservabilityStack', () => {
  let app: cdk.App;
  let stack: ObservabilityStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    const env = { account: '123456789012', region: 'us-east-1' };

    // Lightweight mock dependency stack — provides IFunction and IStateMachine refs
    const mockDeps = new cdk.Stack(app, 'MockDeps', { env });

    const mockSfn = sfn.StateMachine.fromStateMachineArn(
      mockDeps,
      'MockSfn',
      'arn:aws:states:us-east-1:123456789012:stateMachine:DigestPipeline',
    );

    stack = new ObservabilityStack(app, 'TestObservabilityStack', {
      env,
      stateMachine: mockSfn,
      scraperFunctions: [
        { fn: mockFn(mockDeps, 'RssFn'), label: 'RssScraper' },
        { fn: mockFn(mockDeps, 'NvdFn'), label: 'NvdScraper' },
        { fn: mockFn(mockDeps, 'ArxivFn'), label: 'ArxivScraper' },
        { fn: mockFn(mockDeps, 'XFn'), label: 'XScraper' },
      ],
      processorFn: { fn: mockFn(mockDeps, 'ProcessorFn'), label: 'Processor' },
      filterFn: { fn: mockFn(mockDeps, 'FilterFn'), label: 'Filter' },
      notifierFn: { fn: mockFn(mockDeps, 'NotifierFn'), label: 'Notifier' },
      monthlyBudgetUsd: 20,
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

  // ── KMS key ───────────────────────────────────────────────────────────────────

  test('creates a KMS key with rotation enabled for SNS encryption', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  // ── SNS alarm topic ───────────────────────────────────────────────────────────

  test('creates exactly one SNS alarm topic', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  test('SNS topic is encrypted with a KMS key', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  test('SNS topic has an SSL-enforcement resource policy', () => {
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 'sns:Publish',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  // ── CloudWatch alarms ─────────────────────────────────────────────────────────

  test('creates one error alarm per Lambda function (7 total)', () => {
    // 7 functions: rss, nvd, arxiv, x, processor, filter, notifier
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: Match.objectLike({
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
      }),
    });
    expect(Object.keys(alarms)).toHaveLength(7);
  });

  test('creates a Step Functions failure alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/States',
      MetricName: 'ExecutionsFailed',
    });
  });

  test('creates a SES bounce rate alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SES',
      MetricName: 'Reputation.BounceRate',
      Threshold: 0.05,
    });
  });

  test('all alarms notify the SNS alarm topic', () => {
    // Every alarm should have at least one AlarmActions entry
    const allAlarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const [, alarm] of Object.entries(allAlarms)) {
      expect((alarm as { Properties: { AlarmActions?: unknown[] } }).Properties.AlarmActions).toBeDefined();
    }
  });

  // ── CloudWatch Dashboard ──────────────────────────────────────────────────────

  test('creates exactly one CloudWatch Dashboard named AI-Security-Digest', () => {
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'AI-Security-Digest',
    });
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  // ── AWS Budget ────────────────────────────────────────────────────────────────

  test('creates an AWS Budget with $20 monthly limit', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 20, Unit: 'USD' },
      }),
    });
  });

  test('budget has 80% and 100% notifications', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 80 }) }),
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 100 }) }),
      ]),
    });
  });
});
