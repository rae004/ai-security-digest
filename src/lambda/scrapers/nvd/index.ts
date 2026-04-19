import { createHash } from 'crypto';

import { getJsonFromS3, putJsonToS3 } from '../../shared/s3-client';
import type { RawArticle, ScrapeResult, SourcesConfig } from '../../shared/types';

// ── Event ──────────────────────────────────────────────────────────────────────

interface ScraperEvent {
  date?: string;
  lookbackHours?: number;
}

// ── NVD API v2 response types ──────────────────────────────────────────────────

interface NvdDescription {
  lang: string;
  value: string;
}

interface NvdCvssV3 {
  cvssData: { baseScore: number; baseSeverity: string };
}

interface NvdCve {
  id: string;
  published: string;
  lastModified: string;
  descriptions: NvdDescription[];
  references: Array<{ url: string }>;
  metrics?: {
    cvssMetricV31?: NvdCvssV3[];
    cvssMetricV30?: NvdCvssV3[];
  };
}

export interface NvdResponse {
  totalResults: number;
  startIndex: number;
  resultsPerPage: number;
  vulnerabilities: Array<{ cve: NvdCve }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// NVD API expects UTC datetime without timezone designator: 2024-01-01T00:00:00.000
function toNvdDate(d: Date): string {
  return d.toISOString().replace('Z', '');
}

// ── Parser (exported for unit tests) ──────────────────────────────────────────

export function parseNvdResponse(data: NvdResponse, scrapedAt: string): RawArticle[] {
  return data.vulnerabilities.map(({ cve }) => {
    const url = `https://nvd.nist.gov/vuln/detail/${cve.id}`;
    const desc = cve.descriptions.find((d) => d.lang === 'en')?.value ?? '';
    return {
      id: sha256Hex(url),
      title: cve.id,
      url,
      source: 'NVD',
      sourceType: 'nvd' as const,
      content: desc,
      // NVD dates lack a timezone designator — they are UTC; append Z before parsing.
      publishedAt: new Date(cve.published.endsWith('Z') ? cve.published : cve.published + 'Z').toISOString(),
      scrapedAt,
    };
  });
}

// ── Lambda handler ─────────────────────────────────────────────────────────────

const CONFIG_BUCKET = process.env.CONFIG_BUCKET ?? '';
const RAW_ARTICLES_BUCKET = process.env.RAW_ARTICLES_BUCKET ?? '';
const NVD_API_KEY = process.env.NVD_API_KEY ?? '';

// NVD rate limits: 5 req/30s unauthenticated, 50 req/30s with key.
const NVD_PAGE_SIZE = 2000;
const NVD_BASE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

async function fetchNvdPage(params: URLSearchParams): Promise<NvdResponse> {
  const url = `${NVD_BASE_URL}?${params.toString()}`;
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (NVD_API_KEY) headers['apiKey'] = NVD_API_KEY;

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`NVD API HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<NvdResponse>;
}

export const handler = async (event: ScraperEvent): Promise<ScrapeResult> => {
  const date = event.date ?? new Date().toISOString().slice(0, 10);
  const lookbackHours = event.lookbackHours ?? 48;
  const scrapedAt = new Date().toISOString();
  const errors: string[] = [];
  const allArticles: RawArticle[] = [];

  const sources = await getJsonFromS3<SourcesConfig>(CONFIG_BUCKET, 'sources.json');
  const nvdEnabled = sources.apis.find((a) => a.type === 'nvd')?.enabled ?? false;
  if (!nvdEnabled) {
    return { sourceType: 'nvd', s3Key: '', articleCount: 0, errors: ['NVD source is disabled in sources.json'] };
  }

  const endDate = new Date();
  const startDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  try {
    const baseParams = new URLSearchParams({
      pubStartDate: toNvdDate(startDate),
      pubEndDate: toNvdDate(endDate),
      resultsPerPage: String(NVD_PAGE_SIZE),
      startIndex: '0',
    });

    const firstPage = await fetchNvdPage(baseParams);
    allArticles.push(...parseNvdResponse(firstPage, scrapedAt));

    // Paginate if needed (rare for 48h windows)
    let startIndex = NVD_PAGE_SIZE;
    while (startIndex < firstPage.totalResults) {
      if (!NVD_API_KEY) {
        // Respect unauthenticated rate limit: 5 req / 30s
        await new Promise((resolve) => setTimeout(resolve, 7000));
      }
      baseParams.set('startIndex', String(startIndex));
      const page = await fetchNvdPage(baseParams);
      allArticles.push(...parseNvdResponse(page, scrapedAt));
      startIndex += NVD_PAGE_SIZE;
    }
  } catch (err) {
    errors.push(`NVD: ${err instanceof Error ? err.message : String(err)}`);
  }

  const s3Key = `raw/${date}/nvd/${scrapedAt.replace(/[:.]/g, '-')}.json`;
  await putJsonToS3(RAW_ARTICLES_BUCKET, s3Key, allArticles);

  return { sourceType: 'nvd', s3Key, articleCount: allArticles.length, errors };
};
