// ── Severity & Category ───────────────────────────────────────────────────────

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type RelevanceCategory =
  | 'BEDROCK_AGENTCORE' // Directly affects AWS Bedrock or Agent Core
  | 'AI_GENERAL'        // General AI security / research
  | 'AWS_SECURITY'      // Non-AI AWS security (included when severity is HIGH+)
  | 'OTHER';            // Filtered out unless CRITICAL

// ── Source configuration (sources.json schema) ───────────────────────────────

export interface RssSource {
  name: string;
  url: string;
  enabled: boolean;
}

export interface ApiSource {
  name: string;
  type: 'nvd' | 'arxiv';
  enabled: boolean;
}

export interface SocialSource {
  name: string;
  platform: 'x';
  handle: string;
  enabled: boolean;
}

export interface SourcesConfig {
  rss: RssSource[];
  apis: ApiSource[];
  social: SocialSource[];
}

// ── Article pipeline types ────────────────────────────────────────────────────

export interface RawArticle {
  id: string;           // sha256 of url — deduplication key
  title: string;
  url: string;
  source: string;
  sourceType: 'rss' | 'nvd' | 'arxiv' | 'x';
  content: string;      // raw text / abstract
  publishedAt: string;  // ISO 8601
  scrapedAt: string;    // ISO 8601
}

export interface AnalyzedArticle extends RawArticle {
  summary: string;                // 2-3 sentence Bedrock-generated summary
  severity: Severity;
  relevance: {
    category: RelevanceCategory;
    score: number;                // 0–100
    reasoning: string;            // why this was flagged / rated
  };
  affectedProducts: string[];
}

export interface DigestPayload {
  date: string;                   // YYYY-MM-DD — the digest date
  generatedAt: string;            // ISO 8601
  totalScraped: number;
  totalIncluded: number;
  articles: AnalyzedArticle[];
}

// ── Step Functions I/O ────────────────────────────────────────────────────────

export interface ScrapeResult {
  sourceType: RawArticle['sourceType'];
  s3Key: string;        // where raw articles were written
  articleCount: number;
  errors: string[];
}

export interface ProcessResult {
  s3Key: string;        // where analyzed articles were written
  articleCount: number;
}

export interface FilterResult {
  s3Key: string;        // where the digest payload was written
  included: number;
  excluded: number;
}
