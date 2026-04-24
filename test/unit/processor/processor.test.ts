// ── Mock Bedrock before importing the module ───────────────────────────────────

const mockBedrockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ input })),
  ThrottlingException: class ThrottlingException extends Error {
    constructor(msg: string) { super(msg); this.name = 'ThrottlingException'; }
  },
}));

// ── Mock shared s3-client ──────────────────────────────────────────────────────

const mockGetJson = jest.fn();
const mockPutJson = jest.fn();

jest.mock('../../../src/lambda/shared/s3-client', () => ({
  getJsonFromS3: (...args: unknown[]): unknown => mockGetJson(...args),
  putJsonToS3: (...args: unknown[]): unknown => mockPutJson(...args),
}));

// ── Mock seen-ids ──────────────────────────────────────────────────────────────

const mockLoadSeenIds = jest.fn();

jest.mock('../../../src/lambda/shared/seen-ids', () => ({
  loadSeenIds: (...args: unknown[]): unknown => mockLoadSeenIds(...args),
}));

// ── Set env vars before module import (module-level constants) ─────────────────
process.env.RAW_ARTICLES_BUCKET = 'raw-bucket';
process.env.PROCESSED_ARTICLES_BUCKET = 'processed-bucket';
process.env.DIGESTS_BUCKET = 'digests-bucket';

// ── Imports ────────────────────────────────────────────────────────────────────

import { deduplicateById, handler } from '../../../src/lambda/processor/index';
import { invokeModel } from '../../../src/lambda/processor/bedrock-client';
import type { AnalyzedArticle, RawArticle } from '../../../src/lambda/shared/types';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeArticle(id: string, title = `Article ${id}`): RawArticle {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    source: 'Test Source',
    sourceType: 'rss',
    content: 'Some content.',
    publishedAt: '2026-04-18T08:00:00.000Z',
    scrapedAt: '2026-04-18T12:00:00.000Z',
  };
}

// ── deduplicateById ────────────────────────────────────────────────────────────

describe('deduplicateById', () => {
  it('returns all articles when all IDs are unique', () => {
    const articles = [makeArticle('a'), makeArticle('b'), makeArticle('c')];
    expect(deduplicateById(articles)).toHaveLength(3);
  });

  it('removes exact duplicate IDs', () => {
    const articles = [makeArticle('a'), makeArticle('a'), makeArticle('b')];
    const result = deduplicateById(articles);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps the first occurrence when duplicated', () => {
    const first = makeArticle('dup', 'First Title');
    const second = makeArticle('dup', 'Second Title');
    const result = deduplicateById([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('First Title');
  });

  it('handles three or more duplicates of the same ID', () => {
    const articles = [makeArticle('x'), makeArticle('x'), makeArticle('x')];
    const result = deduplicateById(articles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('x');
  });

  it('returns an empty array when given an empty array', () => {
    expect(deduplicateById([])).toEqual([]);
  });

  it('preserves insertion order of first occurrences', () => {
    const articles = [
      makeArticle('c'),
      makeArticle('a'),
      makeArticle('b'),
      makeArticle('a'),
      makeArticle('c'),
    ];
    const result = deduplicateById(articles);
    expect(result.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input array', () => {
    const articles = [makeArticle('a'), makeArticle('a')];
    const original = [...articles];
    deduplicateById(articles);
    expect(articles).toHaveLength(original.length);
  });
});

// ── invokeModel (bedrock-client) ───────────────────────────────────────────────

const GOOD_BEDROCK_RESPONSE = {
  output: { message: { content: [{ text: '{"summary":"s","severity":"HIGH","relevance_category":"AI_GENERAL","relevance_score":70,"reasoning":"r","affected_products":[]}' }] } },
};

describe('invokeModel', () => {
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Make setTimeout resolve immediately so throttle back-offs don't slow tests
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('returns text from a successful Bedrock response', async () => {
    mockBedrockSend.mockResolvedValue(GOOD_BEDROCK_RESPONSE);
    const result = await invokeModel('sys', 'user msg');
    expect(result).toContain('"severity":"HIGH"');
  });

  it('throws an Error when Bedrock returns empty content', async () => {
    mockBedrockSend.mockResolvedValue({ output: { message: { content: [{ text: '' }] } } });
    await expect(invokeModel('sys', 'user')).rejects.toThrow('Empty response from Bedrock');
  });

  it('throws when Bedrock returns no output', async () => {
    mockBedrockSend.mockResolvedValue({});
    await expect(invokeModel('sys', 'user')).rejects.toThrow('Empty response from Bedrock');
  });

  it('re-throws non-throttling errors immediately without retry', async () => {
    mockBedrockSend.mockRejectedValue(new Error('AccessDenied'));
    await expect(invokeModel('sys', 'user')).rejects.toThrow('AccessDenied');
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  it('retries on ThrottlingException and succeeds on second attempt', async () => {
    const { ThrottlingException } = jest.requireMock('@aws-sdk/client-bedrock-runtime') as {
      ThrottlingException: new (msg: string) => Error;
    };
    mockBedrockSend
      .mockRejectedValueOnce(new ThrottlingException('throttled'))
      .mockResolvedValueOnce(GOOD_BEDROCK_RESPONSE);

    const result = await invokeModel('sys', 'user');
    expect(result).toContain('"severity":"HIGH"');
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retries on persistent ThrottlingException', async () => {
    const { ThrottlingException } = jest.requireMock('@aws-sdk/client-bedrock-runtime') as {
      ThrottlingException: new (msg: string) => Error;
    };
    mockBedrockSend.mockRejectedValue(new ThrottlingException('always throttled'));

    await expect(invokeModel('sys', 'user')).rejects.toThrow('always throttled');
    expect(mockBedrockSend).toHaveBeenCalledTimes(3);
  });
});

// ── processor handler ─────────────────────────────────────────────────────────

const BEDROCK_ANALYSIS_JSON =
  '{"summary":"Test summary","severity":"HIGH","relevance_category":"AI_GENERAL","relevance_score":75,"reasoning":"Relevant AI security paper.","affected_products":["SomeProduct"]}';

function makeAnalyzedArticle(id: string): AnalyzedArticle {
  return {
    ...makeArticle(id),
    summary: 'Test summary',
    severity: 'HIGH',
    relevance: { category: 'AI_GENERAL', score: 75, reasoning: 'Relevant.' },
    affectedProducts: ['SomeProduct'],
  };
}

describe('processor handler', () => {
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Make setTimeout resolve immediately to avoid real waits in tests
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('returns a ProcessResult with correct articleCount and s3Key prefix', async () => {
    const rawArticles = [makeArticle('a'), makeArticle('b')];
    mockGetJson.mockResolvedValue(rawArticles);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockBedrockSend.mockResolvedValue({
      output: { message: { content: [{ text: BEDROCK_ANALYSIS_JSON }] } },
    });
    mockPutJson.mockResolvedValue(undefined);

    const promise = handler({ date: '2026-04-18', rawS3Keys: ['raw/2026-04-18/nvd/file.json'] });
    // The handler pauses 1s between batches of 5 — only 2 articles so no pause needed
    const result = await promise;

    expect(result.articleCount).toBe(2);
    expect(result.s3Key).toMatch(/^processed\/2026-04-18\//);
  });

  it('writes processed articles to the PROCESSED_ARTICLES_BUCKET', async () => {
    mockGetJson.mockResolvedValue([makeArticle('x')]);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockBedrockSend.mockResolvedValue({
      output: { message: { content: [{ text: BEDROCK_ANALYSIS_JSON }] } },
    });
    mockPutJson.mockResolvedValue(undefined);

    await handler({ date: '2026-04-18', rawS3Keys: ['raw/key.json'] });

    expect(mockPutJson).toHaveBeenCalledWith(
      'processed-bucket',
      expect.stringMatching(/^processed\/2026-04-18\//),
      expect.any(Array),
    );
  });

  it('skips empty rawS3Keys entries', async () => {
    mockGetJson.mockResolvedValue([]);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', rawS3Keys: ['', ''] });
    expect(result.articleCount).toBe(0);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('filters out articles already in seenIds', async () => {
    mockGetJson.mockResolvedValue([makeArticle('seen-id'), makeArticle('new-id')]);
    mockLoadSeenIds.mockResolvedValue(new Set<string>(['seen-id']));
    mockBedrockSend.mockResolvedValue({
      output: { message: { content: [{ text: BEDROCK_ANALYSIS_JSON }] } },
    });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', rawS3Keys: ['raw/key.json'] });
    // Only 'new-id' should be analyzed
    expect(result.articleCount).toBe(1);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  it('deduplicates raw articles before processing', async () => {
    // Two keys both returning the same article id
    mockGetJson
      .mockResolvedValueOnce([makeArticle('dup-id')])
      .mockResolvedValueOnce([makeArticle('dup-id')]);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockBedrockSend.mockResolvedValue({
      output: { message: { content: [{ text: BEDROCK_ANALYSIS_JSON }] } },
    });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', rawS3Keys: ['key1.json', 'key2.json'] });
    expect(result.articleCount).toBe(1);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  it('processes multiple batches (>5 articles) with inter-batch delay', async () => {
    // 6 articles → two batches; setTimeout is spied to resolve immediately
    const sixArticles = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => makeArticle(id));
    mockGetJson.mockResolvedValue(sixArticles);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockBedrockSend.mockResolvedValue({
      output: { message: { content: [{ text: BEDROCK_ANALYSIS_JSON }] } },
    });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', rawS3Keys: ['raw/key.json'] });

    expect(result.articleCount).toBe(6);
    expect(mockBedrockSend).toHaveBeenCalledTimes(6);
  });

  it('derives date from current time when event.date is omitted', async () => {
    mockGetJson.mockResolvedValue([]);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ rawS3Keys: [] });
    const today = new Date().toISOString().slice(0, 10);
    expect(result.s3Key).toContain(today);
  });
});
