import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export class StorageStack extends cdk.Stack {
  public readonly configBucket: s3.IBucket;
  public readonly rawArticlesBucket: s3.IBucket;
  public readonly processedArticlesBucket: s3.IBucket;
  public readonly digestsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── KMS key — shared encryption for all data buckets ─────────────────────
    const bucketKey = new kms.Key(this, 'BucketKey', {
      description: 'ai-security-digest: S3 encryption key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Access logs bucket ────────────────────────────────────────────────────
    // Receives access logs from all other buckets. Uses S3-managed encryption
    // (log delivery service does not support SSE-KMS for target buckets).
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `ai-security-digest-access-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S1: This IS the access log destination — self-logging is not supported by S3.
    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'This bucket is the server access log destination. S3 does not support logging a log-delivery bucket to itself.',
      },
    ]);

    // ── Config bucket — sources.json lives here ───────────────────────────────
    // Seeded on deploy via BucketDeployment (Phase 2). Retained on stack destroy
    // so that manual edits to sources.json are never lost.
    this.configBucket = new s3.Bucket(this, 'ConfigBucket', {
      bucketName: `ai-security-digest-config-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: bucketKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'config/',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Raw articles bucket (7-day lifecycle) ─────────────────────────────────
    // Scrapers write raw JSON here. Objects expire automatically after 7 days.
    this.rawArticlesBucket = new s3.Bucket(this, 'RawArticlesBucket', {
      bucketName: `ai-security-digest-raw-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: bucketKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'raw/',
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Processed articles bucket (30-day lifecycle) ──────────────────────────
    // Bedrock-analyzed articles. Objects expire automatically after 30 days.
    this.processedArticlesBucket = new s3.Bucket(this, 'ProcessedArticlesBucket', {
      bucketName: `ai-security-digest-processed-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: bucketKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'processed/',
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Digests bucket (90-day lifecycle) ─────────────────────────────────────
    // Final formatted digest payloads. Retained as a permanent audit trail.
    this.digestsBucket = new s3.Bucket(this, 'DigestsBucket', {
      bucketName: `ai-security-digest-digests-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: bucketKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'digests/',
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── CloudFormation outputs ────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: this.configBucket.bucketName,
      description: 'S3 bucket for sources.json configuration',
      exportName: 'AiSecurityDigest-ConfigBucketName',
    });

    new cdk.CfnOutput(this, 'RawArticlesBucketName', {
      value: this.rawArticlesBucket.bucketName,
      description: 'S3 bucket for raw scraped articles',
      exportName: 'AiSecurityDigest-RawArticlesBucketName',
    });

    new cdk.CfnOutput(this, 'ProcessedArticlesBucketName', {
      value: this.processedArticlesBucket.bucketName,
      description: 'S3 bucket for Bedrock-analyzed articles',
      exportName: 'AiSecurityDigest-ProcessedArticlesBucketName',
    });

    new cdk.CfnOutput(this, 'DigestsBucketName', {
      value: this.digestsBucket.bucketName,
      description: 'S3 bucket for daily digest payloads',
      exportName: 'AiSecurityDigest-DigestsBucketName',
    });
  }
}
