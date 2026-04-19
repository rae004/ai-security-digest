import { createHash } from 'crypto';

import { XMLParser } from 'fast-xml-parser';

import { getJsonFromS3, putJsonToS3 } from '../../shared/s3-client';
import type { RawArticle, ScrapeResult, SourcesConfig } from '../../shared/types';

// ── Event ──────────────────────────────────────────────────────────────────────

interface ScraperEvent {
  date?: string;
  lookbackHours?: number;
}

// ── ArXiv Atom types (fast-xml-parser output) ──────────────────────────────────

interface ArxivLink {
  '@_href': string;
  '@_rel'?: string;
  '@_type'?: string;
}

interface ArxivEntry {
  id: string;
  title?: string | { '#text': string };
  summary?: string;
  published?: string;
  updated?: string;
  link?: ArxivLink | ArxivLink[];
  author?: { name: string } | Array<{ name: string }>;
}

interface ArxivFeed {
  feed?: {
    entry?: ArxivEntry | ArxivEntry[];
    'opensearch:totalResults'?: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: string | { '#text': string } | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : (value['#text'] ?? '');
}

// Normalise ArXiv entry URL: strip version suffix (v1, v2, …) and force https
function normaliseArxivUrl(rawId: string): string {
  const base = rawId.trim().replace(/v\d+$/, '');
  return base.replace('http://', 'https://');
}

// ── Parser (exported for unit tests) ──────────────────────────────────────────

export function parseArxivXml(xml: string, scrapedAt: string): RawArticle[] {
  // isArray not needed — toArray() handles single-vs-array at access time
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml) as ArxivFeed;
  const entries = toArray(parsed.feed?.entry);
  const articles: RawArticle[] = [];

  for (const entry of entries) {
    const rawId = entry.id?.trim() ?? '';
    if (!rawId) continue;

    const url = normaliseArxivUrl(rawId);
    const title = textOf(entry.title).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const summary = (entry.summary ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    articles.push({
      id: sha256Hex(url),
      title,
      url,
      source: 'ArXiv',
      sourceType: 'arxiv' as const,
      content: summary,
      publishedAt: new Date(entry.published ?? entry.updated ?? scrapedAt).toISOString(),
      scrapedAt,
    });
  }

  return articles;
}

// ── ArXiv query builder ────────────────────────────────────────────────────────

// Focus on AI/security papers: cs.CR (cryptography & security) or cs.AI,
// with titles touching on LLMs, adversarial attacks, jailbreaks, or vulnerabilities.
const ARXIV_QUERY =
  '(cat:cs.CR OR cat:cs.AI OR cat:cs.LG) AND ' +
  '(ti:adversarial OR ti:security OR ti:attack OR ti:vulnerability OR ' +
  'ti:jailbreak OR ti:backdoor OR ti:poisoning OR ti:LLM OR ti:large+language+model OR ' +
  'ti:prompt+injection OR ti:AI+safety)';

const ARXIV_BASE_URL = 'https://export.arxiv.org/api/query';

// ── Lambda handler ─────────────────────────────────────────────────────────────

const CONFIG_BUCKET = process.env.CONFIG_BUCKET ?? '';
const RAW_ARTICLES_BUCKET = process.env.RAW_ARTICLES_BUCKET ?? '';

export const handler = async (event: ScraperEvent): Promise<ScrapeResult> => {
  const date = event.date ?? new Date().toISOString().slice(0, 10);
  const lookbackHours = event.lookbackHours ?? 48;
  const scrapedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const errors: string[] = [];
  let allArticles: RawArticle[] = [];

  const sources = await getJsonFromS3<SourcesConfig>(CONFIG_BUCKET, 'sources.json');
  const arxivEnabled = sources.apis.find((a) => a.type === 'arxiv')?.enabled ?? false;
  if (!arxivEnabled) {
    return { sourceType: 'arxiv', s3Key: '', articleCount: 0, errors: ['ArXiv source is disabled in sources.json'] };
  }

  try {
    const params = new URLSearchParams({
      search_query: ARXIV_QUERY,
      sortBy: 'submittedDate',
      sortOrder: 'descending',
      max_results: '100',
      start: '0',
    });

    const resp = await fetch(`${ARXIV_BASE_URL}?${params.toString()}`, {
      headers: { 'Accept': 'application/atom+xml' },
    });
    if (!resp.ok) throw new Error(`ArXiv API HTTP ${resp.status}`);

    const xml = await resp.text();
    allArticles = parseArxivXml(xml, scrapedAt).filter(
      (a) => new Date(a.publishedAt) >= cutoff,
    );
  } catch (err) {
    errors.push(`ArXiv: ${err instanceof Error ? err.message : String(err)}`);
  }

  const s3Key = `raw/${date}/arxiv/${scrapedAt.replace(/[:.]/g, '-')}.json`;
  await putJsonToS3(RAW_ARTICLES_BUCKET, s3Key, allArticles);

  return { sourceType: 'arxiv', s3Key, articleCount: allArticles.length, errors };
};
