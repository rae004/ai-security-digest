import type { RawArticle } from '../shared/types';

// ── CVSS parsing ───────────────────────────────────────────────────────────────

// The NVD scraper prepends "CVSS <score> (<SEVERITY>). " to article content
const CVSS_PREFIX = /^CVSS (\d+(?:\.\d+)?) /;

export function parseCvssScore(article: RawArticle): number | null {
  const match = CVSS_PREFIX.exec(article.content);
  return match ? Number(match[1]) : null;
}

// ── Keyword relevance pre-filter (NVD only) ────────────────────────────────────

// NVD CVEs that mention none of these terms can only ever reach the digest as
// OTHER/CRITICAL, so anything below the CVSS floor is dropped before Bedrock.
// Curated sources (rss/arxiv/x) always pass — Bedrock still triages them.
const RELEVANCE_KEYWORDS = new RegExp(
  '\\b(' +
    [
      'ai',
      'artificial intelligence',
      'machine learning',
      'deep learning',
      'neural network',
      'llm',
      'large language model',
      'prompt injection',
      'jailbreak',
      'anthropic',
      'claude',
      'openai',
      'gpt',
      'langchain',
      'pytorch',
      'tensorflow',
      'hugging ?face',
      'aws',
      'amazon',
      'bedrock',
      'sagemaker',
      'iam',
      's3',
      'lambda',
      'ec2',
      'eks',
      'ecs',
      'kms',
      'vpc',
      'cloudformation',
    ].join('|') +
    ')\\b',
  'i',
);

// Downstream filter admits OTHER only at CRITICAL — mirror that cheaply here
const CVSS_ALWAYS_KEEP = 9.0;

export interface PreFilterResult {
  kept: RawArticle[];
  droppedCount: number;
}

export function preFilterNvd(articles: RawArticle[]): PreFilterResult {
  const kept = articles.filter((a) => {
    if (a.sourceType !== 'nvd') return true;
    if ((parseCvssScore(a) ?? 0) >= CVSS_ALWAYS_KEEP) return true;
    return RELEVANCE_KEYWORDS.test(`${a.title} ${a.content}`);
  });
  return { kept, droppedCount: articles.length - kept.length };
}

// ── Volume cap ─────────────────────────────────────────────────────────────────

// Curated sources always survive the cut; NVD articles compete by CVSS score.
export function capArticles(articles: RawArticle[], max: number): RawArticle[] {
  if (articles.length <= max) return articles;
  const priority = (a: RawArticle): number =>
    a.sourceType === 'nvd' ? (parseCvssScore(a) ?? 0) : Number.POSITIVE_INFINITY;
  // Array.prototype.sort is stable — equal-priority articles keep their order
  return [...articles].sort((a, b) => priority(b) - priority(a)).slice(0, max);
}
