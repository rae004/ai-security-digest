/**
 * Golden-set classification eval — makes REAL Bedrock calls (real cost, real network).
 *
 * Runs the golden regression articles (test/fixtures/golden-articles.ts) through the
 * actual processor prompt/model pipeline and checks whether `relevance.category` still
 * matches the deterministically-correct expected category. Unlike the mocked unit tests,
 * this catches prompt regressions the model itself introduces (see PR #100) — nothing in
 * the mocked test suite can detect the model rationalizing its way into a wrong category.
 *
 * Usage: npm run eval:golden
 * Requires Bedrock InvokeModel credentials for MODEL_ID in the current AWS profile/env.
 */
import { GOLDEN_ARTICLES, type GoldenArticle } from '../test/fixtures/golden-articles';
import { invokeModel, MODEL_ID } from '../src/lambda/processor/bedrock-client';
import { buildUserMessage, parseAnalysis, SYSTEM_PROMPT } from '../src/lambda/processor/prompt';
import type { AnalyzedArticle } from '../src/lambda/shared/types';

const BATCH_SIZE = 10; // mirrors src/lambda/processor/index.ts

interface EvalResult {
  article: GoldenArticle;
  actual: AnalyzedArticle;
  pass: boolean;
}

async function analyzeBatch(articles: GoldenArticle[]): Promise<AnalyzedArticle[]> {
  const responseText = await invokeModel(SYSTEM_PROMPT, buildUserMessage(articles));
  return parseAnalysis(articles, responseText);
}

async function runEval(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (let i = 0; i < GOLDEN_ARTICLES.length; i += BATCH_SIZE) {
    const batch = GOLDEN_ARTICLES.slice(i, i + BATCH_SIZE);
    const analyzed = await analyzeBatch(batch);
    batch.forEach((article, j) => {
      const actual = analyzed[j];
      results.push({ article, actual, pass: actual.relevance.category === article.expectedCategory });
    });
  }
  return results;
}

function printReport(results: EvalResult[]): void {
  console.warn(`\nGolden-set classification eval — model=${MODEL_ID}\n`);
  for (const { article, actual, pass } of results) {
    const marker = pass ? 'PASS' : 'FAIL';
    console.warn(`[${marker}] ${article.id}`);
    console.warn(`       title:    ${article.title}`);
    console.warn(`       expected: ${article.expectedCategory}`);
    if (!pass) {
      console.warn(`       actual:   ${actual.relevance.category}`);
      console.warn(`       reasoning: ${actual.relevance.reasoning}`);
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.warn(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    console.warn(`\nFailed: ${failed.map((r) => r.article.id).join(', ')}`);
  }
}

async function main(): Promise<void> {
  const results = await runEval();
  printReport(results);
  if (results.some((r) => !r.pass)) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('Golden-set eval failed to run:', err);
  process.exitCode = 1;
});
