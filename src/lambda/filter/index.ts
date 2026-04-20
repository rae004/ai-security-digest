import { getJsonFromS3, putJsonToS3 } from '../shared/s3-client';
import type {
  AnalyzedArticle,
  DigestPayload,
  FilterResult,
  RelevanceCategory,
  Severity,
} from '../shared/types';

// ── Event ──────────────────────────────────────────────────────────────────────

interface FilterEvent {
  date?: string;          // YYYY-MM-DD or ISO string — .slice(0,10) normalises both
  processedS3Key: string;
}

// ── Filter rules ───────────────────────────────────────────────────────────────

export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
};

// Minimum severity rank required to include an article per relevance category.
// Values mirror the comments in types.ts:
//   BEDROCK_AGENTCORE — always include
//   AI_GENERAL        — MEDIUM and above (core purpose of the digest)
//   AWS_SECURITY      — HIGH and above (non-AI AWS; only when severe)
//   OTHER             — CRITICAL only
export const INCLUDE_THRESHOLD: Record<RelevanceCategory, number> = {
  BEDROCK_AGENTCORE: 1,
  AI_GENERAL: 3,
  AWS_SECURITY: 4,
  OTHER: 5,
};

// ── Seen-IDs tracking ─────────────────────────────────────────────────────────
// Persists the IDs of every article included in a digest so subsequent runs
// can skip them. Stored as sent-ids/YYYY-MM-DD.json in the digests bucket.

const SEEN_IDS_PREFIX = 'sent-ids';
const SEEN_IDS_LOOKBACK_DAYS = 7;

export async function loadSeenIds(
  bucket: string,
  date: string,
  lookbackDays = SEEN_IDS_LOOKBACK_DAYS,
): Promise<Set<string>> {
  const seen = new Set<string>();
  const base = new Date(`${date}T00:00:00Z`);

  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    const key = `${SEEN_IDS_PREFIX}/${d.toISOString().slice(0, 10)}.json`;
    try {
      const ids = await getJsonFromS3<string[]>(bucket, key);
      ids.forEach((id) => seen.add(id));
    } catch {
      // No sent-ids file for this date — first run or no digest that day
    }
  }

  return seen;
}

export async function saveSeenIds(
  bucket: string,
  date: string,
  ids: string[],
): Promise<void> {
  await putJsonToS3(bucket, `${SEEN_IDS_PREFIX}/${date}.json`, ids);
}

// ── Core logic (exported for unit tests) ──────────────────────────────────────

export function shouldInclude(article: AnalyzedArticle): boolean {
  const rank = SEVERITY_RANK[article.severity];
  const threshold = INCLUDE_THRESHOLD[article.relevance.category];
  return rank >= threshold;
}

export function sortArticles(articles: AnalyzedArticle[]): AnalyzedArticle[] {
  return [...articles].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) return severityDiff;
    return b.relevance.score - a.relevance.score;
  });
}

export function filterAndSort(articles: AnalyzedArticle[]): {
  included: AnalyzedArticle[];
  excluded: number;
} {
  const included = sortArticles(articles.filter(shouldInclude));
  return { included, excluded: articles.length - included.length };
}

// ── Lambda handler ─────────────────────────────────────────────────────────────

const PROCESSED_ARTICLES_BUCKET = process.env.PROCESSED_ARTICLES_BUCKET ?? '';
const DIGESTS_BUCKET = process.env.DIGESTS_BUCKET ?? '';

export const handler = async (event: FilterEvent): Promise<FilterResult> => {
  const date = (event.date ?? new Date().toISOString()).slice(0, 10);
  const generatedAt = new Date().toISOString();

  const analyzed = await getJsonFromS3<AnalyzedArticle[]>(
    PROCESSED_ARTICLES_BUCKET,
    event.processedS3Key,
  );

  // Exclude articles already sent in a previous digest (7-day lookback)
  const seenIds = await loadSeenIds(DIGESTS_BUCKET, date);
  const unseen = analyzed.filter((a) => !seenIds.has(a.id));
  const alreadySent = analyzed.length - unseen.length;

  const { included, excluded } = filterAndSort(unseen);

  const digest: DigestPayload = {
    date,
    generatedAt,
    totalScraped: analyzed.length,
    totalIncluded: included.length,
    articles: included,
  };

  const s3Key = `digests/${date}/${generatedAt.replace(/[:.]/g, '-')}.json`;
  await putJsonToS3(DIGESTS_BUCKET, s3Key, digest);

  // Persist sent IDs so tomorrow's run skips them
  await saveSeenIds(DIGESTS_BUCKET, date, included.map((a) => a.id));

  console.warn(
    `[filter] date=${date} total=${analyzed.length} alreadySent=${alreadySent} unseen=${unseen.length} included=${included.length} excluded=${excluded}`,
  );

  return { s3Key, included: included.length, excluded: excluded + alreadySent };
};
