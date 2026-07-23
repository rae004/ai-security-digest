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
import { capArticles, parseCvssScore, preFilterNvd } from '../../../src/lambda/processor/pre-filter';
import { parseAnalysis } from '../../../src/lambda/processor/prompt';
import type { RawArticle } from '../../../src/lambda/shared/types';

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

function makeNvdArticle(id: string, cvss: number | null, description = 'A buffer overflow.'): RawArticle {
  return {
    ...makeArticle(id, `CVE-2026-${id}`),
    sourceType: 'nvd',
    source: 'NVD',
    content: cvss === null ? description : `CVSS ${cvss} (HIGH). ${description}`,
  };
}

// Builds a valid batch response covering article indexes 1..n
function batchResponseJson(n: number): string {
  const entries = Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    summary: 'Test summary',
    severity: 'HIGH',
    relevance_category: 'AI_GENERAL',
    relevance_score: 75,
    reasoning: 'Relevant AI security paper.',
    affected_products: ['SomeProduct'],
  }));
  return JSON.stringify(entries);
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
  output: { message: { content: [{ text: '[{"index":1,"summary":"s","severity":"HIGH","relevance_category":"AI_GENERAL","relevance_score":70,"reasoning":"r","affected_products":[]}]' }] } },
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

// Covers any batch of up to 10 articles — extra indexes are ignored by the parser
const BEDROCK_ANALYSIS_JSON = batchResponseJson(10);


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

  it('drops irrelevant sub-critical NVD CVEs before Bedrock', async () => {
    mockGetJson.mockResolvedValue([
      makeArticle('rss-article'),
      makeNvdArticle('kernel', 7.8, 'Linux kernel use-after-free.'),
      makeNvdArticle('sagemaker', 7.8, 'Flaw in Amazon SageMaker notebook instances.'),
      makeNvdArticle('critical', 9.8, 'Router firmware backdoor.'),
    ]);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockBedrockSend.mockResolvedValue({
      output: { message: { content: [{ text: BEDROCK_ANALYSIS_JSON }] } },
    });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', rawS3Keys: ['raw/key.json'] });
    // 'kernel' is dropped: NVD, sub-critical, no relevance keywords
    expect(result.articleCount).toBe(3);
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

  it('batches multiple articles into a single Bedrock call', async () => {
    // 6 articles fit in one batch of 10 → exactly one Bedrock invocation
    const sixArticles = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => makeArticle(id));
    mockGetJson.mockResolvedValue(sixArticles);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockBedrockSend.mockResolvedValue({
      output: { message: { content: [{ text: BEDROCK_ANALYSIS_JSON }] } },
    });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', rawS3Keys: ['raw/key.json'] });

    expect(result.articleCount).toBe(6);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  it('splits more than BATCH_SIZE articles across multiple Bedrock calls', async () => {
    // 12 articles → two batches of 10 and 2
    const articles = Array.from({ length: 12 }, (_, i) => makeArticle(`a${i}`));
    mockGetJson.mockResolvedValue(articles);
    mockLoadSeenIds.mockResolvedValue(new Set<string>());
    mockBedrockSend.mockResolvedValue({
      output: { message: { content: [{ text: BEDROCK_ANALYSIS_JSON }] } },
    });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', rawS3Keys: ['raw/key.json'] });

    expect(result.articleCount).toBe(12);
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
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

// ── pre-filter ─────────────────────────────────────────────────────────────────

describe('parseCvssScore', () => {
  it('parses the CVSS prefix from NVD content', () => {
    expect(parseCvssScore(makeNvdArticle('a', 8.8))).toBe(8.8);
  });

  it('returns null when content has no CVSS prefix', () => {
    expect(parseCvssScore(makeNvdArticle('a', null))).toBeNull();
    expect(parseCvssScore(makeArticle('rss'))).toBeNull();
  });
});

describe('preFilterNvd', () => {
  it('always keeps non-NVD articles', () => {
    const { kept, droppedCount } = preFilterNvd([makeArticle('a'), makeArticle('b')]);
    expect(kept).toHaveLength(2);
    expect(droppedCount).toBe(0);
  });

  it('keeps NVD articles matching a relevance keyword', () => {
    const article = makeNvdArticle('sm', 7.5, 'Privilege escalation in Amazon SageMaker.');
    expect(preFilterNvd([article]).kept).toHaveLength(1);
  });

  it('keeps NVD articles with CVSS >= 9.0 regardless of keywords', () => {
    const article = makeNvdArticle('crit', 9.1, 'Router firmware backdoor.');
    expect(preFilterNvd([article]).kept).toHaveLength(1);
  });

  it('drops sub-critical NVD articles with no relevance keywords', () => {
    const article = makeNvdArticle('kernel', 7.8, 'Linux kernel use-after-free.');
    const { kept, droppedCount } = preFilterNvd([article]);
    expect(kept).toHaveLength(0);
    expect(droppedCount).toBe(1);
  });

  it('does not match keywords inside larger words', () => {
    // "maintainer" contains "ai" but must not match as a keyword
    const article = makeNvdArticle('x', 7.0, 'Patch released by the maintainer of libfoo.');
    expect(preFilterNvd([article]).kept).toHaveLength(0);
  });
});

describe('capArticles', () => {
  it('returns articles unchanged when under the cap', () => {
    const articles = [makeArticle('a'), makeNvdArticle('b', 7.0)];
    expect(capArticles(articles, 500)).toEqual(articles);
  });

  it('keeps curated sources and the highest-CVSS NVD articles when over the cap', () => {
    const articles = [
      makeNvdArticle('low', 7.1),
      makeArticle('rss'),
      makeNvdArticle('high', 9.8),
      makeNvdArticle('mid', 8.5),
    ];
    const capped = capArticles(articles, 3);
    expect(capped.map((a) => a.id)).toEqual(['rss', 'high', 'mid']);
  });

  it('treats NVD articles without a CVSS prefix as lowest priority', () => {
    const articles = [makeNvdArticle('no-cvss', null), makeNvdArticle('scored', 7.0)];
    const capped = capArticles(articles, 1);
    expect(capped[0].id).toBe('scored');
  });
});

// ── parseAnalysis (batch join) ─────────────────────────────────────────────────

describe('parseAnalysis', () => {
  const articles = [makeArticle('a'), makeArticle('b')];

  it('joins response entries to articles by echoed index', () => {
    const response = JSON.stringify([
      { index: 2, summary: 'second', severity: 'HIGH', relevance_category: 'AI_GENERAL', relevance_score: 80, reasoning: 'r', affected_products: [] },
      { index: 1, summary: 'first', severity: 'LOW', relevance_category: 'OTHER', relevance_score: 10, reasoning: 'r', affected_products: [] },
    ]);
    const result = parseAnalysis(articles, response);
    expect(result[0].summary).toBe('first');
    expect(result[1].summary).toBe('second');
  });

  it('falls back for articles missing from the response', () => {
    const response = JSON.stringify([
      { index: 1, summary: 'only one', severity: 'HIGH', relevance_category: 'AI_GENERAL', relevance_score: 80, reasoning: 'r', affected_products: [] },
    ]);
    const result = parseAnalysis(articles, response);
    expect(result[0].summary).toBe('only one');
    expect(result[1].severity).toBe('INFO');
    expect(result[1].relevance.reasoning).toContain('No analysis returned');
  });

  it('falls back for every article on unparseable JSON', () => {
    const result = parseAnalysis(articles, 'not json at all');
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.severity === 'INFO')).toBe(true);
  });

  it('strips markdown code fences before parsing', () => {
    const response = '```json\n' + JSON.stringify([
      { index: 1, summary: 's', severity: 'HIGH', relevance_category: 'AI_GENERAL', relevance_score: 80, reasoning: 'r', affected_products: [] },
    ]) + '\n```';
    const result = parseAnalysis([makeArticle('a')], response);
    expect(result[0].severity).toBe('HIGH');
  });
});
