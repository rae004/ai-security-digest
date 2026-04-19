import { createHash } from 'crypto';

import { parseNvdResponse } from '../../../src/lambda/scrapers/nvd/index';
import type { NvdResponse } from '../../../src/lambda/scrapers/nvd/index';

const SCRAPED_AT = '2026-04-18T12:00:00.000Z';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NVD_RESPONSE: NvdResponse = {
  totalResults: 2,
  startIndex: 0,
  resultsPerPage: 2000,
  vulnerabilities: [
    {
      cve: {
        id: 'CVE-2026-12345',
        published: '2026-04-18T06:00:00.000',
        lastModified: '2026-04-18T10:00:00.000',
        descriptions: [
          { lang: 'en', value: 'A critical RCE vulnerability in ExampleLib before 2.3.1.' },
          { lang: 'es', value: 'Una vulnerabilidad critica.' },
        ],
        references: [{ url: 'https://example.com/advisory' }],
        metrics: {
          cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: 'CRITICAL' } }],
        },
      },
    },
    {
      cve: {
        id: 'CVE-2026-54321',
        published: '2026-04-17T20:00:00.000',
        lastModified: '2026-04-18T08:00:00.000',
        descriptions: [{ lang: 'en', value: 'A medium severity XSS vulnerability.' }],
        references: [],
      },
    },
  ],
};

const EMPTY_RESPONSE: NvdResponse = {
  totalResults: 0,
  startIndex: 0,
  resultsPerPage: 2000,
  vulnerabilities: [],
};

// ── parseNvdResponse ───────────────────────────────────────────────────────────

describe('parseNvdResponse', () => {
  const articles = parseNvdResponse(NVD_RESPONSE, SCRAPED_AT);

  it('returns one article per vulnerability', () => {
    expect(articles).toHaveLength(2);
  });

  it('sets title to CVE ID', () => {
    expect(articles[0].title).toBe('CVE-2026-12345');
  });

  it('builds NVD detail URL correctly', () => {
    expect(articles[0].url).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-12345');
  });

  it('uses English description as content', () => {
    expect(articles[0].content).toBe('A critical RCE vulnerability in ExampleLib before 2.3.1.');
  });

  it('sets sourceType to nvd', () => {
    expect(articles[0].sourceType).toBe('nvd');
    expect(articles[1].sourceType).toBe('nvd');
  });

  it('sets source to NVD', () => {
    expect(articles[0].source).toBe('NVD');
  });

  it('parses publishedAt from NVD date string', () => {
    // NVD returns dates without timezone — treated as UTC by Date constructor
    expect(articles[0].publishedAt).toBe('2026-04-18T06:00:00.000Z');
  });

  it('sets scrapedAt correctly', () => {
    expect(articles[0].scrapedAt).toBe(SCRAPED_AT);
  });

  it('generates id as sha256 of the NVD URL', () => {
    const url = 'https://nvd.nist.gov/vuln/detail/CVE-2026-12345';
    const expected = createHash('sha256').update(url).digest('hex');
    expect(articles[0].id).toBe(expected);
  });

  it('two CVEs get different ids', () => {
    expect(articles[0].id).not.toBe(articles[1].id);
  });

  it('returns empty array for zero vulnerabilities', () => {
    expect(parseNvdResponse(EMPTY_RESPONSE, SCRAPED_AT)).toHaveLength(0);
  });

  it('handles CVE with no description gracefully', () => {
    const response: NvdResponse = {
      ...EMPTY_RESPONSE,
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2026-99999',
            published: '2026-04-18T00:00:00.000',
            lastModified: '2026-04-18T00:00:00.000',
            descriptions: [],
            references: [],
          },
        },
      ],
    };
    const result = parseNvdResponse(response, SCRAPED_AT);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('');
  });
});
