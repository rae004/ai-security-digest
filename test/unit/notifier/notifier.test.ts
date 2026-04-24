import type { DigestPayload } from '../../../src/lambda/shared/types';

// ── Mock AWS SDK clients ───────────────────────────────────────────────────────

const mockSsm = { send: jest.fn() };
const mockSes = { send: jest.fn() };

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => mockSsm),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => mockSes),
  SendEmailCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

// ── Mock shared s3-client ──────────────────────────────────────────────────────

const mockGetJson = jest.fn();
const mockPutJson = jest.fn();

jest.mock('../../../src/lambda/shared/s3-client', () => ({
  getJsonFromS3: (...args: unknown[]): unknown => mockGetJson(...args),
  putJsonToS3: (...args: unknown[]): unknown => mockPutJson(...args),
}));

// ── Set env vars BEFORE the module is imported (module-level constants) ────────

process.env.DIGESTS_BUCKET = 'my-digests-bucket';
process.env.SSM_SENDER_PARAM = '/digest/sender';
process.env.SSM_RECIPIENTS_PARAM = '/digest/recipients';

// ── Import handler after mocks ─────────────────────────────────────────────────

// eslint-disable-next-line import/first
import { handler } from '../../../src/lambda/notifier/index';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SAMPLE_DIGEST: DigestPayload = {
  date: '2026-04-18',
  generatedAt: '2026-04-18T13:00:00.000Z',
  totalScraped: 20,
  totalIncluded: 2,
  articles: [
    {
      id: 'art-1',
      title: 'Critical Bedrock RCE',
      url: 'https://example.com/bedrock-rce',
      source: 'NVD',
      sourceType: 'nvd',
      content: 'Content 1',
      publishedAt: '2026-04-18T06:00:00.000Z',
      scrapedAt: '2026-04-18T12:00:00.000Z',
      summary: 'A critical vulnerability in Bedrock.',
      severity: 'CRITICAL',
      relevance: { category: 'BEDROCK_AGENTCORE', score: 95, reasoning: 'Direct Bedrock impact.' },
      affectedProducts: ['AWS Bedrock'],
    },
    {
      id: 'art-2',
      title: 'LLM Jailbreak Paper',
      url: 'https://arxiv.org/abs/2404.00001',
      source: 'ArXiv',
      sourceType: 'arxiv',
      content: 'Content 2',
      publishedAt: '2026-04-17T18:00:00.000Z',
      scrapedAt: '2026-04-18T12:00:00.000Z',
      summary: 'New jailbreak technique for LLMs.',
      severity: 'HIGH',
      relevance: { category: 'AI_GENERAL', score: 80, reasoning: 'AI security research.' },
      affectedProducts: [],
    },
  ],
};

const DIGEST_S3_KEY = 'digests/2026-04-18/2026-04-18T13-00-00-000Z.json';

// ── Test helpers ───────────────────────────────────────────────────────────────

function setupHappyPath() {
  mockGetJson.mockResolvedValue(SAMPLE_DIGEST);
  // SSM: first call = sender, second = recipients
  mockSsm.send
    .mockResolvedValueOnce({ Parameter: { Value: 'sender@example.com' } })
    .mockResolvedValueOnce({ Parameter: { Value: 'alice@example.com, bob@example.com' } });
  mockSes.send.mockResolvedValue({ MessageId: 'msg-abc123' });
}

// ── Handler tests ──────────────────────────────────────────────────────────────

describe('notifier handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    it('returns correct NotifyResult', async () => {
      setupHappyPath();
      const result = await handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY });
      expect(result.date).toBe('2026-04-18');
      expect(result.recipientCount).toBe(2);
      expect(result.articleCount).toBe(2);
      expect(result.messageId).toBe('msg-abc123');
    });

    it('reads the digest from the correct S3 bucket and key', async () => {
      setupHappyPath();
      await handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY });
      expect(mockGetJson).toHaveBeenCalledWith('my-digests-bucket', DIGEST_S3_KEY);
    });

    it('sends email via SES with sender and recipients from SSM', async () => {
      setupHappyPath();
      await handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY });
      expect(mockSes.send).toHaveBeenCalledTimes(1);
      const [sendCmd] = mockSes.send.mock.calls[0];
      const emailInput = sendCmd.input;
      expect(emailInput.Source).toBe('sender@example.com');
      expect(emailInput.Destination.ToAddresses).toEqual(['alice@example.com', 'bob@example.com']);
    });

    it('derives date from event.date when provided', async () => {
      setupHappyPath();
      const result = await handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY });
      expect(result.date).toBe('2026-04-18');
    });

    it('derives date from current time when event.date is omitted', async () => {
      setupHappyPath();
      const before = new Date().toISOString().slice(0, 10);
      const result = await handler({ digestS3Key: DIGEST_S3_KEY });
      const after = new Date().toISOString().slice(0, 10);
      // date should be today (before or after in case midnight crossover)
      expect([before, after]).toContain(result.date);
    });

    it('trims and filters whitespace-only entries in recipient list', async () => {
      mockGetJson.mockResolvedValue(SAMPLE_DIGEST);
      mockSsm.send
        .mockResolvedValueOnce({ Parameter: { Value: 'sender@example.com' } })
        .mockResolvedValueOnce({ Parameter: { Value: ' alice@example.com ,  , bob@example.com ' } });
      mockSes.send.mockResolvedValue({ MessageId: 'msg-xyz' });

      const result = await handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY });
      expect(result.recipientCount).toBe(2);
    });

    it('returns empty messageId when SES response lacks MessageId', async () => {
      mockGetJson.mockResolvedValue(SAMPLE_DIGEST);
      mockSsm.send
        .mockResolvedValueOnce({ Parameter: { Value: 'sender@example.com' } })
        .mockResolvedValueOnce({ Parameter: { Value: 'alice@example.com' } });
      mockSes.send.mockResolvedValue({});

      const result = await handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY });
      expect(result.messageId).toBe('');
    });
  });

  describe('error paths', () => {
    it('throws when S3 read fails', async () => {
      mockGetJson.mockRejectedValue(new Error('S3 read error'));
      await expect(handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY })).rejects.toThrow('S3 read error');
    });

    it('throws when SSM sender parameter is missing', async () => {
      mockGetJson.mockResolvedValue(SAMPLE_DIGEST);
      mockSsm.send
        .mockResolvedValueOnce({ Parameter: { Value: undefined } })
        .mockResolvedValueOnce({ Parameter: { Value: 'alice@example.com' } });

      await expect(handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY })).rejects.toThrow(
        'SSM parameter',
      );
    });

    it('throws when SSM recipients parameter is empty', async () => {
      mockGetJson.mockResolvedValue(SAMPLE_DIGEST);
      mockSsm.send
        .mockResolvedValueOnce({ Parameter: { Value: 'sender@example.com' } })
        .mockResolvedValueOnce({ Parameter: { Value: '' } });

      await expect(handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY })).rejects.toThrow(
        'SSM parameter',
      );
    });

    it('throws when all recipients are whitespace after trimming', async () => {
      mockGetJson.mockResolvedValue(SAMPLE_DIGEST);
      mockSsm.send
        .mockResolvedValueOnce({ Parameter: { Value: 'sender@example.com' } })
        .mockResolvedValueOnce({ Parameter: { Value: '  ,  ,  ' } });

      await expect(handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY })).rejects.toThrow(
        'No recipients found',
      );
    });

    it('throws when SES send fails', async () => {
      mockGetJson.mockResolvedValue(SAMPLE_DIGEST);
      mockSsm.send
        .mockResolvedValueOnce({ Parameter: { Value: 'sender@example.com' } })
        .mockResolvedValueOnce({ Parameter: { Value: 'alice@example.com' } });
      mockSes.send.mockRejectedValue(new Error('SES throttled'));

      await expect(handler({ date: '2026-04-18', digestS3Key: DIGEST_S3_KEY })).rejects.toThrow('SES throttled');
    });
  });
});
