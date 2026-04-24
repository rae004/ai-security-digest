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

import { handler, parseRssXml, sha256Hex, stripHtml } from '../../../src/lambda/scrapers/rss/index';
import type { SourcesConfig } from '../../../src/lambda/shared/types';

const SCRAPED_AT = '2026-04-18T12:00:00.000Z';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const RSS2_XML = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>CVE-2024-1234: Critical RCE in Example Library</title>
      <link>https://example.com/cve-2024-1234</link>
      <description>&lt;p&gt;A critical remote code execution vulnerability.&lt;/p&gt;</description>
      <pubDate>Fri, 18 Apr 2026 08:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Another Article</title>
      <link>https://example.com/another</link>
      <description>Plain text description</description>
      <pubDate>Thu, 17 Apr 2026 10:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test Feed</title>
  <entry>
    <title>AI Security Research</title>
    <link rel="alternate" type="text/html" href="https://example.com/ai-security"/>
    <summary>&lt;b&gt;Summary text&lt;/b&gt; with HTML</summary>
    <published>2026-04-18T09:00:00Z</published>
  </entry>
  <entry>
    <title>Second Entry</title>
    <link href="https://example.com/second"/>
    <summary>Second summary</summary>
    <updated>2026-04-17T15:00:00Z</updated>
  </entry>
</feed>`;

const ATOM_NO_ALTERNATE_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Entry With No Alternate Link</title>
    <link rel="related" href="https://example.com/related"/>
    <summary>Should be skipped</summary>
    <published>2026-04-18T09:00:00Z</published>
  </entry>
</feed>`;

// ── sha256Hex ──────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  it('produces a 64-char hex string', () => {
    expect(sha256Hex('https://example.com')).toHaveLength(64);
    expect(sha256Hex('https://example.com')).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    expect(sha256Hex('https://example.com')).toBe(sha256Hex('https://example.com'));
  });

  it('matches Node crypto createHash output', () => {
    const url = 'https://example.com/test';
    const expected = createHash('sha256').update(url).digest('hex');
    expect(sha256Hex(url)).toBe(expected);
  });
});

// ── stripHtml ─────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes HTML tags and collapses surrounding whitespace', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('decodes &amp; and leaves decoded angle brackets as-is', () => {
    // Entity decoding runs after tag stripping, so decoded < > are not re-stripped
    expect(stripHtml('AT&amp;T &lt;test&gt;')).toBe('AT&T <test>');
  });

  it('collapses multiple whitespace characters to a single space', () => {
    expect(stripHtml('  a   b  ')).toBe('a b');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

// ── parseRssXml — RSS 2.0 ──────────────────────────────────────────────────────

describe('parseRssXml (RSS 2.0)', () => {
  const articles = parseRssXml(RSS2_XML, 'Test Feed', SCRAPED_AT);

  it('returns one article per item', () => {
    expect(articles).toHaveLength(2);
  });

  it('sets correct sourceType and source', () => {
    expect(articles[0].sourceType).toBe('rss');
    expect(articles[0].source).toBe('Test Feed');
  });

  it('strips HTML from title and content', () => {
    expect(articles[0].title).toBe('CVE-2024-1234: Critical RCE in Example Library');
    expect(articles[0].content).toBe('A critical remote code execution vulnerability.');
  });

  it('sets url from <link>', () => {
    expect(articles[0].url).toBe('https://example.com/cve-2024-1234');
  });

  it('generates id as sha256 of url', () => {
    const expected = createHash('sha256').update(articles[0].url).digest('hex');
    expect(articles[0].id).toBe(expected);
  });

  it('parses pubDate to ISO 8601', () => {
    expect(articles[0].publishedAt).toBe('2026-04-18T08:00:00.000Z');
  });

  it('sets scrapedAt correctly', () => {
    expect(articles[0].scrapedAt).toBe(SCRAPED_AT);
  });
});

// ── parseRssXml — Atom ─────────────────────────────────────────────────────────

describe('parseRssXml (Atom)', () => {
  const articles = parseRssXml(ATOM_XML, 'Atom Feed', SCRAPED_AT);

  it('returns one article per entry', () => {
    expect(articles).toHaveLength(2);
  });

  it('extracts href from <link rel="alternate">', () => {
    expect(articles[0].url).toBe('https://example.com/ai-security');
  });

  it('extracts href from <link> without rel attribute', () => {
    expect(articles[1].url).toBe('https://example.com/second');
  });

  it('strips HTML from summary', () => {
    expect(articles[0].content).toBe('Summary text with HTML');
  });

  it('uses <published> for publishedAt', () => {
    expect(articles[0].publishedAt).toBe('2026-04-18T09:00:00.000Z');
  });

  it('falls back to <updated> when no <published>', () => {
    expect(articles[1].publishedAt).toBe('2026-04-17T15:00:00.000Z');
  });
});

// ── parseRssXml — edge cases ───────────────────────────────────────────────────

describe('parseRssXml (edge cases)', () => {
  it('skips Atom entries with only rel="related" links', () => {
    const articles = parseRssXml(ATOM_NO_ALTERNATE_XML, 'Feed', SCRAPED_AT);
    expect(articles).toHaveLength(0);
  });

  it('returns empty array for unrecognised XML structure', () => {
    const articles = parseRssXml('<unknown><data/></unknown>', 'Feed', SCRAPED_AT);
    expect(articles).toHaveLength(0);
  });

  it('two items with different URLs get different ids', () => {
    const articles = parseRssXml(RSS2_XML, 'Test Feed', SCRAPED_AT);
    expect(articles[0].id).not.toBe(articles[1].id);
  });
});

// ── RSS handler ────────────────────────────────────────────────────────────────

// A minimal RSS 2.0 feed with one item published recently enough to pass the cutoff
function makeRss2Xml(pubDate: string): string {
  return `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Security Blog</title>
    <item>
      <title>Handler Test Article</title>
      <link>https://blog.example.com/handler-test</link>
      <description>Handler test description.</description>
      <pubDate>${pubDate}</pubDate>
    </item>
  </channel>
</rss>`;
}

const SOURCES_ONE_ENABLED: SourcesConfig = {
  rss: [{ name: 'Security Blog', url: 'https://blog.example.com/feed', enabled: true }],
  apis: [],
  social: [],
};

const SOURCES_ALL_DISABLED: SourcesConfig = {
  rss: [{ name: 'Security Blog', url: 'https://blog.example.com/feed', enabled: false }],
  apis: [],
  social: [],
};

const SOURCES_TWO_ENABLED: SourcesConfig = {
  rss: [
    { name: 'Blog A', url: 'https://blog-a.example.com/feed', enabled: true },
    { name: 'Blog B', url: 'https://blog-b.example.com/feed', enabled: true },
  ],
  apis: [],
  social: [],
};

describe('RSS handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('processes zero sources when all rss sources are disabled', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ALL_DISABLED);
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18' });
    expect(result.sourceType).toBe('rss');
    expect(result.articleCount).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches enabled sources, filters by cutoff and writes to S3', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ONE_ENABLED);
    const recentDate = new Date(Date.now() - 10 * 60 * 60 * 1000).toUTCString();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => makeRss2Xml(recentDate),
    });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', lookbackHours: 48 });
    expect(result.sourceType).toBe('rss');
    expect(result.articleCount).toBe(1);
    expect(result.s3Key).toMatch(/^raw\/2026-04-18\/rss\//);
    expect(result.errors).toHaveLength(0);
    expect(mockPutJson).toHaveBeenCalledWith('raw-bucket', result.s3Key, expect.any(Array));
  });

  it('filters out articles older than the lookback window', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ONE_ENABLED);
    const oldDate = new Date(Date.now() - 72 * 60 * 60 * 1000).toUTCString();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => makeRss2Xml(oldDate),
    });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', lookbackHours: 48 });
    expect(result.articleCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('captures per-source errors without throwing', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ONE_ENABLED);
    (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Security Blog.*ECONNREFUSED/);
    expect(result.articleCount).toBe(0);
  });

  it('captures non-ok HTTP responses as errors', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ONE_ENABLED);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Security Blog.*HTTP 404/);
  });

  it('aggregates articles from multiple enabled sources', async () => {
    mockGetJson.mockResolvedValue(SOURCES_TWO_ENABLED);
    const recentDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toUTCString();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, text: async () => makeRss2Xml(recentDate) })
      .mockResolvedValueOnce({ ok: true, text: async () => makeRss2Xml(recentDate) });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', lookbackHours: 48 });
    // Each source contributes 1 article — but they share the same URL so sha256 IDs match.
    // The handler does NOT deduplicate — it just appends. Both items have same URL so same id.
    expect(result.articleCount).toBe(2);
  });

  it('uses event.date for the S3 key', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ONE_ENABLED);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => '<rss/>' });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-03-10' });
    expect(result.s3Key).toMatch(/^raw\/2026-03-10\/rss\//);
  });
});
