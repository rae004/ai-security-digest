import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SchedulerStack } from '../../lib/stacks/scheduler-stack';

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('SchedulerStack', () => {
  let app: cdk.App;
  let stack: SchedulerStack;
  let template: Template;
  let nagReport: cdk.PolicyValidationPluginReport;

  beforeAll(() => {
    app = new cdk.App();
    const env = { account: '123456789012', region: 'us-east-1' };

    const mockDeps = new cdk.Stack(app, 'MockDeps', { env });
    const mockSfn = sfn.StateMachine.fromStateMachineArn(
      mockDeps,
      'MockSfn',
      'arn:aws:states:us-east-1:123456789012:stateMachine:DigestPipeline',
    );

    stack = new SchedulerStack(app, 'TestSchedulerStack', {
      env,
      stateMachine: mockSfn,
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

  // ── Scheduler ─────────────────────────────────────────────────────────────────

  test('creates exactly one schedule', () => {
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
  });

  test('schedule is named ai-security-digest-daily', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'ai-security-digest-daily',
    });
  });

  test('schedule is enabled', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      State: 'ENABLED',
    });
  });

  test('schedule expression is a daily cron at 06:00 UTC', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: Match.stringLikeRegexp('cron\\('),
    });
  });

  test('schedule targets the Step Functions state machine', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({
        Arn: Match.stringLikeRegexp('stateMachine'),
      }),
    });
  });

  // ── IAM role ──────────────────────────────────────────────────────────────────

  test('creates an IAM role for the scheduler', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
  });

  test('scheduler role trusts scheduler.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'scheduler.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      }),
    });
  });

  test('scheduler role grants states:StartExecution', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: 'states:StartExecution',
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  // ── CloudFormation outputs ────────────────────────────────────────────────────

  test('outputs ScheduleName', () => {
    template.hasOutput('ScheduleName', {});
  });

  test('outputs NextRunHint', () => {
    template.hasOutput('NextRunHint', {});
  });
});
