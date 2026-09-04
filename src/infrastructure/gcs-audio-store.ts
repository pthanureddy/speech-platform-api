import { Storage } from '@google-cloud/storage';
import type { AudioStore, StoreAudioCommand, StoredAudio } from '../audio-store.js';

interface ObjectSaveOptions {
  resumable: boolean;
  contentType: string;
  metadata: {
    cacheControl: string;
    metadata: Record<string, string>;
  };
  preconditionOpts: { ifGenerationMatch: number };
}

export interface GcsObject {
  save(content: Uint8Array, options: ObjectSaveOptions): Promise<unknown>;
}

export interface GcsBucket {
  file(objectName: string): GcsObject;
}

export interface GcsClient {
  bucket(bucketName: string): GcsBucket;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} contains characters that are unsafe in an object name.`);
  }
  return value;
}

/**
 * Optional immutable Google Cloud Storage adapter.
 *
 * The app does not instantiate this adapter by default. Production worker code
 * can inject it at the AudioStore boundary after synthesis yields audio bytes.
 */
export class GcsAudioStore implements AudioStore {
  public constructor(
    private readonly bucketName: string,
    private readonly client: GcsClient,
  ) {
    if (bucketName.trim().length === 0) {
      throw new Error('A Google Cloud Storage bucket name is required.');
    }
  }

  public async put(command: StoreAudioCommand): Promise<StoredAudio> {
    const tenantId = safeSegment(command.tenantId, 'tenantId');
    const jobId = safeSegment(command.jobId, 'jobId');
    if (!/^[a-f0-9]{64}$/.test(command.sha256)) {
      throw new Error('sha256 must be a lowercase hexadecimal SHA-256 digest.');
    }

    const objectName = `${tenantId}/speech-jobs/${jobId}/${command.sha256}.${command.format}`;
    const object = this.client.bucket(this.bucketName).file(objectName);
    await object.save(command.content, {
      resumable: false,
      contentType: command.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      metadata: {
        cacheControl: 'private, max-age=0, no-store',
        metadata: {
          tenantId,
          jobId,
          sha256: command.sha256,
        },
      },
      // Immutable create: a repeated worker delivery cannot overwrite audio.
      preconditionOpts: { ifGenerationMatch: 0 },
    });

    return { artifactUri: `gs://${this.bucketName}/${objectName}`, objectName };
  }
}

export function createGoogleCloudStorageAudioStore(bucketName: string): GcsAudioStore {
  // The narrow injected interface keeps unit tests credential-free.
  return new GcsAudioStore(bucketName, new Storage());
}
