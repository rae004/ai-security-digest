import { buildUserMessage, parseAnalysis, SYSTEM_PROMPT } from '../../../src/lambda/processor/prompt';
import type { RawArticle } from '../../../src/lambda/shared/types';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BASE_ARTICLE: RawArticle = {
  id: 'abc123',
  title: 'Critical RCE in AWS Bedrock Agent Core SDK',
  url: 'https://example.com/bedrock-rce',
  source: 'Krebs on Security',
  sourceType: 'rss',
  content: 'A critical remote code execution vulnerability has been discovered in the Bedrock Agent Core SDK. Attackers can execute arbitrary code via a malformed tool-call response.',
  publishedAt: '2026-04-18T08:00:00.000Z',
  scrapedAt: '2026-04-18T12:00:00.000Z',
};

const VALID_RESPONSE = JSON.stringify({
  summary: 'A critical RCE vulnerability in AWS Bedrock Agent Core SDK allows attackers to execute arbitrary code. All versions prior to 1.2.3 are affected.',
  severity: 'CRITICAL',
  relevance_category: 'BEDROCK_AGENTCORE',
  relevance_score: 98,
  reasoning: 'Direct RCE in Bedrock Agent Core is highest severity and directly in scope.',
  affected_products: ['AWS Bedrock', 'Agent Core SDK'],
});

// ── SYSTEM_PROMPT ──────────────────────────────────────────────────────────────

describe('SYSTEM_PROMPT', () => {
  it('contains all five severity levels', () => {
    expect(SYSTEM_PROMPT).toContain('CRITICAL');
    expect(SYSTEM_PROMPT).toContain('HIGH');
    expect(SYSTEM_PROMPT).toContain('MEDIUM');
    expect(SYSTEM_PROMPT).toContain('LOW');
    expect(SYSTEM_PROMPT).toContain('INFO');
  });

  it('contains all four relevance categories', () => {
    expect(SYSTEM_PROMPT).toContain('BEDROCK_AGENTCORE');
    expect(SYSTEM_PROMPT).toContain('AI_GENERAL');
    expect(SYSTEM_PROMPT).toContain('AWS_SECURITY');
    expect(SYSTEM_PROMPT).toContain('OTHER');
  });

  it('is a non-empty string', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});

// ── buildUserMessage ───────────────────────────────────────────────────────────

describe('buildUserMessage', () => {
  const msg = buildUserMessage(BASE_ARTICLE);

  it('includes the article title', () => {
    expect(msg).toContain(BASE_ARTICLE.title);
  });

  it('includes the source and sourceType', () => {
    expect(msg).toContain(BASE_ARTICLE.source);
    expect(msg).toContain(BASE_ARTICLE.sourceType);
  });

  it('includes the URL', () => {
    expect(msg).toContain(BASE_ARTICLE.url);
  });

  it('includes the content', () => {
    expect(msg).toContain('remote code execution');
  });

  it('truncates content to 4000 characters maximum', () => {
    const longContent = 'x'.repeat(8000);
    const bigArticle = { ...BASE_ARTICLE, content: longContent };
    const output = buildUserMessage(bigArticle);
    // The content part should be truncated; the total message will be longer due to
    // title/source/url lines, but content itself is capped at 4000
    expect(output).not.toContain('x'.repeat(4001));
  });
});

// ── parseAnalysis — happy path ─────────────────────────────────────────────────

describe('parseAnalysis (valid response)', () => {
  const result = parseAnalysis(BASE_ARTICLE, VALID_RESPONSE);

  it('preserves original article fields', () => {
    expect(result.id).toBe(BASE_ARTICLE.id);
    expect(result.url).toBe(BASE_ARTICLE.url);
    expect(result.sourceType).toBe(BASE_ARTICLE.sourceType);
    expect(result.publishedAt).toBe(BASE_ARTICLE.publishedAt);
  });

  it('maps summary correctly', () => {
    expect(result.summary).toContain('RCE vulnerability');
  });

  it('maps severity correctly', () => {
    expect(result.severity).toBe('CRITICAL');
  });

  it('maps relevance category correctly', () => {
    expect(result.relevance.category).toBe('BEDROCK_AGENTCORE');
  });

  it('maps relevance score correctly', () => {
    expect(result.relevance.score).toBe(98);
  });

  it('maps reasoning correctly', () => {
    expect(result.relevance.reasoning).toContain('Bedrock Agent Core');
  });

  it('maps affected products correctly', () => {
    expect(result.affectedProducts).toEqual(['AWS Bedrock', 'Agent Core SDK']);
  });
});

// ── parseAnalysis — edge cases ─────────────────────────────────────────────────

describe('parseAnalysis (edge cases)', () => {
  it('strips markdown code fences before parsing', () => {
    const wrapped = '```json\n' + VALID_RESPONSE + '\n```';
    const result = parseAnalysis(BASE_ARTICLE, wrapped);
    expect(result.severity).toBe('CRITICAL');
  });

  it('falls back gracefully on invalid JSON', () => {
    const result = parseAnalysis(BASE_ARTICLE, 'not json at all');
    expect(result.severity).toBe('INFO');
    expect(result.relevance.category).toBe('OTHER');
    expect(result.relevance.score).toBe(0);
    expect(result.affectedProducts).toEqual([]);
  });

  it('clamps relevance_score to 0–100', () => {
    const over = parseAnalysis(BASE_ARTICLE, JSON.stringify({ ...JSON.parse(VALID_RESPONSE), relevance_score: 150 }));
    expect(over.relevance.score).toBe(100);

    const under = parseAnalysis(BASE_ARTICLE, JSON.stringify({ ...JSON.parse(VALID_RESPONSE), relevance_score: -10 }));
    expect(under.relevance.score).toBe(0);
  });

  it('defaults severity to LOW for unrecognised value', () => {
    const bad = parseAnalysis(BASE_ARTICLE, JSON.stringify({ ...JSON.parse(VALID_RESPONSE), severity: 'EXTREME' }));
    expect(bad.severity).toBe('LOW');
  });

  it('defaults category to OTHER for unrecognised value', () => {
    const bad = parseAnalysis(BASE_ARTICLE, JSON.stringify({ ...JSON.parse(VALID_RESPONSE), relevance_category: 'UNKNOWN' }));
    expect(bad.relevance.category).toBe('OTHER');
  });

  it('handles missing affected_products gracefully', () => {
    const noProducts = JSON.parse(VALID_RESPONSE) as Record<string, unknown>;
    delete noProducts['affected_products'];
    const result = parseAnalysis(BASE_ARTICLE, JSON.stringify(noProducts));
    expect(result.affectedProducts).toEqual([]);
  });

  it('filters non-string entries from affected_products', () => {
    const mixed = { ...JSON.parse(VALID_RESPONSE), affected_products: ['ValidProduct', 42, null, 'Another'] };
    const result = parseAnalysis(BASE_ARTICLE, JSON.stringify(mixed));
    expect(result.affectedProducts).toEqual(['ValidProduct', 'Another']);
  });
});
