import type { RawArticle, RelevanceCategory } from '../../src/lambda/shared/types';

// ── Golden regression set for classification correctness ───────────────────────
//
// These are NOT unit-test fixtures for parseAnalysis — they're inputs to a real
// Bedrock call (see scripts/eval-golden-set.ts) that checks whether the live
// model still assigns the correct `relevance.category` per src/lambda/processor/prompt.ts's
// rules. Each entry's `expectedCategory` is the deterministically correct answer;
// severity is intentionally not asserted since it's a judgment call, not a rule.
//
// Grouped by what each case is actually testing:
//   - REGRESSION: real misclassifications found in production (see PR #100)
//   - BAIT: novel cases in the same failure family, to check the fix generalizes
//     rather than having just memorized the three regression cases
//   - TRUE POSITIVE: confirms the fix didn't overcorrect into under-classifying

export interface GoldenArticle extends RawArticle {
  expectedCategory: RelevanceCategory;
}

function article(
  id: string,
  title: string,
  content: string,
  expectedCategory: RelevanceCategory,
): GoldenArticle {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    source: 'NVD',
    sourceType: 'nvd',
    content,
    publishedAt: '2026-09-01T00:00:00.000Z',
    scrapedAt: '2026-09-01T00:05:00.000Z',
    expectedCategory,
  };
}

export const GOLDEN_ARTICLES: GoldenArticle[] = [
  // ── REGRESSION: real production misclassifications (PR #100) ─────────────────
  article(
    'golden-regression-entra-id',
    'CVE-2026-62916',
    'Microsoft Entra ID (Azure AD) contains an authentication bypass via alternate path/channel ' +
      'allowing privilege escalation over the network. Affects identity and access management for ' +
      'cloud services.',
    'OTHER',
  ),
  article(
    'golden-regression-azure-ad-b2c',
    'CVE-2026-83711',
    'CVE-2026-83711 is a critical authorization bypass in Azure Active Directory B2C through ' +
      'user-controlled key manipulation, enabling network-based privilege escalation. This affects ' +
      'all organizations using Azure AD B2C for identity and access management.',
    'OTHER',
  ),
  article(
    'golden-regression-kyverno',
    'CVE-2026-84200',
    'Kyverno policy exception handling flaw (v1.9.0-v1.12.7) allows attackers to bypass ' +
      'enforce-mode policies by crafting resource names matching less restrictive exception ' +
      'patterns, potentially circumventing security controls like hostPath volume blocking. Fixed ' +
      'in v1.13.0.',
    'OTHER',
  ),

  // ── BAIT: same failure family, not seen during the fix ───────────────────────
  article(
    'golden-bait-gcp-iam',
    'CVE-2026-91442',
    'Google Cloud IAM contains a privilege escalation vulnerability where custom role bindings ' +
      'with conditional expressions can be bypassed via malformed condition operators, allowing ' +
      'unauthorized principals to assume elevated permissions on GCP projects.',
    'OTHER',
  ),
  article(
    'golden-bait-okta',
    'CVE-2026-77310',
    'Okta Workforce Identity Cloud contains an authentication bypass in its SAML assertion ' +
      'validation logic, allowing an attacker to forge session tokens and impersonate any user in ' +
      'the affected organization.',
    'OTHER',
  ),
  article(
    'golden-bait-opa-eks',
    'CVE-2026-88213',
    'Open Policy Agent (OPA) Rego policy evaluation contains a logic flaw that allows crafted ' +
      'input documents to bypass "deny" rules under specific recursion depths. OPA is commonly ' +
      'deployed as an admission controller in Amazon EKS clusters via Gatekeeper.',
    'OTHER',
  ),
  article(
    'golden-bait-struts-ec2-mention',
    'CVE-2026-70055',
    'Apache Struts contains a remote code execution vulnerability in its OGNL expression handling, ' +
      'under active exploitation in the wild. AWS has confirmed that some customer workloads ' +
      'running on EC2 instances have been affected by opportunistic scanning targeting this CVE.',
    'OTHER',
  ),

  // ── TRUE POSITIVE: AWS_SECURITY (vulnerable product IS an AWS service) ───────
  article(
    'golden-true-positive-iam-trust-policy',
    'CVE-2026-55123',
    'AWS IAM trust policy evaluation contains a flaw where condition operators using ' +
      '"ForAnyValue:StringLike" can be crafted to hide wildcard subject conditions, allowing ' +
      'unauthorized cross-account role assumption via forged OIDC tokens.',
    'AWS_SECURITY',
  ),
  article(
    'golden-true-positive-lambda-confused-deputy',
    'CVE-2026-55871',
    'AWS Lambda execution roles are vulnerable to a confused deputy attack where a Lambda function ' +
      'invoked by one AWS service can be tricked into accessing resources in a different customer ' +
      'account via crafted event source ARNs.',
    'AWS_SECURITY',
  ),

  // ── TRUE POSITIVE: BEDROCK_AGENTCORE ──────────────────────────────────────────
  article(
    'golden-true-positive-bedrock-session-isolation',
    'Bedrock AgentCore Session Isolation Flaw',
    'A flaw in Amazon Bedrock AgentCore session management allows an agent session belonging to ' +
      'one tenant to access conversation state and retrieved documents belonging to a different ' +
      'tenant under high concurrency, due to a session ID collision in the runtime.',
    'BEDROCK_AGENTCORE',
  ),
  article(
    'golden-true-positive-bedrock-guardrail-bypass',
    'Bedrock Guardrail Configuration Bypass',
    'Amazon Bedrock model invocations can bypass configured content guardrails when the ' +
      'guardrailIdentifier parameter is supplied with a trailing version suffix that does not ' +
      'match any published guardrail version, silently falling back to unfiltered inference.',
    'BEDROCK_AGENTCORE',
  ),

  // ── TRUE POSITIVE: AI_GENERAL ─────────────────────────────────────────────────
  article(
    'golden-true-positive-prompt-injection',
    'Cross-Provider Prompt Injection via Tool Descriptions',
    'Security researchers disclosed a novel prompt injection technique that embeds adversarial ' +
      'instructions inside MCP tool descriptions, causing several major LLM providers\' models to ' +
      'exfiltrate conversation context when the tool is listed but never invoked.',
    'AI_GENERAL',
  ),
  article(
    'golden-true-positive-langchain-cve',
    'CVE-2026-60214',
    'The LangChain framework\'s experimental SQLDatabaseChain contains an unsafe deserialization ' +
      'flaw that allows arbitrary code execution when processing crafted pickle payloads returned ' +
      'from a connected database result set.',
    'AI_GENERAL',
  ),

  // ── TRUE POSITIVE: OTHER (generic infra, no AWS/AI angle at all) ─────────────
  article(
    'golden-true-positive-linux-kernel',
    'CVE-2026-40881',
    'A use-after-free vulnerability in the Linux kernel\'s netfilter subsystem allows a local ' +
      'unprivileged user to trigger a kernel panic or potentially escalate privileges via crafted ' +
      'nftables rule updates.',
    'OTHER',
  ),
  article(
    'golden-true-positive-openssl',
    'CVE-2026-33107',
    'OpenSSL contains a buffer overflow in its X.509 certificate chain parsing logic, triggered ' +
      'when processing certificates with deeply nested policy constraint extensions, potentially ' +
      'leading to denial of service or memory corruption.',
    'OTHER',
  ),
];
