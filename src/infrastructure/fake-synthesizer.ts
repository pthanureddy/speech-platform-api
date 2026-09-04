import type { SpeechJob, SpeechOutput, Synthesizer } from '../domain/types.js';
import { sha256 } from '../security.js';

/** A deterministic local substitute for an external speech provider. */
export class FakeSynthesizer implements Synthesizer {
  public async synthesize(job: SpeechJob): Promise<SpeechOutput> {
    const digest = sha256(`${job.voice}\u0000${job.format}\u0000${job.text}`);
    return Promise.resolve({
      artifactUri: `memory://synthesis/${digest}.${job.format}`,
      sha256: digest,
      durationMs: Math.max(250, job.characterCount * 45),
    });
  }
}
