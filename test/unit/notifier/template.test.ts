import { buildHtml, buildSubject, buildText } from '../../../src/lambda/notifier/template';
import type { AnalyzedArticle, DigestPayload } from '../../../src/lambda/shared/types';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeArticle(
  overrides: Partial<AnalyzedArticle> & {
    severity: AnalyzedArticle['severity'];
    category: AnalyzedArticle['relevance']['category'];
  },
): AnalyzedArticle {
  const { severity, category, ...rest } = overrides;
  return {
    id: 'test-id',
    title: 'Test Article Title',
    url: 'https://example.com/article',
    source: 'Krebs on Security',
    sourceType: 'rss',
    content: 'Full article content here.',
    publishedAt: '2026-04-18T08:00:00.000Z',
    scrapedAt: '2026-04-18T12:00:00.000Z',
    summary: 'A two-sentence summary of the security finding and its impact.',
    severity,
    relevance: { category, score: 85, reasoning: 'High relevance.' },
    affectedProducts: ['AWS Bedrock', 'Agent Core SDK'],
    ...rest,
  };
}

const SAMPLE_DIGEST: DigestPayload = {
  date: '2026-04-18',
  generatedAt: '2026-04-18T13:00:00.000Z',
  totalScraped: 42,
  totalIncluded: 3,
  articles: [
    makeArticle({ severity: 'CRITICAL', category: 'BEDROCK_AGENTCORE', title: 'Critical Bedrock RCE' }),
    makeArticle({ severity: 'HIGH', category: 'AI_GENERAL', title: 'LLM Jailbreak Research', affectedProducts: [] }),
    makeArticle({ severity: 'MEDIUM', category: 'AWS_SECURITY', title: 'S3 Misconfiguration Pattern', url: 'https://example.com/s3' }),
  ],
};

const EMPTY_DIGEST: DigestPayload = {
  date: '2026-04-18',
  generatedAt: '2026-04-18T13:00:00.000Z',
  totalScraped: 10,
  totalIncluded: 0,
  articles: [],
};

// ── buildSubject ───────────────────────────────────────────────────────────────

describe('buildSubject', () => {
  it('includes the digest date', () => {
    expect(buildSubject(SAMPLE_DIGEST)).toContain('2026-04-18');
  });

  it('includes the article count', () => {
    expect(buildSubject(SAMPLE_DIGEST)).toContain('3');
  });

  it('uses plural "items" for count > 1', () => {
    expect(buildSubject(SAMPLE_DIGEST)).toContain('items');
  });

  it('uses singular "item" for count = 1', () => {
    const single = { ...SAMPLE_DIGEST, totalIncluded: 1 };
    expect(buildSubject(single)).toContain('1 item');
    expect(buildSubject(single)).not.toContain('items');
  });

  it('includes the digest name', () => {
    expect(buildSubject(SAMPLE_DIGEST)).toContain('AI Security Digest');
  });
});

// ── buildText ──────────────────────────────────────────────────────────────────

describe('buildText', () => {
  const text = buildText(SAMPLE_DIGEST);

  it('includes the date', () => {
    expect(text).toContain('2026-04-18');
  });

  it('includes all article titles', () => {
    for (const a of SAMPLE_DIGEST.articles) {
      expect(text).toContain(a.title);
    }
  });

  it('includes severity labels', () => {
    expect(text).toContain('[CRITICAL]');
    expect(text).toContain('[HIGH]');
    expect(text).toContain('[MEDIUM]');
  });

  it('includes category short labels', () => {
    expect(text).toContain('[BEDROCK]');
    expect(text).toContain('[AI]');
    expect(text).toContain('[AWS]');
  });

  it('includes article URLs', () => {
    expect(text).toContain('https://example.com/article');
  });

  it('includes affected products when present', () => {
    expect(text).toContain('AWS Bedrock');
    expect(text).toContain('Agent Core SDK');
  });

  it('does not include "Affected:" line when products list is empty', () => {
    const lines = text.split('\n');
    const jailbreakIndex = lines.findIndex((l) => l.includes('LLM Jailbreak Research'));
    // The line after the jailbreak article summary should not be "Affected:"
    const snippet = lines.slice(jailbreakIndex, jailbreakIndex + 5).join('\n');
    expect(snippet).not.toContain('Affected:');
  });

  it('includes a footer with update instructions', () => {
    expect(text).toContain('/ai-security-digest/recipients');
  });

  it('handles empty digest without throwing', () => {
    expect(() => buildText(EMPTY_DIGEST)).not.toThrow();
  });
});

// ── buildHtml ──────────────────────────────────────────────────────────────────

describe('buildHtml', () => {
  const html = buildHtml(SAMPLE_DIGEST);

  it('is a valid HTML string with doctype', () => {
    expect(html.trim()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('includes the digest date', () => {
    expect(html).toContain('2026-04-18');
  });

  it('includes totalIncluded and totalScraped counts', () => {
    expect(html).toContain('3');
    expect(html).toContain('42');
  });

  it('includes all article titles', () => {
    for (const a of SAMPLE_DIGEST.articles) {
      expect(html).toContain(a.title);
    }
  });

  it('includes article URLs as links', () => {
    expect(html).toContain('href="https://example.com/article"');
    expect(html).toContain('href="https://example.com/s3"');
  });

  it('includes severity badge text', () => {
    expect(html).toContain('CRITICAL');
    expect(html).toContain('HIGH');
    expect(html).toContain('MEDIUM');
  });

  it('includes category badge text', () => {
    expect(html).toContain('BEDROCK');
    expect(html).toContain('AI');
    expect(html).toContain('AWS');
  });

  it('includes article summaries', () => {
    expect(html).toContain('A two-sentence summary of the security finding');
  });

  it('includes affected products when present', () => {
    expect(html).toContain('AWS Bedrock');
    expect(html).toContain('Agent Core SDK');
  });

  it('includes severity border colors in article rows', () => {
    // CRITICAL is #dc2626
    expect(html).toContain('#dc2626');
    // HIGH is #ea580c
    expect(html).toContain('#ea580c');
  });

  it('includes a footer with update instructions', () => {
    expect(html).toContain('/ai-security-digest/recipients');
  });

  it('handles empty digest without throwing', () => {
    expect(() => buildHtml(EMPTY_DIGEST)).not.toThrow();
  });

  it('has closing html tag', () => {
    expect(html).toContain('</html>');
  });
});
