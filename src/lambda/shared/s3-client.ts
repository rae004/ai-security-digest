import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export async function getJsonFromS3<T>(bucket: string, key: string): Promise<T> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await resp.Body?.transformToString();
  if (!body) throw new Error(`Empty response from s3://${bucket}/${key}`);
  return JSON.parse(body) as T;
}

export async function putJsonToS3(bucket: string, key: string, data: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: 'application/json',
    }),
  );
}
