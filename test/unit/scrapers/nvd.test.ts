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
process.env.NVD_API_KEY = 'test-api-key';

import { handler, parseNvdResponse } from '../../../src/lambda/scrapers/nvd/index';
import type { NvdResponse } from '../../../src/lambda/scrapers/nvd/index';
import type { SourcesConfig } from '../../../src/lambda/shared/types';

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
        descriptions: [{ lang: 'en', value: 'A high severity SQL injection vulnerability.' }],
        references: [],
        metrics: {
          cvssMetricV30: [{ cvssData: { baseScore: 7.5, baseSeverity: 'HIGH' } }],
        },
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

  it('prepends CVSS score and severity to content for CVEs with a v3.1 score', () => {
    expect(articles[0].content).toBe(
      'CVSS 9.8 (CRITICAL). A critical RCE vulnerability in ExampleLib before 2.3.1.',
    );
  });

  it('prepends CVSS score and severity to content for CVEs with a v3.0 score', () => {
    expect(articles[1].content).toBe(
      'CVSS 7.5 (HIGH). A high severity SQL injection vulnerability.',
    );
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

  it('uses raw description as content when no CVSS score is present', () => {
    const response: NvdResponse = {
      ...EMPTY_RESPONSE,
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2026-99999',
            published: '2026-04-18T00:00:00.000',
            lastModified: '2026-04-18T00:00:00.000',
            descriptions: [{ lang: 'en', value: 'Newly published, not yet scored.' }],
            references: [],
          },
        },
      ],
    };
    const result = parseNvdResponse(response, SCRAPED_AT);
    expect(result[0].content).toBe('Newly published, not yet scored.');
  });

  it('handles CVE with no description gracefully', () => {
    const response: NvdResponse = {
      ...EMPTY_RESPONSE,
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2026-88888',
            published: '2026-04-18T00:00:00.000',
            lastModified: '2026-04-18T00:00:00.000',
            descriptions: [],
            references: [],
            metrics: {
              cvssMetricV31: [{ cvssData: { baseScore: 8.1, baseSeverity: 'HIGH' } }],
            },
          },
        },
      ],
    };
    const result = parseNvdResponse(response, SCRAPED_AT);
    expect(result[0].content).toBe('CVSS 8.1 (HIGH). ');
  });
});

// ── NVD handler ────────────────────────────────────────────────────────────────

const SOURCES_ENABLED: SourcesConfig = {
  rss: [],
  apis: [{ name: 'NVD', type: 'nvd', enabled: true }],
  social: [],
};

const SOURCES_DISABLED: SourcesConfig = {
  rss: [],
  apis: [{ name: 'NVD', type: 'nvd', enabled: false }],
  social: [],
};

const PAGE_RESPONSE: NvdResponse = {
  totalResults: 1,
  startIndex: 0,
  resultsPerPage: 2000,
  vulnerabilities: [
    {
      cve: {
        id: 'CVE-2026-11111',
        published: '2026-04-18T10:00:00.000',
        lastModified: '2026-04-18T10:00:00.000',
        descriptions: [{ lang: 'en', value: 'Test HIGH CVE.' }],
        references: [],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 8.5, baseSeverity: 'HIGH' } }] },
      },
    },
  ],
};

const EMPTY_PAGE_RESPONSE: NvdResponse = {
  totalResults: 0,
  startIndex: 0,
  resultsPerPage: 2000,
  vulnerabilities: [],
};

describe('NVD handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('returns disabled result when NVD source is disabled', async () => {
    mockGetJson.mockResolvedValue(SOURCES_DISABLED);
    const result = await handler({ date: '2026-04-18' });
    expect(result.sourceType).toBe('nvd');
    expect(result.s3Key).toBe('');
    expect(result.articleCount).toBe(0);
    expect(result.errors[0]).toMatch(/disabled/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches HIGH and CRITICAL tiers and writes to S3', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    // Two severity tiers: HIGH returns 1 article, CRITICAL returns 0
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => PAGE_RESPONSE })       // HIGH
      .mockResolvedValueOnce({ ok: true, json: async () => EMPTY_PAGE_RESPONSE }); // CRITICAL
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18' });
    expect(result.sourceType).toBe('nvd');
    expect(result.articleCount).toBe(1);
    expect(result.s3Key).toMatch(/^raw\/2026-04-18\/nvd\//);
    expect(result.errors).toHaveLength(0);
    expect(mockPutJson).toHaveBeenCalledWith('raw-bucket', result.s3Key, expect.any(Array));
  });

  it('captures per-severity errors without throwing', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('NVD API timeout'))   // HIGH fails
      .mockResolvedValueOnce({ ok: true, json: async () => EMPTY_PAGE_RESPONSE }); // CRITICAL ok
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/NVD HIGH/);
    expect(result.articleCount).toBe(0);
  });

  it('throws when the NVD API responds with a non-ok status', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    (global.fetch as jest.Mock)
      .mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' });

    const result = await handler({ date: '2026-04-18' });
    // Both HIGH and CRITICAL fail → 2 errors collected
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatch(/NVD API HTTP 403/);
  });

  it('paginates when totalResults exceeds page size', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);

    const firstPage: NvdResponse = {
      totalResults: 2001, // more than one page
      startIndex: 0,
      resultsPerPage: 2000,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2026-PAGE1',
            published: '2026-04-18T10:00:00.000',
            lastModified: '2026-04-18T10:00:00.000',
            descriptions: [{ lang: 'en', value: 'Page 1 CVE.' }],
            references: [],
          },
        },
      ],
    };
    const secondPage: NvdResponse = {
      totalResults: 2001,
      startIndex: 2000,
      resultsPerPage: 2000,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2026-PAGE2',
            published: '2026-04-18T11:00:00.000',
            lastModified: '2026-04-18T11:00:00.000',
            descriptions: [{ lang: 'en', value: 'Page 2 CVE.' }],
            references: [],
          },
        },
      ],
    };

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => firstPage })    // HIGH page 1
      .mockResolvedValueOnce({ ok: true, json: async () => secondPage })   // HIGH page 2
      .mockResolvedValueOnce({ ok: true, json: async () => EMPTY_PAGE_RESPONSE }); // CRITICAL
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-04-18', lookbackHours: 24 });
    // 1 article from page1 + 1 from page2 for HIGH; 0 for CRITICAL
    expect(result.articleCount).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('uses event.date to build the S3 key', async () => {
    mockGetJson.mockResolvedValue(SOURCES_ENABLED);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => EMPTY_PAGE_RESPONSE });
    mockPutJson.mockResolvedValue(undefined);

    const result = await handler({ date: '2026-01-15' });
    expect(result.s3Key).toMatch(/^raw\/2026-01-15\/nvd\//);
  });
});
