// ── Mock AWS S3 SDK before importing s3-client ─────────────────────────────────

const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { getJsonFromS3, putJsonToS3 } from '../../../src/lambda/shared/s3-client';

// ── getJsonFromS3 ─────────────────────────────────────────────────────────────

describe('getJsonFromS3', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('parses and returns JSON from S3 object body', async () => {
    const payload = { foo: 'bar', count: 42 };
    mockS3Send.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify(payload) },
    });

    const result = await getJsonFromS3<typeof payload>('my-bucket', 'path/to/file.json');
    expect(result).toEqual(payload);
  });

  it('calls GetObjectCommand with the correct Bucket and Key', async () => {
    mockS3Send.mockResolvedValue({
      Body: { transformToString: async () => '[]' },
    });

    await getJsonFromS3('test-bucket', 'some/key.json');

    const { GetObjectCommand } = jest.requireMock('@aws-sdk/client-s3') as {
      GetObjectCommand: jest.Mock;
    };
    expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'test-bucket', Key: 'some/key.json' });
  });

  it('throws when the response body is empty', async () => {
    mockS3Send.mockResolvedValue({
      Body: { transformToString: async () => '' },
    });

    await expect(getJsonFromS3('bucket', 'key')).rejects.toThrow('Empty response from s3://bucket/key');
  });

  it('throws when Body is undefined', async () => {
    mockS3Send.mockResolvedValue({ Body: undefined });

    await expect(getJsonFromS3('bucket', 'key')).rejects.toThrow('Empty response from s3://bucket/key');
  });

  it('re-throws S3 errors', async () => {
    mockS3Send.mockRejectedValue(new Error('NoSuchKey'));

    await expect(getJsonFromS3('bucket', 'missing-key')).rejects.toThrow('NoSuchKey');
  });

  it('parses JSON arrays correctly', async () => {
    const arr = [1, 2, 3];
    mockS3Send.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify(arr) },
    });

    const result = await getJsonFromS3<number[]>('b', 'k');
    expect(result).toEqual([1, 2, 3]);
  });
});

// ── putJsonToS3 ───────────────────────────────────────────────────────────────

describe('putJsonToS3', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls PutObjectCommand with serialised JSON and correct content-type', async () => {
    mockS3Send.mockResolvedValue({});

    const data = { hello: 'world' };
    await putJsonToS3('my-bucket', 'output/file.json', data);

    const { PutObjectCommand } = jest.requireMock('@aws-sdk/client-s3') as {
      PutObjectCommand: jest.Mock;
    };
    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: 'my-bucket',
      Key: 'output/file.json',
      Body: JSON.stringify(data),
      ContentType: 'application/json',
    });
  });

  it('resolves without error on success', async () => {
    mockS3Send.mockResolvedValue({});
    await expect(putJsonToS3('bucket', 'key', { x: 1 })).resolves.not.toThrow();
  });

  it('re-throws S3 put errors', async () => {
    mockS3Send.mockRejectedValue(new Error('AccessDenied'));

    await expect(putJsonToS3('bucket', 'key', {})).rejects.toThrow('AccessDenied');
  });

  it('serialises arrays to JSON correctly', async () => {
    mockS3Send.mockResolvedValue({});

    await putJsonToS3('bucket', 'key', ['a', 'b', 'c']);

    const { PutObjectCommand } = jest.requireMock('@aws-sdk/client-s3') as {
      PutObjectCommand: jest.Mock;
    };
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Body: '["a","b","c"]' }),
    );
  });
});
