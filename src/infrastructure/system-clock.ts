import type { Clock } from '../domain/types.js';

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}
