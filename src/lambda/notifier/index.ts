import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { getJsonFromS3 } from '../shared/s3-client';
import type { DigestPayload } from '../shared/types';
import { buildHtml, buildSubject, buildText } from './template';

// ── Event ──────────────────────────────────────────────────────────────────────

interface NotifierEvent {
  date?: string;
  digestS3Key: string;
}

export interface NotifyResult {
  date: string;
  recipientCount: number;
  articleCount: number;
  messageId: string;
}

// ── AWS clients ────────────────────────────────────────────────────────────────

const ses = new SESClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

// ── Config ─────────────────────────────────────────────────────────────────────

const DIGESTS_BUCKET = process.env.DIGESTS_BUCKET ?? '';
const SSM_SENDER_PARAM = process.env.SSM_SENDER_PARAM ?? '/ai-security-digest/sender';
const SSM_RECIPIENTS_PARAM = process.env.SSM_RECIPIENTS_PARAM ?? '/ai-security-digest/recipients';

// ── SSM helpers ────────────────────────────────────────────────────────────────

async function getSsmValue(name: string): Promise<string> {
  const resp = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = resp.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty or missing`);
  return value;
}

// ── Lambda handler ─────────────────────────────────────────────────────────────

export const handler = async (event: NotifierEvent): Promise<NotifyResult> => {
  const digest = await getJsonFromS3<DigestPayload>(DIGESTS_BUCKET, event.digestS3Key);

  const [senderAddress, recipientsRaw] = await Promise.all([
    getSsmValue(SSM_SENDER_PARAM),
    getSsmValue(SSM_RECIPIENTS_PARAM),
  ]);

  const recipients = recipientsRaw
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  if (recipients.length === 0) {
    throw new Error(`No recipients found in SSM parameter ${SSM_RECIPIENTS_PARAM}`);
  }

  const subject = buildSubject(digest);
  const htmlBody = buildHtml(digest);
  const textBody = buildText(digest);

  const resp = await ses.send(
    new SendEmailCommand({
      Source: senderAddress,
      Destination: { ToAddresses: recipients },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: htmlBody, Charset: 'UTF-8' },
          Text: { Data: textBody, Charset: 'UTF-8' },
        },
      },
    }),
  );

  const messageId = resp.MessageId ?? '';
  const date = (event.date ?? new Date().toISOString()).slice(0, 10);

  console.warn(
    `[notifier] date=${date} recipients=${recipients.length} articles=${digest.totalIncluded} messageId=${messageId}`,
  );

  return {
    date,
    recipientCount: recipients.length,
    articleCount: digest.totalIncluded,
    messageId,
  };
};
