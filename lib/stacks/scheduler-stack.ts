import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface SchedulerStackProps extends cdk.StackProps {
  stateMachine: sfn.IStateMachine;
  /**
   * Cron expression for when to run the pipeline (UTC).
   * Defaults to 06:00 UTC daily (good morning coverage for US east coast).
   */
  scheduleCron?: scheduler.CronOptionsWithTimezone;
}

export class SchedulerStack extends cdk.Stack {
  public readonly schedule: scheduler.Schedule;

  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const { stateMachine } = props;

    const cronOptions: scheduler.CronOptionsWithTimezone = props.scheduleCron ?? {
      hour: '6',
      minute: '0',
      timeZone: cdk.TimeZone.ETC_UTC,
    };

    // ── IAM role for the scheduler to invoke Step Functions ────────────────────
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Allows EventBridge Scheduler to start the AI Security Digest pipeline',
      inlinePolicies: {
        StartExecution: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'StartDigestPipeline',
              actions: ['states:StartExecution'],
              resources: [stateMachine.stateMachineArn],
            }),
          ],
        }),
      },
    });

    // ── EventBridge Scheduler ──────────────────────────────────────────────────
    const target = new schedulerTargets.StepFunctionsStartExecution(stateMachine, {
      role: schedulerRole,
    });

    this.schedule = new scheduler.Schedule(this, 'DailySchedule', {
      scheduleName: 'ai-security-digest-daily',
      description: 'Triggers the AI Security Digest pipeline once per day',
      schedule: scheduler.ScheduleExpression.cron(cronOptions),
      target,
      enabled: true,
    });

    // ── CloudFormation outputs ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ScheduleName', {
      value: this.schedule.scheduleName,
      description: 'EventBridge Scheduler name — disable/enable via console or CLI',
    });

    new cdk.CfnOutput(this, 'NextRunHint', {
      value: `Daily at 06:00 UTC — override with: aws scheduler update-schedule --name ai-security-digest-daily --schedule-expression "cron(...)"`,
      description: 'Schedule hint — update the cron expression to change run time',
    });

    // ── CDK NAG suppressions ───────────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      schedulerRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'The scheduler role only grants states:StartExecution on the exact state machine ARN; no wildcard resources are used.',
        },
      ],
      true,
    );
  }
}
