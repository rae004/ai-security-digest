import type { AnalyzedArticle, DigestPayload, RelevanceCategory, Severity } from '../shared/types';

// ── Severity styling ───────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<Severity, string> = {
  CRITICAL: '#dc2626',
  HIGH: '#ea580c',
  MEDIUM: '#d97706',
  LOW: '#2563eb',
  INFO: '#6b7280',
};

const CATEGORY_COLOR: Record<RelevanceCategory, string> = {
  BEDROCK_AGENTCORE: '#7c3aed',
  AI_GENERAL: '#0891b2',
  AWS_SECURITY: '#059669',
  OTHER: '#6b7280',
};

const CATEGORY_LABEL: Record<RelevanceCategory, string> = {
  BEDROCK_AGENTCORE: 'BEDROCK',
  AI_GENERAL: 'AI',
  AWS_SECURITY: 'AWS',
  OTHER: 'OTHER',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function badge(text: string, color: string): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:.5px;color:#fff;background:${color};margin-right:4px">${text}</span>`;
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  return isNaN(d.getTime())
    ? isoDate
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function severityCounts(articles: AnalyzedArticle[]): Partial<Record<Severity, number>> {
  const counts: Partial<Record<Severity, number>> = {};
  for (const a of articles) {
    counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  }
  return counts;
}

// ── Subject line (exported for unit tests) ────────────────────────────────────

export function buildSubject(digest: DigestPayload): string {
  const s = digest.totalIncluded === 1 ? 'item' : 'items';
  return `AI Security Digest — ${digest.date} (${digest.totalIncluded} ${s})`;
}

// ── Plain-text version (exported for unit tests) ──────────────────────────────

export function buildText(digest: DigestPayload): string {
  const lines: string[] = [
    '='.repeat(60),
    `AI SECURITY DIGEST — ${digest.date}`,
    `${digest.totalIncluded} items included / ${digest.totalScraped} scraped`,
    '='.repeat(60),
    '',
  ];

  for (const a of digest.articles) {
    lines.push(`[${a.severity}] [${CATEGORY_LABEL[a.relevance.category]}] ${a.title}`);
    lines.push(a.summary);
    if (a.affectedProducts.length > 0) {
      lines.push(`Affected: ${a.affectedProducts.join(', ')}`);
    }
    lines.push(`Source: ${a.source} — ${a.url}`);
    lines.push(`Published: ${formatDate(a.publishedAt)}`);
    lines.push('');
  }

  lines.push('-'.repeat(60));
  lines.push('AI Security Digest — automated daily pipeline');
  lines.push('To update recipients: aws ssm put-parameter --name /ai-security-digest/recipients --value "..." --overwrite');

  return lines.join('\n');
}

// ── HTML version (exported for unit tests) ────────────────────────────────────

export function buildHtml(digest: DigestPayload): string {
  const counts = severityCounts(digest.articles);

  const statsItems = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as Severity[])
    .filter((s) => counts[s])
    .map(
      (s) =>
        `<span style="margin-right:12px">${badge(s, SEVERITY_COLOR[s])}<span style="font-size:13px;color:#374151;font-weight:600">${counts[s]}</span></span>`,
    )
    .join('');

  const articleRows = digest.articles
    .map((a) => articleRow(a))
    .join('<tr><td style="height:1px;background:#e5e7eb"></td></tr>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Security Digest — ${digest.date}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 16px">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

  <!-- HEADER -->
  <tr><td style="background:#1e1b4b;padding:28px 32px">
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;line-height:1.2">&#128274; AI Security Digest</h1>
    <p style="margin:6px 0 0;color:#a5b4fc;font-size:14px">${digest.date}&nbsp;&nbsp;·&nbsp;&nbsp;${digest.totalIncluded} included&nbsp;&nbsp;·&nbsp;&nbsp;${digest.totalScraped} scraped</p>
  </td></tr>

  <!-- STATS BAR -->
  <tr><td style="background:#f8f7ff;padding:14px 32px;border-bottom:1px solid #e5e7eb">
    ${statsItems}
  </td></tr>

  <!-- ARTICLES -->
  <tr><td style="background:#fff;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0">
    ${articleRows}
  </table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb">
    <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6">
      <strong style="color:#6b7280">AI Security Digest</strong> — automated daily pipeline<br>
      To manage recipients: <code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:11px">aws ssm put-parameter --name /ai-security-digest/recipients --value "..." --overwrite</code>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function articleRow(a: AnalyzedArticle): string {
  const severityColor = SEVERITY_COLOR[a.severity];
  const affectedHtml =
    a.affectedProducts.length > 0
      ? `<p style="margin:6px 0 0;font-size:12px;color:#6b7280">Affected: ${a.affectedProducts.join(', ')}</p>`
      : '';

  return `<tr><td style="padding:16px 32px 16px 28px;border-left:4px solid ${severityColor}">
  <div style="margin-bottom:8px">
    ${badge(a.severity, severityColor)}${badge(CATEGORY_LABEL[a.relevance.category], CATEGORY_COLOR[a.relevance.category])}
  </div>
  <h3 style="margin:0 0 6px;font-size:15px;font-weight:600;line-height:1.3">
    <a href="${a.url}" style="color:#1e1b4b;text-decoration:none">${a.title}</a>
  </h3>
  <p style="margin:0;font-size:14px;color:#374151;line-height:1.55">${a.summary}</p>
  ${affectedHtml}
  <p style="margin:8px 0 0;font-size:12px;color:#9ca3af">${a.source}&nbsp;·&nbsp;${formatDate(a.publishedAt)}</p>
</td></tr>`;
}
