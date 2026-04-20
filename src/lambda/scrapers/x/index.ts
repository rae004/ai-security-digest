import type { ScrapeResult } from '../../shared/types';

interface ScraperEvent {
  date?: string;
}

// X (Twitter) scraper — requires a paid X API v2 key stored in Secrets Manager.
// Disabled by default in sources.json. This stub always returns 0 articles
// so the Step Functions state machine can still run without the X integration.
export const handler = async (_event: ScraperEvent): Promise<ScrapeResult> => {
  return {
    sourceType: 'x',
    s3Key: '',
    articleCount: 0,
    errors: ['X scraper is not enabled. Set enabled:true in sources.json and configure X_API_KEY in Secrets Manager to activate.'],
  };
};
