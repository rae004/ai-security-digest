import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { StorageStack } from '../../lib/stacks/storage-stack';

describe('StorageStack', () => {
  let app: cdk.App;
  let stack: StorageStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    stack = new StorageStack(app, 'TestStorageStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    template = Template.fromStack(stack);
    app.synth();
  });

  // ── CDK NAG ──────────────────────────────────────────────────────────────────

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

  // ── Bucket count ──────────────────────────────────────────────────────────────

  test('creates 5 S3 buckets', () => {
    template.resourceCountIs('AWS::S3::Bucket', 5);
  });

  // ── Encryption ────────────────────────────────────────────────────────────────

  test('KMS key has rotation enabled', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('data buckets use KMS encryption', () => {
    // 4 data buckets should have SSE-KMS (access logs bucket uses AES256)
    template.resourcePropertiesCountIs(
      'AWS::S3::Bucket',
      {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
              },
            },
          ],
        },
      },
      4,
    );
  });

  // ── Versioning ────────────────────────────────────────────────────────────────

  test('config, processed, and digests buckets have versioning enabled', () => {
    template.resourcePropertiesCountIs(
      'AWS::S3::Bucket',
      {
        VersioningConfiguration: { Status: 'Enabled' },
      },
      4, // config, raw, processed, digests
    );
  });

  // ── Lifecycle rules ───────────────────────────────────────────────────────────

  test('raw articles bucket has 7-day lifecycle expiration', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('ai-security-digest-raw-.*'),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ ExpirationInDays: 7, Status: 'Enabled' }),
        ]),
      },
    });
  });

  test('processed articles bucket has 30-day lifecycle expiration', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('ai-security-digest-processed-.*'),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' }),
        ]),
      },
    });
  });

  test('digests bucket has 90-day lifecycle expiration', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('ai-security-digest-digests-.*'),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ ExpirationInDays: 90, Status: 'Enabled' }),
        ]),
      },
    });
  });

  // ── SSL enforcement ───────────────────────────────────────────────────────────

  test('all buckets enforce SSL via bucket policy', () => {
    // enforceSSL: true creates a bucket policy denying non-SSL requests
    template.resourceCountIs('AWS::S3::BucketPolicy', 5);
  });

  // ── CloudFormation outputs ────────────────────────────────────────────────────

  test('exports all 4 bucket names', () => {
    template.hasOutput('ConfigBucketName', {});
    template.hasOutput('RawArticlesBucketName', {});
    template.hasOutput('ProcessedArticlesBucketName', {});
    template.hasOutput('DigestsBucketName', {});
  });
});
