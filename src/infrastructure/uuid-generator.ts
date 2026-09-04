import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../domain/types.js';

export class UuidGenerator implements IdGenerator {
  public next(): string {
    return `job_${randomUUID()}`;
  }
}
