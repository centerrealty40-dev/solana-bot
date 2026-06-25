/**
 * In-process Jupiter HTTP 429 burst detector + immediate Telegram (via jupiter-alerts).
 *
 * Env:
 * - `JUPITER_429_BURST_TELEGRAM=0` — disable burst alerts.
 * - `JUPITER_429_BURST_WINDOW_MS` — sliding window (default 60000).
 * - `JUPITER_429_BURST_THRESHOLD` — 429 events in window to fire burst (default 4).
 * - `JUPITER_429_EXHAUST_TELEGRAM=0` — disable per-call exhaustion alerts.
 * - `JUPITER_429_EXHAUST_COOLDOWN_MS` — min gap between exhaustion alerts per source (default 120000).
 */
import {
  notifyJupiter429RateLimitBurst,
  notifyJupiterQuoteRateLimitExhausted,
} from './telegram/jupiter-alerts.js';

export type Jupiter429Source = 'quote' | 'swap' | 'price';

const ring: { ts: number; source: Jupiter429Source }[] = [];
let lastBurstAt = 0;
const lastExhaustAt = new Map<Jupiter429Source, number>();

function burstOn(): boolean {
  return process.env.JUPITER_429_BURST_TELEGRAM !== '0';
}

function exhaustOn(): boolean {
  return process.env.JUPITER_429_EXHAUST_TELEGRAM !== '0';
}

function burstWindowMs(): number {
  return Math.max(
    5_000,
    Math.min(600_000, Number(process.env.JUPITER_429_BURST_WINDOW_MS ?? 60_000)),
  );
}

function burstThreshold(): number {
  return Math.max(1, Math.min(100, Number(process.env.JUPITER_429_BURST_THRESHOLD ?? 4)));
}

function exhaustCooldownMs(): number {
  return Math.max(
    30_000,
    Math.min(3_600_000, Number(process.env.JUPITER_429_EXHAUST_COOLDOWN_MS ?? 120_000)),
  );
}

function pruneRing(now: number): void {
  const cutoff = now - burstWindowMs();
  while (ring.length > 0 && ring[0]!.ts < cutoff) ring.shift();
}

function tierHint(): string {
  const key = process.env.JUPITER_API_KEY?.trim();
  const hasKey = Boolean(key && key.length > 0);
  if (!hasKey) return 'keyless (~0.5 RPS)';
  return 'api-key (tier unknown — Free=1 RPS, Developer $25=10 RPS)';
}

/** Record one HTTP 429 from Jupiter (retry or terminal). Fire Telegram when thresholds hit. */
export function recordJupiter429Event(args: {
  source: Jupiter429Source;
  /** All configured retries exhausted — quote/swap still 429. */
  exhausted?: boolean;
  retriesAttempted?: number;
}): void {
  const now = Date.now();
  ring.push({ ts: now, source: args.source });
  pruneRing(now);

  if (args.exhausted && exhaustOn()) {
    const cd = exhaustCooldownMs();
    const last = lastExhaustAt.get(args.source) ?? 0;
    if (now - last >= cd) {
      lastExhaustAt.set(args.source, now);
      void notifyJupiterQuoteRateLimitExhausted({
        source: args.source,
        retriesAttempted: args.retriesAttempted ?? 0,
        eventsInWindow: ring.length,
        tierHint: tierHint(),
      });
    }
  }

  const threshold = burstThreshold();
  if (!burstOn() || ring.length < threshold) return;
  const windowMs = burstWindowMs();
  const burstCooldownMs = Math.max(
    windowMs,
    Number(process.env.JUPITER_429_BURST_COOLDOWN_MS ?? 300_000),
  );
  if (now - lastBurstAt < burstCooldownMs) return;
  lastBurstAt = now;

  const bySource: Record<Jupiter429Source, number> = { quote: 0, swap: 0, price: 0 };
  for (const e of ring) bySource[e.source] += 1;

  void notifyJupiter429RateLimitBurst({
    eventsInWindow: ring.length,
    windowMs,
    bySource,
    tierHint: tierHint(),
  });
}

/** Test helper — reset in-process counters. */
export function resetJupiter429MonitorForTests(): void {
  ring.length = 0;
  lastBurstAt = 0;
  lastExhaustAt.clear();
}
