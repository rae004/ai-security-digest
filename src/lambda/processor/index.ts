import { getJsonFromS3, putJsonToS3 } from '../shared/s3-client';
import { loadSeenIds } from '../shared/seen-ids';
import type { AnalyzedArticle, ProcessResult, RawArticle } from '../shared/types';
import { invokeModel, MODEL_ID } from './bedrock-client';
import { capArticles, preFilterNvd } from './pre-filter';
import { buildUserMessage, parseAnalysis, SYSTEM_PROMPT } from './prompt';

// ── Event ──────────────────────────────────────────────────────────────────────

interface ProcessorEvent {
  date?: string;
  // S3 keys written by the scraper Lambdas; empty strings (disabled scrapers) are skipped
  rawS3Keys: string[];
}

// ── Config ─────────────────────────────────────────────────────────────────────

const RAW_ARTICLES_BUCKET = process.env.RAW_ARTICLES_BUCKET ?? '';
const PROCESSED_ARTICLES_BUCKET = process.env.PROCESSED_ARTICLES_BUCKET ?? '';
const DIGESTS_BUCKET = process.env.DIGESTS_BUCKET ?? '';
const CONCURRENCY = 5; // parallel Bedrock invocations — respects on-demand TPM limits
const BATCH_SIZE = 10; // articles per Bedrock invocation
// Hard ceiling on Bedrock work per run — protects cost and the Lambda timeout
// when an upstream source floods (e.g. an NVD bulk CVE publication).
const MAX_ARTICLES_PER_RUN = 500;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function loadRawArticles(s3Keys: string[]): Promise<RawArticle[]> {
  const all: RawArticle[] = [];
  for (const key of s3Keys.filter((k) => k.length > 0)) {
    const articles = await getJsonFromS3<RawArticle[]>(RAW_ARTICLES_BUCKET, key);
    all.push(...articles);
  }
  return all;
}

export function deduplicateById(articles: RawArticle[]): RawArticle[] {
  const seen = new Set<string>();
  return articles.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

async function analyzeBatch(articles: RawArticle[]): Promise<AnalyzedArticle[]> {
  const responseText = await invokeModel(SYSTEM_PROMPT, buildUserMessage(articles));
  return parseAnalysis(articles, responseText);
}

async function processBatch(articles: RawArticle[]): Promise<AnalyzedArticle[]> {
  const results: AnalyzedArticle[] = [];
  const waveSize = BATCH_SIZE * CONCURRENCY;
  for (let i = 0; i < articles.length; i += waveSize) {
    const wave: Promise<AnalyzedArticle[]>[] = [];
    for (let j = i; j < Math.min(i + waveSize, articles.length); j += BATCH_SIZE) {
      wave.push(analyzeBatch(articles.slice(j, j + BATCH_SIZE)));
    }
    const analyzed = await Promise.all(wave);
    results.push(...analyzed.flat());
    // Brief pause between waves to avoid throttling on large inputs
    if (i + waveSize < articles.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return results;
}

// ── Lambda handler ─────────────────────────────────────────────────────────────

export const handler = async (event: ProcessorEvent): Promise<ProcessResult> => {
  const date = (event.date ?? new Date().toISOString()).slice(0, 10);
  const processedAt = new Date().toISOString();

  const rawArticles = await loadRawArticles(event.rawS3Keys);
  const unique = deduplicateById(rawArticles);

  // Pre-filter articles already included in a previous digest — skip Bedrock for these
  const seenIds = await loadSeenIds(DIGESTS_BUCKET, date);
  const unseen = unique.filter((a) => !seenIds.has(a.id));

  // Cost guardrails: drop irrelevant sub-critical NVD CVEs, then cap total volume
  const { kept, droppedCount } = preFilterNvd(unseen);
  const capped = capArticles(kept, MAX_ARTICLES_PER_RUN);

  console.warn(
    `[processor] model=${MODEL_ID} raw=${rawArticles.length} unique=${unique.length} unseen=${unseen.length} ` +
      `keywordDropped=${droppedCount} capDropped=${kept.length - capped.length} toAnalyze=${capped.length} date=${date}`,
  );

  const analyzed = await processBatch(capped);

  const s3Key = `processed/${date}/${processedAt.replace(/[:.]/g, '-')}.json`;
  await putJsonToS3(PROCESSED_ARTICLES_BUCKET, s3Key, analyzed);

  return { s3Key, articleCount: analyzed.length };
};
