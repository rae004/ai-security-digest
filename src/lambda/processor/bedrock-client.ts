import {
  BedrockRuntimeClient,
  ConverseCommand,
  ThrottlingException,
} from '@aws-sdk/client-bedrock-runtime';

export const MODEL_ID = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function invokeModel(systemPrompt: string, userMessage: string): Promise<string> {
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await client.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: systemPrompt }],
          messages: [{ role: 'user', content: [{ text: userMessage }] }],
          inferenceConfig: {
            maxTokens: 1024,
            temperature: 0, // deterministic — we want consistent JSON
          },
        }),
      );

      const text = resp.output?.message?.content?.[0]?.text ?? '';
      if (!text) throw new Error('Empty response from Bedrock');
      return text;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (err instanceof ThrottlingException && attempt < MAX_RETRIES - 1) {
        // Exponential back-off: 2 s, 4 s, 8 s
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr ?? new Error('Bedrock invocation failed after retries');
}
