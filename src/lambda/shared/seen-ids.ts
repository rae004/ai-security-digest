import { getJsonFromS3, putJsonToS3 } from './s3-client';

const SEEN_IDS_PREFIX = 'sent-ids';
const SEEN_IDS_LOOKBACK_DAYS = 7;

export async function loadSeenIds(
  bucket: string,
  date: string,
  lookbackDays = SEEN_IDS_LOOKBACK_DAYS,
): Promise<Set<string>> {
  const seen = new Set<string>();
  const base = new Date(`${date}T00:00:00Z`);

  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    const key = `${SEEN_IDS_PREFIX}/${d.toISOString().slice(0, 10)}.json`;
    try {
      const ids = await getJsonFromS3<string[]>(bucket, key);
      ids.forEach((id) => seen.add(id));
    } catch {
      // No sent-ids file for this date — first run or no digest that day
    }
  }

  return seen;
}

export async function saveSeenIds(
  bucket: string,
  date: string,
  ids: string[],
): Promise<void> {
  await putJsonToS3(bucket, `${SEEN_IDS_PREFIX}/${date}.json`, ids);
}
