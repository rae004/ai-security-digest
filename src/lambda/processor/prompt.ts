import type { AnalyzedArticle, RawArticle, RelevanceCategory, Severity } from '../shared/types';

// ── System prompt ──────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are a senior security analyst triaging articles for a daily AI Security Digest.

Category definitions and examples:
- BEDROCK_AGENTCORE: Bedrock API vuln, Agent Core SDK flaw, Bedrock model access bypass
- AI_GENERAL: LLM jailbreak, prompt injection, model poisoning, AI framework CVE (PyTorch, TensorFlow, LangChain)
- AWS_SECURITY: IAM privilege escalation, S3 bucket policy bypass, Lambda execution role flaw, EKS RBAC issue — MUST name a specific AWS service (IAM, S3, Lambda, EC2, CloudFormation, SageMaker, KMS, VPC, ECS, EKS, etc.)
- OTHER: Linux kernel CVE, OpenSSL vulnerability, Apache/nginx flaw, Python/Node.js runtime bug

Exclusion rule: If the CVE affects infrastructure software (Linux, OpenSSL, Apache, nginx, Python, Node.js, Docker) and does not mention a specific AWS service by name, categorize as OTHER — not AWS_SECURITY.

Return ONLY a JSON object (no markdown, no prose) with these exact fields:
{
  "summary": "<2-3 sentences focused on the security implication and who is affected>",
  "severity": "<CRITICAL|HIGH|MEDIUM|LOW|INFO>",
  "relevance_category": "<BEDROCK_AGENTCORE|AI_GENERAL|AWS_SECURITY|OTHER>",
  "relevance_score": <integer 0-100>,
  "reasoning": "<one sentence explaining severity + category choice>",
  "affected_products": ["<product or service name>"]
}

Severity guidelines:
CRITICAL — active exploitation, zero-day, or severe impact to AI/cloud workloads in production
HIGH     — significant unpatched vulnerability, working PoC, or major AI security research finding
MEDIUM   — patched vulnerability, theoretical attack, or moderate AI security concern
LOW      — informational update, minor or highly qualified risk, or tangential AI topic
INFO     — general news with no direct security implication`;

// ── User message builder ───────────────────────────────────────────────────────

export function buildUserMessage(article: RawArticle): string {
  const content = article.content.slice(0, 4000); // guard against oversized content
  return `Title: ${article.title}
Source: ${article.source} (${article.sourceType})
Published: ${article.publishedAt}
URL: ${article.url}

Content:
${content}`;
}

// ── Response parser (exported for unit tests) ──────────────────────────────────

const VALID_SEVERITIES = new Set<string>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
const VALID_CATEGORIES = new Set<string>([
  'BEDROCK_AGENTCORE',
  'AI_GENERAL',
  'AWS_SECURITY',
  'OTHER',
]);

interface RawAnalysis {
  summary?: unknown;
  severity?: unknown;
  relevance_category?: unknown;
  relevance_score?: unknown;
  reasoning?: unknown;
  affected_products?: unknown;
}

export function parseAnalysis(
  article: RawArticle,
  responseText: string,
): AnalyzedArticle {
  // Strip potential markdown code fences before parsing
  const cleaned = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let raw: RawAnalysis;
  try {
    raw = JSON.parse(cleaned) as RawAnalysis;
  } catch {
    // If Bedrock didn't return clean JSON, produce a safe fallback
    return fallback(article, `Failed to parse Bedrock response: ${responseText.slice(0, 200)}`);
  }

  const severity = typeof raw.severity === 'string' && VALID_SEVERITIES.has(raw.severity)
    ? (raw.severity as Severity)
    : 'LOW';

  const category =
    typeof raw.relevance_category === 'string' && VALID_CATEGORIES.has(raw.relevance_category)
      ? (raw.relevance_category as RelevanceCategory)
      : 'OTHER';

  const score =
    typeof raw.relevance_score === 'number'
      ? Math.max(0, Math.min(100, Math.round(raw.relevance_score)))
      : 0;

  const affectedProducts = Array.isArray(raw.affected_products)
    ? (raw.affected_products as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];

  return {
    ...article,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    severity,
    relevance: {
      category,
      score,
      reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
    },
    affectedProducts,
  };
}

function fallback(article: RawArticle, reason: string): AnalyzedArticle {
  return {
    ...article,
    summary: article.content.slice(0, 300),
    severity: 'INFO',
    relevance: { category: 'OTHER', score: 0, reasoning: reason },
    affectedProducts: [],
  };
}
