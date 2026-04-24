import { createHash } from 'crypto';

// ── Mock s3-client before importing handler ────────────────────────────────────

const mockGetJson = jest.fn();
const mockPutJson = jest.fn();

jest.mock('../../../src/lambda/shared/s3-client', () => ({
  getJsonFromS3: (...args: unknown[]): unknown => mockGetJson(...args),
  putJsonToS3: (...args: unknown[]): unknown => mockPutJson(...args),
}));

// ── Set env vars before module import (module-level constants) ─────────────────
process.env.CONFIG_BUCKET = 'config-bucket';
process.env.RAW_ARTICLES_BUCKET = 'raw-bucket';

import { handler, parseArxivXml } from '../../../src/lambda/scrapers/arxiv/index';
import type { SourcesConfig } from '../../../src/lambda/shared/types';

const SCRAPED_AT = '2026-04-18T12:00:00.000Z';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ARXIV_SINGLE_ENTRY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2404.01234v1</id>
    <title>Adversarial Attacks on Large Language Models: A Survey</title>
    <summary>We survey adversarial attacks against LLMs, covering jailbreaks and prompt injection.</summary>
    <published>2026-04-17T18:00:00Z</published>
    <updated>2026-04-18T10:00:00Z</updated>
    <author><name>Alice Researcher</name></author>
    <link rel="alternate" type="text/html" href="https://arxiv.org/abs/2404.01234v1"/>
    <link rel="related" type="application/pdf" href="https://arxiv.org/pdf/2404.01234v1"/>
  </entry>
</feed>`;

const ARXIV_MULTI_ENTRY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2404.00001v2</id>
    <title>Security of Bedrock Models</title>
    <summary>First paper summary.</summary>
    <published>2026-04-18T08:00:00Z</published>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2404.00002v1</id>
    <title>Backdoor Attacks on Transformers</title>
    <summary>Second paper summary.</summary>
    <published>2026-04-17T12:00:00Z</published>
  </entry>
</feed>`;

const ARXIV_EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults>
</feed>`;

// ── parseArxivXml ──────────────────────────────────────────────────────────────

describe('parseArxivXml', () => {
  describe('single entry', () => {
    const articles = parseArxivXml(ARXIV_SINGLE_ENTRY, SCRAPED_AT);

    it('returns one article', () => {
      expect(articles).toHaveLength(1);
    });

    it('sets correct title', () => {
      expect(articles[0].title).toBe(
        'Adversarial Attacks on Large Language Models: A Survey',
      );
    });

    it('normalises URL: strips version suffix and upgrades to https', () => {
      expect(articles[0].url).toBe('https://arxiv.org/abs/2404.01234');
    });

    it('uses summary as content', () => {
      expect(articles[0].content).toBe(
        'We survey adversarial attacks against LLMs, covering jailbreaks and prompt injection.',
      );
    });

    it('sets sourceType to arxiv', () => {
      expect(articles[0].sourceType).toBe('arxiv');
    });

    it('sets source to ArXiv', () => {
      expect(articles[0].source).toBe('ArXiv');
    });

    it('uses <published> for publishedAt', () => {
      expect(articles[0].publishedAt).toBe('2026-04-17T18:00:00.000Z');
    });

    it('generates id as sha256 of normalised URL', () => {
      const url = 'https://arxiv.org/abs/2404.01234';
      const expected = createHash('sha256').update(url).digest('hex');
      expect(articles[0].id).toBe(expected);
    });

    it('sets scrapedAt correctly', () => {
      expect(articles[0].scrapedAt).toBe(SCRAPED_AT);
    });
  });

  describe('multiple entries', () => {
    const articles = parseArxivXml(ARXIV_MULTI_ENTRY, SCRAPED_AT);

    it('returns all entries', () => {
      expect(articles).toHaveLength(2);
    });

    it('each article has a unique id', () => {
      expect(articles[0].id).not.toBe(articles[1].id);
    });

    it('strips version from second entry URL', () => {
      expect(articles[1].url).toBe('https://arxiv.org/abs/2404.00002');
    });
  });

  describe('empty feed', () => {
    it('returns empty array when there are no entries', () => {
      const articles = parseArxivXml(ARXIV_EMPTY_FEED, SCRAPED_AT);
      expect(articles).toHaveLength(0);
    });
  });
});

// ── ArXiv handler ─────────────────────────────────────────────────────────────

const SOURCES_ENABLED: SourcesConfig = {
  rss: [],
  apis: [{ name: 'ArXiv', type: 'arxiv', enabled: true }],
  social: [],
};

const SOURCES_DISABLED: SourcesConfig = {
  rss: [],
  apis: [{ name: 'ArXiv', type: 'arxiv', enabled: false }],
  social: [],
};

// A minimal valid ArXiv Atom feed with one entry published recently enough to pass the cutoff
function makeArxivFeedXml(publishedIso: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2404.99999v1</id>
    <title>AI Security Test Paper</title>
    <summary>Abstract text here.</summary>
    <published>${publishedIso}</published>
  </entry>
</feed>`;
}

describe('ArXiv handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('returns disabled result when ArXiv source is disabled', async () => {
    mockGetJson.mockResolvedValue(SOURCES_DISABLED);
    const result = await handler({ date: '2026-04-18' });
    expect(result.sourceType).toBe('arxiv');
    expect(result.s3Key).toBe('');
    expect(result.articleCount).toBe(0);
    expect(result.errors[0]).toMatch(/disabled/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches ArXiv feed, filters by cutoff and writes to S3', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    // Published 10 hours ago — well within 48h lookback
    const recentPublished = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const xml = makeArxivFeedXml(recentPublished);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => xml });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', lookbackHours: 48 });
    expect(result.sourceType).toBe('arxiv');
    expect(result.articleCount).toBe(1);
    expect(result.s3Key).toMatch(/^raw\/2026-04-18\/arxiv\//);
    expect(result.errors).toHaveLength(0);
    expect(mockPutJson).toHaveBeenCalledWith('raw-bucket', result.s3Key, expect.any(Array));
  });

  it('filters out articles older than the lookback window', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    // Published 72 hours ago — outside 48h lookback
    const oldPublished = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const xml = makeArxivFeedXml(oldPublished);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => xml });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', lookbackHours: 48 });
    expect(result.articleCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('captures ArXiv API errors without throwing', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/ArXiv.*Network error/);
    expect(result.articleCount).toBe(0);
  });

  it('captures non-ok HTTP responses as errors', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503 });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/ArXiv API HTTP 503/);
  });

  it('uses event.date for the S3 key', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => ARXIV_EMPTY_FEED });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-01-20' });
    expect(result.s3Key).toMatch(/^raw\/2026-01-20\/arxiv\//);
  });
});
