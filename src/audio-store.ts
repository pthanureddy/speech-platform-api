import type { AudioFormat } from './domain/types.js';

export interface StoreAudioCommand {
  tenantId: string;
  jobId: string;
  format: AudioFormat;
  content: Uint8Array;
  sha256: string;
}

export interface StoredAudio {
  artifactUri: string;
  objectName: string;
}

export interface AudioStore {
  put(command: StoreAudioCommand): Promise<StoredAudio>;
}
