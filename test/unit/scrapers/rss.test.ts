import { createHash } from 'crypto';

import { parseRssXml, sha256Hex, stripHtml } from '../../../src/lambda/scrapers/rss/index';

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
