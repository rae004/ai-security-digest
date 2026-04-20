import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

// Named Lambda entries give the dashboard/alarm labels meaningful names
export interface LambdaEntry {
  fn: lambda.IFunction;
  label: string;
}

export interface ObservabilityStackProps extends cdk.StackProps {
  stateMachine: sfn.IStateMachine;
  scraperFunctions: LambdaEntry[]; // rss, nvd, arxiv, x
  processorFn: LambdaEntry;
  filterFn: LambdaEntry;
  notifierFn: LambdaEntry;
  /** Monthly spend cap in USD; alerts at 80 % and 100 % */
  monthlyBudgetUsd?: number;
}

export class ObservabilityStack extends cdk.Stack {
  public readonly alarmTopic: sns.ITopic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const {
      stateMachine,
      scraperFunctions,
      processorFn,
      filterFn,
      notifierFn,
      monthlyBudgetUsd = 20,
    } = props;

    const allFunctions: LambdaEntry[] = [
      ...scraperFunctions,
      processorFn,
      filterFn,
      notifierFn,
    ];

    // ── KMS key for SNS encryption ─────────────────────────────────────────────
    const alarmKey = new kms.Key(this, 'AlarmTopicKey', {
      description: 'ai-security-digest: SNS alarm topic encryption key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── SNS alarm topic ────────────────────────────────────────────────────────
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'AI Security Digest — Alarms',
      masterKey: alarmKey,
    });

    // Enforce SSL for all publishers
    alarmTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyNonSslPublish',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sns:Publish'],
        resources: [alarmTopic.topicArn],
        conditions: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    );

    // Placeholder email subscription — user confirms via the AWS confirmation email
    alarmTopic.addSubscription(
      new subscriptions.EmailSubscription('update-me@example.com'),
    );

    this.alarmTopic = alarmTopic;
    const alarmAction = new cwActions.SnsAction(alarmTopic);

    // ── Helper: Lambda error alarm ─────────────────────────────────────────────
    const lambdaErrorAlarm = (entry: LambdaEntry): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, `${entry.label}ErrorAlarm`, {
        alarmName: `ai-security-digest-${entry.label.toLowerCase()}-errors`,
        alarmDescription: `${entry.label} Lambda has invocation errors`,
        metric: entry.fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
      return alarm;
    };

    // ── Lambda error alarms (one per function) ─────────────────────────────────
    const lambdaAlarms = allFunctions.map(lambdaErrorAlarm);

    // ── Step Functions failure alarm ───────────────────────────────────────────
    const sfnFailureAlarm = new cloudwatch.Alarm(this, 'SfnFailureAlarm', {
      alarmName: 'ai-security-digest-pipeline-failures',
      alarmDescription: 'AI Security Digest Step Functions execution failed',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/States',
        metricName: 'ExecutionsFailed',
        dimensionsMap: { StateMachineArn: stateMachine.stateMachineArn },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sfnFailureAlarm.addAlarmAction(alarmAction);

    // ── SES bounce rate alarm ──────────────────────────────────────────────────
    // SES automatically suspends sending at 10%; alert at 5%
    const sesBounceAlarm = new cloudwatch.Alarm(this, 'SesBounceAlarm', {
      alarmName: 'ai-security-digest-ses-bounce-rate',
      alarmDescription: 'SES bounce rate has exceeded 5% — risk of send suspension',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Reputation.BounceRate',
        period: cdk.Duration.hours(1),
        statistic: 'Average',
      }),
      threshold: 0.05,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sesBounceAlarm.addAlarmAction(alarmAction);

    // ── CloudWatch Dashboard ───────────────────────────────────────────────────
    const dashboard = new cloudwatch.Dashboard(this, 'DigestDashboard', {
      dashboardName: 'AI-Security-Digest',
    });
    this.dashboard = dashboard;

    // Row 1: Pipeline overview — SFN executions
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Pipeline Executions',
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/States',
            metricName: 'ExecutionsSucceeded',
            dimensionsMap: { StateMachineArn: stateMachine.stateMachineArn },
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
            label: 'Succeeded',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/States',
            metricName: 'ExecutionsFailed',
            dimensionsMap: { StateMachineArn: stateMachine.stateMachineArn },
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
            label: 'Failed',
            color: '#d62728',
          }),
        ],
      }),
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarm Status',
        width: 12,
        alarms: [sfnFailureAlarm, sesBounceAlarm, ...lambdaAlarms],
      }),
    );

    // Row 2: Lambda errors for all functions
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        width: 24,
        left: allFunctions.map(({ fn, label }) =>
          fn.metricErrors({
            period: cdk.Duration.hours(1),
            statistic: 'Sum',
            label,
          }),
        ),
      }),
    );

    // Row 3: Processor p95 duration (Bedrock latency proxy) + SES send metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Processor Duration (p95)',
        width: 12,
        left: [
          processorFn.fn.metricDuration({
            period: cdk.Duration.hours(1),
            statistic: 'p95',
            label: 'Processor p95',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'SES Email Sends',
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Send',
            statistic: 'Sum',
            period: cdk.Duration.hours(24),
            label: 'Sends',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Bounce',
            statistic: 'Sum',
            period: cdk.Duration.hours(24),
            label: 'Bounces',
            color: '#d62728',
          }),
        ],
      }),
    );

    // ── AWS Budget — $20/month cap ─────────────────────────────────────────────
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'ai-security-digest-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: monthlyBudgetUsd, unit: 'USD' },
        costFilters: { TagKeyValue: [`user:Project$ai-security-digest`] },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: 'update-me@example.com' }],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: 'update-me@example.com' }],
        },
      ],
    });

    // ── CloudFormation outputs ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=AI-Security-Digest`,
      description: 'CloudWatch Dashboard URL',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS topic ARN for pipeline alarms — subscribe additional emails via console or CLI',
    });

    new cdk.CfnOutput(this, 'PostDeployObservability', {
      value: [
        `# Confirm the SNS alarm email subscription sent to update-me@example.com`,
        `# Subscribe your real address:`,
        `aws sns subscribe --topic-arn ${alarmTopic.topicArn} --protocol email --notification-endpoint YOUR_EMAIL`,
        `# Tag Lambda functions for cost allocation:`,
        `# aws lambda tag-resource --resource ARN --tags Project=ai-security-digest`,
      ].join('\n'),
      description: 'Post-deployment observability setup steps',
    });

    // ── CDK NAG suppressions ───────────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      alarmTopic,
      [
        {
          id: 'AwsSolutions-SNS2',
          reason: 'SNS topic is encrypted with a customer-managed KMS key (AlarmTopicKey).',
        },
      ],
    );
  }
}
