import { randomUUID } from 'node:crypto';

/** RFC 9562 UUID v4 for `intentId` (W8.0-p1 §3.3). */
export function newLiveIntentId(): string {
  return randomUUID().toLowerCase();
}
