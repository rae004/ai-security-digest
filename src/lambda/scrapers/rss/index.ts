import { createHash } from 'crypto';

import { XMLParser } from 'fast-xml-parser';

import { getJsonFromS3, putJsonToS3 } from '../../shared/s3-client';
import type { RawArticle, ScrapeResult, SourcesConfig } from '../../shared/types';

// ── Event ──────────────────────────────────────────────────────────────────────

interface ScraperEvent {
  date?: string;
  lookbackHours?: number;
}

// ── XML shape types (fast-xml-parser output) ───────────────────────────────────

interface TextNode {
  '#text': string;
}

interface RssItem {
  title?: string | TextNode;
  link?: string;
  description?: string | TextNode;
  pubDate?: string;
  'content:encoded'?: string;
}

interface AtomLink {
  '@_href': string;
  '@_type'?: string;
  '@_rel'?: string;
}

interface AtomEntry {
  title?: string | TextNode;
  link?: AtomLink | AtomLink[];
  summary?: string | TextNode;
  content?: string | TextNode;
  published?: string;
  updated?: string;
}

interface ParsedFeed {
  rss?: { channel?: { item?: RssItem | RssItem[] } };
  feed?: { entry?: AtomEntry | AtomEntry[] };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(value: string | TextNode | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : (value['#text'] ?? '');
}

function parseIsoDate(dateStr: string | undefined): string {
  if (!dateStr) return new Date().toISOString();
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ── RSS / Atom parser (exported for unit tests) ────────────────────────────────

export function parseRssXml(xml: string, sourceName: string, scrapedAt: string): RawArticle[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const feed = parser.parse(xml) as ParsedFeed;
  const articles: RawArticle[] = [];

  if (feed.rss?.channel) {
    // ── RSS 2.0 ──
    for (const item of toArray(feed.rss.channel.item)) {
      const url = (typeof item.link === 'string' ? item.link : '').trim();
      if (!url) continue;
      const rawContent = item['content:encoded'] ?? textOf(item.description);
      articles.push({
        id: sha256Hex(url),
        title: stripHtml(textOf(item.title)),
        url,
        source: sourceName,
        sourceType: 'rss',
        content: stripHtml(rawContent),
        publishedAt: parseIsoDate(item.pubDate),
        scrapedAt,
      });
    }
  } else if (feed.feed?.entry) {
    // ── Atom ──
    for (const entry of toArray(feed.feed.entry)) {
      const links = toArray(entry.link);
      const href =
        links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href']?.trim() ?? '';
      if (!href) continue;
      articles.push({
        id: sha256Hex(href),
        title: stripHtml(textOf(entry.title)),
        url: href,
        source: sourceName,
        sourceType: 'rss',
        content: stripHtml(textOf(entry.content ?? entry.summary)),
        publishedAt: parseIsoDate(entry.published ?? entry.updated),
        scrapedAt,
      });
    }
  }

  return articles;
}

// ── Lambda handler ─────────────────────────────────────────────────────────────

const CONFIG_BUCKET = process.env.CONFIG_BUCKET ?? '';
const RAW_ARTICLES_BUCKET = process.env.RAW_ARTICLES_BUCKET ?? '';

export const handler = async (event: ScraperEvent): Promise<ScrapeResult> => {
  const date = event.date ?? new Date().toISOString().slice(0, 10);
  const lookbackHours = event.lookbackHours ?? 48;
  const scrapedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const errors: string[] = [];
  const allArticles: RawArticle[] = [];

  const sources = await getJsonFromS3<SourcesConfig>(CONFIG_BUCKET, 'sources.json');

  for (const source of sources.rss.filter((s) => s.enabled)) {
    try {
      const resp = await fetch(source.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      const articles = parseRssXml(xml, source.name, scrapedAt).filter(
        (a) => new Date(a.publishedAt) >= cutoff,
      );
      allArticles.push(...articles);
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const s3Key = `raw/${date}/rss/${scrapedAt.replace(/[:.]/g, '-')}.json`;
  await putJsonToS3(RAW_ARTICLES_BUCKET, s3Key, allArticles);

  return { sourceType: 'rss', s3Key, articleCount: allArticles.length, errors };
};
