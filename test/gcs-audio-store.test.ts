import { describe, expect, it } from 'vitest';
import type { GcsClient } from '../src/infrastructure/gcs-audio-store.js';
import { GcsAudioStore } from '../src/infrastructure/gcs-audio-store.js';

describe('GcsAudioStore', () => {
  it('maps tenant audio to an immutable, private Google Cloud Storage object', async () => {
    let capturedName = '';
    let capturedOptions: unknown;
    const client: GcsClient = {
      bucket: (bucketName) => {
        expect(bucketName).toBe('speech-audio-test');
        return {
          file: (objectName) => {
            capturedName = objectName;
            return {
              save: (_content, options) => {
                capturedOptions = options;
                return Promise.resolve();
              },
            };
          },
        };
      },
    };
    const store = new GcsAudioStore('speech-audio-test', client);
    const digest = 'c'.repeat(64);

    const result = await store.put({
      tenantId: 'tenant_acme',
      jobId: 'job_123',
      format: 'mp3',
      content: new Uint8Array([1, 2, 3]),
      sha256: digest,
    });

    expect(capturedName).toBe(`tenant_acme/speech-jobs/job_123/${digest}.mp3`);
    expect(capturedOptions).toMatchObject({
      resumable: false,
      contentType: 'audio/mpeg',
      metadata: { cacheControl: 'private, max-age=0, no-store' },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    expect(result.artifactUri).toBe(`gs://speech-audio-test/${capturedName}`);
  });

  it('rejects unsafe object path segments and malformed digests', async () => {
    const client: GcsClient = {
      bucket: () => ({ file: () => ({ save: () => Promise.resolve() }) }),
    };
    const store = new GcsAudioStore('bucket', client);
    const base = {
      tenantId: 'tenant_acme',
      jobId: 'job_123',
      format: 'wav' as const,
      content: new Uint8Array(),
      sha256: 'd'.repeat(64),
    };

    await expect(store.put({ ...base, tenantId: '../escape' })).rejects.toThrow('unsafe');
    await expect(store.put({ ...base, sha256: 'not-a-digest' })).rejects.toThrow('sha256');
  });
});
