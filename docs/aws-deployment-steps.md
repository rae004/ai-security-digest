# AWS Deployment Steps

Phased deployment guide for the AI Security Digest pipeline using AWS CDK.

---

## Phase 1 — AWS SSO Login

The project uses the AWS SSO default profile. Log in before any AWS commands:

```bash
aws sso login
```

Verify the correct account is active:

```bash
aws sts get-caller-identity
# Confirm: Account, UserId, Arn are what you expect
```

---

## Phase 2 — CDK Bootstrap

One-time setup per account/region. Provisions the CDK toolkit S3 bucket and IAM roles that CloudFormation needs:

```bash
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/YOUR_REGION
```

> Skip if you've deployed CDK stacks to this account before — run `aws cloudformation describe-stacks --stack-name CDKToolkit` to check.

---

## Phase 3 — Verify SES Identity

The notifier Lambda sends email from an address you own. SES requires that address (or its domain) to be verified **before mail will flow**.

**Option A — Verify a single email address** (simpler, no DNS needed):

```bash
aws ses verify-email-identity --email-address no-reply@YOUR_DOMAIN --region YOUR_REGION
# AWS sends a confirmation link — click it
```

**Option B — Verify an entire domain via Route 53** (recommended for production):

**Step 1 — Request verification and get the token:**

```bash
aws ses verify-domain-identity --domain YOUR_DOMAIN --region YOUR_REGION --no-cli-pager
# Returns: { "VerificationToken": "xxxx..." }
```

**Step 2 — Get your Route 53 Hosted Zone ID:**

```bash
aws route53 list-hosted-zones --no-cli-pager \
  --query "HostedZones[?Name=='YOUR_DOMAIN.'].Id" \
  --output text
# Returns: /hostedzone/Z1234ABCDEF — use just the ID part
```

**Step 3 — Add the TXT verification record:**

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id YOUR_ZONE_ID \
  --no-cli-pager \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "_amazonses.YOUR_DOMAIN",
        "Type": "TXT",
        "TTL": 300,
        "ResourceRecords": [{"Value": "\"YOUR_VERIFICATION_TOKEN\""}]
      }
    }]
  }'
```

> Note the extra quotes inside the JSON — Route 53 requires TXT values to be wrapped in `\"...\"`

**Step 4 — Poll until verified** (usually a few minutes):

```bash
aws ses get-identity-verification-attributes \
  --identities YOUR_DOMAIN \
  --region YOUR_REGION \
  --no-cli-pager
# Wait for: "VerificationStatus": "Success"
```

**Step 5 — Set up DKIM** (improves deliverability, prevents spam folder):

```bash
aws ses verify-domain-dkim --domain YOUR_DOMAIN --region YOUR_REGION --no-cli-pager
# Returns 3 CNAME tokens — add each one to Route 53:
```

Add all 3 CNAME records in a single call — replace `TOKEN_1`, `TOKEN_2`, `TOKEN_3` with the values returned above:

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id YOUR_ZONE_ID \
  --no-cli-pager \
  --change-batch '{
    "Changes": [
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "TOKEN_1._domainkey.YOUR_DOMAIN",
          "Type": "CNAME",
          "TTL": 300,
          "ResourceRecords": [{"Value": "TOKEN_1.dkim.amazonses.com"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "TOKEN_2._domainkey.YOUR_DOMAIN",
          "Type": "CNAME",
          "TTL": 300,
          "ResourceRecords": [{"Value": "TOKEN_2.dkim.amazonses.com"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "TOKEN_3._domainkey.YOUR_DOMAIN",
          "Type": "CNAME",
          "TTL": 300,
          "ResourceRecords": [{"Value": "TOKEN_3.dkim.amazonses.com"}]
        }
      }
    ]
  }'
```

**SES Sandbox check** — new accounts can only send *to* verified addresses. To send to arbitrary recipients, request production access:

```bash
# Check current sending limits
aws ses get-send-quota --region YOUR_REGION --no-cli-pager

# If SendMaxRate is 1.0 you're in sandbox — request production:
# Console → SES → Account dashboard → "Request production access"
```

---

## Phase 4 — CDK Synth (dry run)

Validate the full app synthesizes cleanly before touching AWS:

```bash
npx cdk synth --all
```

CDK NAG runs during synth — any unresolved violations appear as errors here. You should see 6 stacks output to `cdk.out/` with no errors.

---

## Phase 5 — Deploy All Stacks

CDK resolves the `addDependency` order automatically:

```bash
npx cdk deploy --all --require-approval never
```

> Remove `--require-approval never` if you want to review IAM changes interactively before each stack deploys.

Expected deploy order (CDK enforces this):

1. `AiSecurityDigestStorageStack`
2. `AiSecurityDigestIngestionStack`
3. `AiSecurityDigestProcessorStack`
4. `AiSecurityDigestOrchestrationStack`
5. `AiSecurityDigestObservabilityStack`
6. `AiSecurityDigestSchedulerStack`

Total deploy time: ~5–10 minutes (Lambda bundling is the slow part).

---

## Phase 6 — Post-Deploy Configuration

Once stacks are up, the CfnOutputs guide you. Run these in order:

**1. Set SES sender address in SSM:**

```bash
aws ssm put-parameter \
  --name /ai-security-digest/sender \
  --value "no-reply@YOUR_DOMAIN" \
  --overwrite \
  --region YOUR_REGION
```

**2. Set recipient list in SSM** (comma-separated):

```bash
aws ssm put-parameter \
  --name /ai-security-digest/recipients \
  --value "you@example.com,colleague@example.com" \
  --overwrite \
  --region YOUR_REGION
```

**3. Subscribe your real email to the SNS alarm topic** (get the ARN from the `AlarmTopicArn` stack output):

```bash
TOPIC_ARN=$(aws cloudformation describe-stacks \
  --stack-name AiSecurityDigestObservabilityStack \
  --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" \
  --output text --region YOUR_REGION)

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint you@example.com \
  --region YOUR_REGION
# Click the confirmation email AWS sends
```

**4. Tag Lambda functions for Budget cost allocation:**

```bash
aws lambda list-functions --region YOUR_REGION --no-cli-pager --query "Functions[?starts_with(FunctionName, 'AiSecurityDigest')].FunctionArn" --output text | tr '\t' '\n' | xargs -I {} aws lambda tag-resource --resource {} --tags Project=ai-security-digest --region YOUR_REGION
```

This lists all deployed `AiSecurityDigest*` Lambda ARNs and tags each one in a single pipeline.

---

## Phase 7 — Smoke Test

Manually trigger the pipeline to verify the full end-to-end flow before waiting for the daily schedule:

```bash
# Get the state machine ARN
SFN_ARN=$(aws cloudformation describe-stacks \
  --stack-name AiSecurityDigestOrchestrationStack \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" \
  --output text --region YOUR_REGION)

# Start an execution
aws stepfunctions start-execution \
  --state-machine-arn "$SFN_ARN" \
  --region YOUR_REGION
```

Watch it run:

```bash
# List recent executions
aws stepfunctions list-executions \
  --state-machine-arn "$SFN_ARN" \
  --region YOUR_REGION \
  --max-results 1
```

A successful run delivers an email digest and writes a JSON file to the `digests/` S3 bucket. Confirm it:

```bash
DIGESTS_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name AiSecurityDigestStorageStack \
  --query "Stacks[0].Outputs[?OutputKey=='DigestsBucketName'].OutputValue" \
  --output text --region YOUR_REGION)

aws s3 ls "s3://$DIGESTS_BUCKET/digests/" --region YOUR_REGION
```

You can also open the CloudWatch Dashboard — its URL is in the `DashboardUrl` output of `AiSecurityDigestObservabilityStack`.

---

## Summary

| Phase | When | Required |
|---|---|---|
| 1 — SSO Login | Every session | Yes |
| 2 — CDK Bootstrap | Once per account | Yes |
| 3 — SES Verification | Before first deploy | Yes |
| 4 — CDK Synth | Before each deploy | Recommended |
| 5 — CDK Deploy | Initial + each change | Yes |
| 6 — Post-deploy config | After first deploy | Yes |
| 7 — Smoke test | After first deploy | Strongly recommended |
