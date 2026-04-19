import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { BundlingOptions, NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface OrchestrationStackProps extends cdk.StackProps {
  processedArticlesBucket: s3.IBucket;
  digestsBucket: s3.IBucket;
  // Scraper + processor functions from upstream stacks
  rssScraperFn: lambda.IFunction;
  nvdScraperFn: lambda.IFunction;
  arxivScraperFn: lambda.IFunction;
  xScraperFn: lambda.IFunction;
  processorFn: lambda.IFunction;
}

const SSM_SENDER_PARAM = '/ai-security-digest/sender';
const SSM_RECIPIENTS_PARAM = '/ai-security-digest/recipients';

export class OrchestrationStack extends cdk.Stack {
  public readonly stateMachine: sfn.IStateMachine;
  public readonly filterFn: lambda.IFunction;
  public readonly notifierFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    const {
      processedArticlesBucket,
      digestsBucket,
      rssScraperFn,
      nvdScraperFn,
      arxivScraperFn,
      xScraperFn,
      processorFn,
    } = props;

    const bundling: BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
      target: 'node22',
      minify: true,
      sourceMap: false,
    };

    // ── SSM parameters (created with placeholders — update post-deployment) ─────
    const senderParam = new ssm.StringParameter(this, 'SenderParam', {
      parameterName: SSM_SENDER_PARAM,
      description: 'Verified SES sender address for the daily digest email',
      stringValue: 'update-me@example.com',
    });

    const recipientsParam = new ssm.StringParameter(this, 'RecipientsParam', {
      parameterName: SSM_RECIPIENTS_PARAM,
      description: 'Comma-separated recipient email addresses for the daily digest',
      stringValue: 'update-me@example.com',
    });

    // ── Filter Lambda ──────────────────────────────────────────────────────────
    const filterFn = new NodejsFunction(this, 'FilterFunction', {
      description: 'Filters and sorts analyzed articles into a DigestPayload written to S3',
      entry: path.join(__dirname, '../../src/lambda/filter/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        PROCESSED_ARTICLES_BUCKET: processedArticlesBucket.bucketName,
        DIGESTS_BUCKET: digestsBucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling,
    });

    this.filterFn = filterFn;
    processedArticlesBucket.grantRead(filterFn);
    digestsBucket.grantPut(filterFn);

    // ── Notifier Lambda ────────────────────────────────────────────────────────
    const notifierFn = new NodejsFunction(this, 'NotifierFunction', {
      description: 'Reads DigestPayload from S3 and sends the daily email via SES',
      entry: path.join(__dirname, '../../src/lambda/notifier/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        DIGESTS_BUCKET: digestsBucket.bucketName,
        SSM_SENDER_PARAM,
        SSM_RECIPIENTS_PARAM,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling,
    });

    this.notifierFn = notifierFn;
    digestsBucket.grantRead(notifierFn);

    // SES: scoped to account identities — specific identity set via SSM post-deploy
    notifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SesSendEmail',
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [`arn:aws:ses:us-east-1:${this.account}:identity/*`],
      }),
    );

    // SSM: scoped to the exact two parameter paths
    notifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SsmGetDigestParams',
        actions: ['ssm:GetParameter'],
        resources: [
          senderParam.parameterArn,
          recipientsParam.parameterArn,
        ],
      }),
    );

    // ── Step Functions task definitions ────────────────────────────────────────
    const scraperPayload = sfn.TaskInput.fromObject({
      'date.$': '$$.Execution.StartTime',
    });

    const scraperResultSelector = {
      's3Key.$': '$.Payload.s3Key',
      'sourceType.$': '$.Payload.sourceType',
      'articleCount.$': '$.Payload.articleCount',
    };

    const rssTask = new tasks.LambdaInvoke(this, 'RssScraper', {
      lambdaFunction: rssScraperFn,
      comment: 'Scrape enabled RSS/Atom feeds',
      payload: scraperPayload,
      resultSelector: scraperResultSelector,
    });

    const nvdTask = new tasks.LambdaInvoke(this, 'NvdScraper', {
      lambdaFunction: nvdScraperFn,
      comment: 'Scrape NVD API v2 for recent CVEs',
      payload: scraperPayload,
      resultSelector: scraperResultSelector,
    });

    const arxivTask = new tasks.LambdaInvoke(this, 'ArxivScraper', {
      lambdaFunction: arxivScraperFn,
      comment: 'Scrape ArXiv for recent AI/security papers',
      payload: scraperPayload,
      resultSelector: scraperResultSelector,
    });

    const xTask = new tasks.LambdaInvoke(this, 'XScraper', {
      lambdaFunction: xScraperFn,
      comment: 'X scraper stub — returns 0 articles when disabled',
      payload: scraperPayload,
      resultSelector: scraperResultSelector,
    });

    // ── Parallel scrape ────────────────────────────────────────────────────────
    const scrapeParallel = new sfn.Parallel(this, 'ScrapeSources', {
      comment: 'Fan-out: scrape all sources concurrently',
    })
      .branch(rssTask)
      .branch(nvdTask)
      .branch(arxivTask)
      .branch(xTask);

    // ── Collect raw S3 keys → ProcessorEvent ──────────────────────────────────
    const collectKeys = new sfn.Pass(this, 'CollectRawKeys', {
      comment: 'Reshape parallel output into ProcessorEvent',
      parameters: {
        'date.$':
          "States.ArrayGetItem(States.StringSplit($$.Execution.StartTime, 'T'), 0)",
        'rawS3Keys.$':
          'States.Array($[0].s3Key, $[1].s3Key, $[2].s3Key, $[3].s3Key)',
      },
    });

    // ── Process ────────────────────────────────────────────────────────────────
    const processTask = new tasks.LambdaInvoke(this, 'ProcessArticles', {
      lambdaFunction: processorFn,
      comment: 'Invoke Bedrock Claude to triage and summarize raw articles',
      resultSelector: {
        's3Key.$': '$.Payload.s3Key',
        'articleCount.$': '$.Payload.articleCount',
      },
    });

    // ── Reshape → FilterEvent ──────────────────────────────────────────────────
    const prepareFilter = new sfn.Pass(this, 'PrepareFilterInput', {
      comment: 'Reshape ProcessResult into FilterEvent',
      parameters: {
        'date.$':
          "States.ArrayGetItem(States.StringSplit($$.Execution.StartTime, 'T'), 0)",
        'processedS3Key.$': '$.s3Key',
      },
    });

    // ── Filter ─────────────────────────────────────────────────────────────────
    const filterTask = new tasks.LambdaInvoke(this, 'FilterArticles', {
      lambdaFunction: filterFn,
      comment: 'Filter, sort, and write DigestPayload to S3',
      resultSelector: {
        's3Key.$': '$.Payload.s3Key',
        'included.$': '$.Payload.included',
        'excluded.$': '$.Payload.excluded',
      },
    });

    // ── Reshape → NotifierEvent ────────────────────────────────────────────────
    const prepareNotifier = new sfn.Pass(this, 'PrepareNotifierInput', {
      comment: 'Reshape FilterResult into NotifierEvent',
      parameters: {
        'date.$':
          "States.ArrayGetItem(States.StringSplit($$.Execution.StartTime, 'T'), 0)",
        'digestS3Key.$': '$.s3Key',
      },
    });

    // ── Notify ─────────────────────────────────────────────────────────────────
    const notifyTask = new tasks.LambdaInvoke(this, 'SendDigestEmail', {
      lambdaFunction: notifierFn,
      comment: 'Send daily digest email via SES',
      resultSelector: {
        'messageId.$': '$.Payload.messageId',
        'recipientCount.$': '$.Payload.recipientCount',
        'articleCount.$': '$.Payload.articleCount',
      },
    });

    // ── State machine definition ───────────────────────────────────────────────
    const definition = scrapeParallel
      .next(collectKeys)
      .next(processTask)
      .next(prepareFilter)
      .next(filterTask)
      .next(prepareNotifier)
      .next(notifyTask);

    const sfnLogGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stateMachine = new sfn.StateMachine(this, 'DigestPipeline', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.EXPRESS,
      timeout: cdk.Duration.minutes(30),
      tracingEnabled: true,
      logs: {
        destination: sfnLogGroup,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });

    this.stateMachine = stateMachine;

    // ── CloudFormation outputs ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'AI Security Digest pipeline state machine ARN',
      exportName: 'AiSecurityDigest-StateMachineArn',
    });

    new cdk.CfnOutput(this, 'FilterFunctionName', {
      value: filterFn.functionName,
      description: 'Filter Lambda function name',
    });

    new cdk.CfnOutput(this, 'NotifierFunctionName', {
      value: notifierFn.functionName,
      description: 'Notifier Lambda function name',
    });

    new cdk.CfnOutput(this, 'PostDeploySteps', {
      value: [
        `aws ssm put-parameter --name ${SSM_SENDER_PARAM} --value "YOUR_VERIFIED_SES_ADDRESS" --overwrite`,
        `aws ssm put-parameter --name ${SSM_RECIPIENTS_PARAM} --value "r1@example.com,r2@example.com" --overwrite`,
      ].join(' && '),
      description: 'Run these commands after verifying your SES identity to activate email delivery',
    });

    // ── CDK NAG suppressions ───────────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      filterFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 GetObject/PutObject grants require a key-prefix wildcard; access is scoped to specific named buckets.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      notifierFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'SES identity wildcard is required since the verified sender address is configured post-deployment via SSM.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      stateMachine,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Step Functions execution role uses lambda:InvokeFunction on specific function ARNs; the :* suffix for qualified versions is a CDK default.',
        },
        {
          id: 'AwsSolutions-SF2',
          reason: 'X-Ray tracing is enabled on this state machine (tracingEnabled: true).',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(sfnLogGroup, [
      {
        id: 'AwsSolutions-CW3',
        reason:
          'Step Functions execution logs are operational data, not sensitive; KMS encryption is not required for this log group.',
      },
    ]);
  }
}
