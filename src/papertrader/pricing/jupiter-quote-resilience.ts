/**
 * W7.4.1 — Jupiter lite-api quote retries (exponential backoff) + sliding-window circuit breaker
 * when transport-level `skipped` rate exceeds a threshold (spec: >10% over 30 min).
 */
import { child } from '../../core/logger.js';
import type { PriceVerifyVerdict } from '../types.js';

const log = child('jupiter-quote-resilience');

export interface QuoteResilience {
  retriesEnabled: boolean;
  maxAttempts: number;
  retryBackoffMs: number;
  circuitEnabled: boolean;
  circuitWindowMs: number;
  circuitSkipRatePct: number;
  circuitMinAttempts: number;
  circuitCooldownMs: number;
}

type RingEvent = { ts: number; ok: boolean };
const ring: RingEvent[] = [];
let circuitOpenUntil = 0;

/** Vitest / isolated runs — clears breaker state. */
export function resetQuoteResilienceForTests(): void {
  ring.length = 0;
  circuitOpenUntil = 0;
}

export function isRetryableQuoteReason(reason: string): boolean {
  return (
    reason === 'http-error' ||
    reason === 'timeout' ||
    reason === 'fetch-fail' ||
    reason === 'parse-error'
  );
}

function prune(minTs: number): void {
  while (ring.length && ring[0]!.ts < minTs) ring.shift();
}

/** Before Jupiter HTTP — short-circuit if breaker is open. */
export function gateCircuit(
  resilience: QuoteResilience | undefined | null,
  now = Date.now(),
): PriceVerifyVerdict | null {
  if (!resilience?.circuitEnabled) return null;
  if (now < circuitOpenUntil) {
    return { kind: 'skipped', reason: 'circuit-open', ts: now };
  }
  return null;
}

/**
 * Record one logical quote outcome for breaker stats (only when circuitEnabled).
 * `ok` = received a parseable Jupiter response leading to `ok` or `blocked` verdict (route sanity).
 * `ok=false` = exhausted retries with transport `skipped` or raw fetch failure for quote helpers.
 */
export function recordTransportResult(
  ok: boolean,
  resilience: QuoteResilience | undefined | null,
  now = Date.now(),
): void {
  if (!resilience?.circuitEnabled) return;
  prune(now - resilience.circuitWindowMs);
  ring.push({ ts: now, ok });
  const n = ring.length;
  if (n < resilience.circuitMinAttempts) return;
  const fails = ring.filter((e) => !e.ok).length;
  const pct = (fails / n) * 100;
  if (pct > resilience.circuitSkipRatePct) {
    circuitOpenUntil = now + resilience.circuitCooldownMs;
    log.warn(
      { fails, n, pct, cooldownMs: resilience.circuitCooldownMs },
      'jupiter quote circuit breaker open',
    );
  }
}

export async function sleepBackoff(baseMs: number, attemptIndex: number): Promise<void> {
  const ms = Math.min(30_000, Math.max(0, baseMs * 2 ** attemptIndex));
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}
