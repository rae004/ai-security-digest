import { deduplicateById } from '../../../src/lambda/processor/index';
import type { RawArticle } from '../../../src/lambda/shared/types';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeArticle(id: string, title = `Article ${id}`): RawArticle {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    source: 'Test Source',
    sourceType: 'rss',
    content: 'Some content.',
    publishedAt: '2026-04-18T08:00:00.000Z',
    scrapedAt: '2026-04-18T12:00:00.000Z',
  };
}

// ── deduplicateById ────────────────────────────────────────────────────────────

describe('deduplicateById', () => {
  it('returns all articles when all IDs are unique', () => {
    const articles = [makeArticle('a'), makeArticle('b'), makeArticle('c')];
    expect(deduplicateById(articles)).toHaveLength(3);
  });

  it('removes exact duplicate IDs', () => {
    const articles = [makeArticle('a'), makeArticle('a'), makeArticle('b')];
    const result = deduplicateById(articles);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps the first occurrence when duplicated', () => {
    const first = makeArticle('dup', 'First Title');
    const second = makeArticle('dup', 'Second Title');
    const result = deduplicateById([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('First Title');
  });

  it('handles three or more duplicates of the same ID', () => {
    const articles = [makeArticle('x'), makeArticle('x'), makeArticle('x')];
    const result = deduplicateById(articles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('x');
  });

  it('returns an empty array when given an empty array', () => {
    expect(deduplicateById([])).toEqual([]);
  });

  it('preserves insertion order of first occurrences', () => {
    const articles = [
      makeArticle('c'),
      makeArticle('a'),
      makeArticle('b'),
      makeArticle('a'),
      makeArticle('c'),
    ];
    const result = deduplicateById(articles);
    expect(result.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input array', () => {
    const articles = [makeArticle('a'), makeArticle('a')];
    const original = [...articles];
    deduplicateById(articles);
    expect(articles).toHaveLength(original.length);
  });
});
