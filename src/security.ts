import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookEvent } from './domain/types.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestApiKey(apiKey: string): string {
  return sha256(apiKey);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `v1=${digest}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  suppliedSignature: string,
): boolean {
  return constantTimeEqual(signWebhookPayload(secret, timestamp, rawBody), suppliedSignature);
}

export function requestFingerprint(input: {
  text: string;
  voice: string;
  format: string;
}): string {
  return sha256(
    JSON.stringify({
      text: input.text,
      voice: input.voice,
      format: input.format,
    }),
  );
}

export function webhookEventFingerprint(event: WebhookEvent): string {
  return sha256(
    JSON.stringify({
      eventId: event.eventId,
      type: event.type,
      tenantId: event.tenantId,
      jobId: event.jobId,
      output: event.output ?? null,
      error: event.error ?? null,
    }),
  );
}
