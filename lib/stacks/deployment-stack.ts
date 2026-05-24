import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface DeploymentStackProps extends cdk.StackProps {
  /**
   * GitHub Environment name that GitHub Actions will run under. The IAM trust
   * policy locks AssumeRoleWithWebIdentity to this exact environment, so the
   * role can only be assumed by workflows that opt into it.
   */
  readonly envName: string;

  /**
   * GitHub repository in `owner/name` form. Used as part of the OIDC trust
   * subject claim.
   */
  readonly githubRepo: string;

  /**
   * Whether to create the GitHub OIDC provider. Default `false` — the provider
   * is an account-level singleton, and in most accounts it already exists
   * (provisioned by another stack or by hand). Set to `true` only when
   * bootstrapping the first GitHub-trusted role in a fresh account.
   */
  readonly createOidcProvider?: boolean;
}

/**
 * Provisions the GitHub OIDC trust + the IAM role that GitHub Actions assumes
 * to run `cdk deploy` against this account.
 *
 * The role does NOT carry app permissions directly — it only has permission to
 * assume the four CDK bootstrap roles (`cdk-hnb659fds-*`) which already hold
 * the powerful CFN / S3 / ECR rights. This keeps the GitHub-trusted role's
 * blast radius minimal: compromise it and the worst you can do is run CFN
 * stack updates the bootstrap policies already allow.
 */
export class DeploymentStack extends cdk.Stack {
  public readonly githubDeployRole: iam.Role;

  constructor(scope: Construct, id: string, props: DeploymentStackProps) {
    super(scope, id, props);

    const { envName, githubRepo, createOidcProvider = false } = props;

    // Account-level singleton. CreateOidcProvider=true only when this account
    // has never trusted GitHub Actions before; otherwise import the existing
    // provider so we don't conflict with whoever provisioned it first.
    const githubOidcProvider = createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidcProvider',
          `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
        );

    this.githubDeployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: `github-deploy-${envName}`,
      description: `Assumed by GitHub Actions to run cdk deploy for ${envName}`,
      assumedBy: new iam.FederatedPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:environment:${envName}`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // CDK bootstrap roles this account/region was bootstrapped with. Names are
    // deterministic for the default `hnb659fds` qualifier.
    const bootstrapRoleArns = [
      `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
      `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
      `arn:aws:iam::${this.account}:role/cdk-hnb659fds-image-publishing-role-${this.account}-${this.region}`,
      `arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-${this.region}`,
    ];

    this.githubDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: bootstrapRoleArns,
      }),
    );

    // CDK CLI reads this on every deploy to verify the bootstrap version
    // matches what the synthesized template expects.
    this.githubDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadBootstrapVersion',
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/hnb659fds/version`,
        ],
      }),
    );

    // cdk-nag: IAM5 fires on the AssumeRole statement because it lists four
    // resource ARNs. They are all specific (no wildcards) and intentionally
    // narrowed to the CDK bootstrap roles, so the finding is acceptable.
    NagSuppressions.addResourceSuppressions(
      this.githubDeployRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AssumeRole is intentionally scoped to the four CDK bootstrap role ARNs for this account/region. No wildcards on resources.',
        },
      ],
      true,
    );

    new cdk.CfnOutput(this, 'GithubDeployRoleArn', {
      value: this.githubDeployRole.roleArn,
      description: 'Set this as the AWS_DEPLOY_ROLE_ARN secret on the prod GitHub Environment',
      exportName: 'AiSecurityDigest-GithubDeployRoleArn',
    });

    new cdk.CfnOutput(this, 'GithubOidcProviderArn', {
      value: githubOidcProvider.openIdConnectProviderArn,
      description: 'Account-level GitHub OIDC provider ARN',
      exportName: 'AiSecurityDigest-GithubOidcProviderArn',
    });
  }
}
