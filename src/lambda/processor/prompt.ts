import type { AnalyzedArticle, RawArticle, RelevanceCategory, Severity } from '../shared/types';

// ── System prompt ──────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are a senior security analyst triaging articles for a daily AI Security Digest.

You will receive a numbered list of articles. Analyze each one independently.

Category definitions and examples:
- BEDROCK_AGENTCORE: Bedrock API vuln, Agent Core SDK flaw, Bedrock model access bypass
- AI_GENERAL: LLM jailbreak, prompt injection, model poisoning, AI framework CVE (PyTorch, TensorFlow, LangChain)
- AWS_SECURITY: IAM privilege escalation, S3 bucket policy bypass, Lambda execution role flaw, EKS RBAC issue — the VULNERABLE PRODUCT ITSELF must be a named AWS service (IAM, S3, Lambda, EC2, CloudFormation, SageMaker, KMS, VPC, ECS, EKS, etc.), not merely mentioned in passing or compared to one.
- OTHER: Linux kernel CVE, OpenSSL vulnerability, Apache/nginx flaw, Python/Node.js runtime bug

Exclusion rule: If the CVE affects infrastructure software or third-party tooling — Linux, OpenSSL, Apache, nginx, Python, Node.js, Docker, Kubernetes tooling not owned by AWS (Kyverno, OPA, cert-manager, etc.), or another cloud/identity provider (Azure, Microsoft Entra ID, Azure AD, GCP, Google Cloud IAM, Okta, Auth0, etc.) — categorize as OTHER, even if it is deployable on AWS or is conceptually similar to an AWS service. Do not use analogy or comparison (e.g. "X is similar to AWS IAM", "commonly used in EKS environments", "cross-cloud implications") to justify AWS_SECURITY — the affected product must BE an AWS service, not resemble one or run alongside one.

Return ONLY a JSON array (no markdown, no prose) with exactly one object per article. Each object MUST echo the article's number in the "index" field:
[
  {
    "index": <article number>,
    "summary": "<2-3 sentences focused on the security implication and who is affected>",
    "severity": "<CRITICAL|HIGH|MEDIUM|LOW|INFO>",
    "relevance_category": "<BEDROCK_AGENTCORE|AI_GENERAL|AWS_SECURITY|OTHER>",
    "relevance_score": <integer 0-100>,
    "reasoning": "<one sentence explaining severity + category choice>",
    "affected_products": ["<product or service name>"]
  }
]

Severity guidelines:
CRITICAL — active exploitation, zero-day, or severe impact to AI/cloud workloads in production
HIGH     — significant unpatched vulnerability, working PoC, or major AI security research finding
MEDIUM   — patched vulnerability, theoretical attack, or moderate AI security concern
LOW      — informational update, minor or highly qualified risk, or tangential AI topic
INFO     — general news with no direct security implication`;

// ── User message builder ───────────────────────────────────────────────────────

export function buildUserMessage(articles: RawArticle[]): string {
  return articles
    .map((article, i) => {
      const content = article.content.slice(0, 4000); // guard against oversized content
      return `### Article ${i + 1}
Title: ${article.title}
Source: ${article.source} (${article.sourceType})
Published: ${article.publishedAt}
URL: ${article.url}

Content:
${content}`;
    })
    .join('\n\n');
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
  index?: unknown;
  summary?: unknown;
  severity?: unknown;
  relevance_category?: unknown;
  relevance_score?: unknown;
  reasoning?: unknown;
  affected_products?: unknown;
}

function coerceAnalysis(article: RawArticle, raw: RawAnalysis): AnalyzedArticle {
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

// Joins the model's JSON array back to the input articles by the echoed "index"
// field (1-based). Articles missing from the response get a safe fallback.
export function parseAnalysis(articles: RawArticle[], responseText: string): AnalyzedArticle[] {
  // Strip potential markdown code fences before parsing
  const cleaned = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return articles.map((a) =>
      fallback(a, `Failed to parse Bedrock response: ${responseText.slice(0, 200)}`),
    );
  }

  const entries = Array.isArray(parsed) ? (parsed as RawAnalysis[]) : [];
  const byIndex = new Map<number, RawAnalysis>();
  for (const entry of entries) {
    if (typeof entry?.index === 'number') byIndex.set(entry.index, entry);
  }

  return articles.map((article, i) => {
    const raw = byIndex.get(i + 1);
    return raw
      ? coerceAnalysis(article, raw)
      : fallback(article, `No analysis returned for article index ${i + 1}`);
  });
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
