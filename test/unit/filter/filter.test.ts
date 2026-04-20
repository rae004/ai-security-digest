import {
  filterAndSort,
  INCLUDE_THRESHOLD,
  loadSeenIds,
  saveSeenIds,
  SEVERITY_RANK,
  shouldInclude,
  sortArticles,
} from '../../../src/lambda/filter/index';
import type { AnalyzedArticle } from '../../../src/lambda/shared/types';

// ── Fixture builder ────────────────────────────────────────────────────────────

let idCounter = 0;
function makeArticle(
  overrides: Partial<AnalyzedArticle> & {
    severity: AnalyzedArticle['severity'];
    category: AnalyzedArticle['relevance']['category'];
    score?: number;
  },
): AnalyzedArticle {
  const { severity, category, score = 50, ...rest } = overrides;
  idCounter++;
  return {
    id: `article-${idCounter}`,
    title: `Article ${idCounter}`,
    url: `https://example.com/${idCounter}`,
    source: 'Test',
    sourceType: 'rss',
    content: 'Test content',
    publishedAt: '2026-04-18T08:00:00.000Z',
    scrapedAt: '2026-04-18T12:00:00.000Z',
    summary: 'Test summary',
    severity,
    relevance: { category, score, reasoning: 'test' },
    affectedProducts: [],
    ...rest,
  };
}

// ── SEVERITY_RANK ──────────────────────────────────────────────────────────────

describe('SEVERITY_RANK', () => {
  it('CRITICAL > HIGH > MEDIUM > LOW > INFO', () => {
    expect(SEVERITY_RANK.CRITICAL).toBeGreaterThan(SEVERITY_RANK.HIGH);
    expect(SEVERITY_RANK.HIGH).toBeGreaterThan(SEVERITY_RANK.MEDIUM);
    expect(SEVERITY_RANK.MEDIUM).toBeGreaterThan(SEVERITY_RANK.LOW);
    expect(SEVERITY_RANK.LOW).toBeGreaterThan(SEVERITY_RANK.INFO);
  });
});

// ── shouldInclude ──────────────────────────────────────────────────────────────

describe('shouldInclude — BEDROCK_AGENTCORE', () => {
  it('includes at INFO (always include)', () => {
    expect(shouldInclude(makeArticle({ severity: 'INFO', category: 'BEDROCK_AGENTCORE' }))).toBe(true);
  });
  it('includes at LOW', () => {
    expect(shouldInclude(makeArticle({ severity: 'LOW', category: 'BEDROCK_AGENTCORE' }))).toBe(true);
  });
  it('includes at CRITICAL', () => {
    expect(shouldInclude(makeArticle({ severity: 'CRITICAL', category: 'BEDROCK_AGENTCORE' }))).toBe(true);
  });
});

describe('shouldInclude — AI_GENERAL', () => {
  it('includes at MEDIUM', () => {
    expect(shouldInclude(makeArticle({ severity: 'MEDIUM', category: 'AI_GENERAL' }))).toBe(true);
  });
  it('includes at HIGH', () => {
    expect(shouldInclude(makeArticle({ severity: 'HIGH', category: 'AI_GENERAL' }))).toBe(true);
  });
  it('includes at CRITICAL', () => {
    expect(shouldInclude(makeArticle({ severity: 'CRITICAL', category: 'AI_GENERAL' }))).toBe(true);
  });
  it('excludes at LOW', () => {
    expect(shouldInclude(makeArticle({ severity: 'LOW', category: 'AI_GENERAL' }))).toBe(false);
  });
  it('excludes at INFO', () => {
    expect(shouldInclude(makeArticle({ severity: 'INFO', category: 'AI_GENERAL' }))).toBe(false);
  });
});

describe('shouldInclude — AWS_SECURITY', () => {
  it('includes at HIGH', () => {
    expect(shouldInclude(makeArticle({ severity: 'HIGH', category: 'AWS_SECURITY' }))).toBe(true);
  });
  it('includes at CRITICAL', () => {
    expect(shouldInclude(makeArticle({ severity: 'CRITICAL', category: 'AWS_SECURITY' }))).toBe(true);
  });
  it('excludes at MEDIUM', () => {
    expect(shouldInclude(makeArticle({ severity: 'MEDIUM', category: 'AWS_SECURITY' }))).toBe(false);
  });
  it('excludes at LOW', () => {
    expect(shouldInclude(makeArticle({ severity: 'LOW', category: 'AWS_SECURITY' }))).toBe(false);
  });
  it('excludes at INFO', () => {
    expect(shouldInclude(makeArticle({ severity: 'INFO', category: 'AWS_SECURITY' }))).toBe(false);
  });
});

describe('shouldInclude — OTHER', () => {
  it('includes at CRITICAL', () => {
    expect(shouldInclude(makeArticle({ severity: 'CRITICAL', category: 'OTHER' }))).toBe(true);
  });
  it('excludes at HIGH', () => {
    expect(shouldInclude(makeArticle({ severity: 'HIGH', category: 'OTHER' }))).toBe(false);
  });
  it('excludes at MEDIUM', () => {
    expect(shouldInclude(makeArticle({ severity: 'MEDIUM', category: 'OTHER' }))).toBe(false);
  });
});

// ── sortArticles ───────────────────────────────────────────────────────────────

describe('sortArticles', () => {
  it('sorts by severity descending', () => {
    const articles = [
      makeArticle({ severity: 'LOW', category: 'BEDROCK_AGENTCORE' }),
      makeArticle({ severity: 'CRITICAL', category: 'BEDROCK_AGENTCORE' }),
      makeArticle({ severity: 'HIGH', category: 'BEDROCK_AGENTCORE' }),
    ];
    const sorted = sortArticles(articles);
    expect(sorted[0].severity).toBe('CRITICAL');
    expect(sorted[1].severity).toBe('HIGH');
    expect(sorted[2].severity).toBe('LOW');
  });

  it('breaks severity ties by relevance score descending', () => {
    const articles = [
      makeArticle({ severity: 'HIGH', category: 'AI_GENERAL', score: 40 }),
      makeArticle({ severity: 'HIGH', category: 'AI_GENERAL', score: 90 }),
      makeArticle({ severity: 'HIGH', category: 'AI_GENERAL', score: 60 }),
    ];
    const sorted = sortArticles(articles);
    expect(sorted[0].relevance.score).toBe(90);
    expect(sorted[1].relevance.score).toBe(60);
    expect(sorted[2].relevance.score).toBe(40);
  });

  it('does not mutate the input array', () => {
    const articles = [
      makeArticle({ severity: 'LOW', category: 'BEDROCK_AGENTCORE' }),
      makeArticle({ severity: 'CRITICAL', category: 'BEDROCK_AGENTCORE' }),
    ];
    const originalFirst = articles[0].id;
    sortArticles(articles);
    expect(articles[0].id).toBe(originalFirst); // original unchanged
  });
});

// ── filterAndSort ──────────────────────────────────────────────────────────────

describe('filterAndSort', () => {
  it('returns correct included count and excluded count', () => {
    const articles = [
      makeArticle({ severity: 'CRITICAL', category: 'BEDROCK_AGENTCORE' }), // in
      makeArticle({ severity: 'HIGH', category: 'AI_GENERAL' }),             // in
      makeArticle({ severity: 'LOW', category: 'AI_GENERAL' }),              // out
      makeArticle({ severity: 'MEDIUM', category: 'AWS_SECURITY' }),         // out
      makeArticle({ severity: 'CRITICAL', category: 'OTHER' }),              // in
    ];
    const result = filterAndSort(articles);
    expect(result.included).toHaveLength(3);
    expect(result.excluded).toBe(2);
  });

  it('included articles are sorted CRITICAL first', () => {
    const articles = [
      makeArticle({ severity: 'HIGH', category: 'AI_GENERAL', score: 80 }),
      makeArticle({ severity: 'CRITICAL', category: 'BEDROCK_AGENTCORE', score: 30 }),
    ];
    const { included } = filterAndSort(articles);
    expect(included[0].severity).toBe('CRITICAL');
  });

  it('returns empty included and 0 excluded for empty input', () => {
    const result = filterAndSort([]);
    expect(result.included).toHaveLength(0);
    expect(result.excluded).toBe(0);
  });

  it('INCLUDE_THRESHOLD values are consistent with shouldInclude behaviour', () => {
    // Verify that the threshold constants agree with the boundary tests above
    expect(INCLUDE_THRESHOLD.BEDROCK_AGENTCORE).toBe(SEVERITY_RANK.INFO);
    expect(INCLUDE_THRESHOLD.AI_GENERAL).toBe(SEVERITY_RANK.MEDIUM);
    expect(INCLUDE_THRESHOLD.AWS_SECURITY).toBe(SEVERITY_RANK.HIGH);
    expect(INCLUDE_THRESHOLD.OTHER).toBe(SEVERITY_RANK.CRITICAL);
  });
});

// ── loadSeenIds / saveSeenIds ──────────────────────────────────────────────────

const mockGetJson = jest.fn();
const mockPutJson = jest.fn();

jest.mock('../../../src/lambda/shared/s3-client', () => ({
  getJsonFromS3: (...args: unknown[]): unknown => mockGetJson(...args),
  putJsonToS3: (...args: unknown[]): unknown => mockPutJson(...args),
}));

describe('loadSeenIds', () => {
  beforeEach(() => {
    mockGetJson.mockReset();
    mockPutJson.mockReset();
  });

  it('returns an empty set when no sent-ids files exist', async () => {
    mockGetJson.mockRejectedValue(new Error('NoSuchKey'));
    const result = await loadSeenIds('my-bucket', '2026-04-19', 3);
    expect(result.size).toBe(0);
  });

  it('loads IDs from existing sent-ids files', async () => {
    mockGetJson
      .mockResolvedValueOnce(['id-a', 'id-b'])  // day -1
      .mockRejectedValueOnce(new Error('NoSuchKey')) // day -2 missing
      .mockResolvedValueOnce(['id-c']);              // day -3
    const result = await loadSeenIds('my-bucket', '2026-04-19', 3);
    expect(result.has('id-a')).toBe(true);
    expect(result.has('id-b')).toBe(true);
    expect(result.has('id-c')).toBe(true);
    expect(result.size).toBe(3);
  });

  it('reads files for the correct lookback dates', async () => {
    mockGetJson.mockRejectedValue(new Error('NoSuchKey'));
    await loadSeenIds('my-bucket', '2026-04-19', 2);
    expect(mockGetJson).toHaveBeenCalledWith('my-bucket', 'sent-ids/2026-04-18.json');
    expect(mockGetJson).toHaveBeenCalledWith('my-bucket', 'sent-ids/2026-04-17.json');
    expect(mockGetJson).toHaveBeenCalledTimes(2);
  });

  it('does not read the current date (only previous days)', async () => {
    mockGetJson.mockRejectedValue(new Error('NoSuchKey'));
    await loadSeenIds('my-bucket', '2026-04-19', 1);
    expect(mockGetJson).not.toHaveBeenCalledWith('my-bucket', 'sent-ids/2026-04-19.json');
  });

  it('deduplicates IDs that appear in multiple days', async () => {
    mockGetJson
      .mockResolvedValueOnce(['id-a', 'id-b'])
      .mockResolvedValueOnce(['id-b', 'id-c']);
    const result = await loadSeenIds('my-bucket', '2026-04-19', 2);
    expect(result.size).toBe(3);
  });
});

describe('saveSeenIds', () => {
  beforeEach(() => {
    mockPutJson.mockReset();
  });

  it('writes IDs to the correct S3 key', async () => {
    mockPutJson.mockResolvedValue(undefined);
    await saveSeenIds('my-bucket', '2026-04-19', ['id-a', 'id-b']);
    expect(mockPutJson).toHaveBeenCalledWith(
      'my-bucket',
      'sent-ids/2026-04-19.json',
      ['id-a', 'id-b'],
    );
  });

  it('writes an empty array without throwing', async () => {
    mockPutJson.mockResolvedValue(undefined);
    await expect(saveSeenIds('my-bucket', '2026-04-19', [])).resolves.not.toThrow();
  });
});
