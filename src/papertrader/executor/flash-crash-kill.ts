/**
 * Velocity / post-fill flash crash exit — exits on fast drawdown, not a static % stop from avg.
 */
import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';

const RING_MAX_AGE_MS = 6 * 60_000;
const RING_MAX_SAMPLES = 400;

export interface FlashPriceSample {
  ts: number;
  px: number;
}

export type FlashCrashKillVerdict =
  | { kind: 'none' }
  | { kind: 'block_dca'; untilTs: number; trigger: string }
  | { kind: 'partial'; sellFraction: number; trigger: string }
  | { kind: 'full'; trigger: string };

export interface FlashCrashKillQuoteCtx {
  jupiterPx?: number | null;
  snapshotPx?: number | null;
}

function dropPct(p0: number, p1: number): number {
  if (!(p0 > 0) || !(p1 > 0)) return 0;
  return ((p1 / p0 - 1) * 100);
}

function priceAtOrBefore(samples: FlashPriceSample[], targetTs: number): number | null {
  let best: FlashPriceSample | null = null;
  for (const s of samples) {
    if (s.ts <= targetTs && s.px > 0) best = s;
  }
  return best?.px ?? null;
}

function pruneRing(samples: FlashPriceSample[], now: number): FlashPriceSample[] {
  const cutoff = now - RING_MAX_AGE_MS;
  const pruned = samples.filter((s) => s.ts >= cutoff && s.px > 0);
  if (pruned.length > RING_MAX_SAMPLES) return pruned.slice(pruned.length - RING_MAX_SAMPLES);
  return pruned;
}

export function appendFlashKillPriceSample(ot: OpenTrade, ts: number, px: number): void {
  if (!(px > 0)) return;
  const ring = ot.flashKillPriceRing ?? [];
  ring.push({ ts, px });
  ot.flashKillPriceRing = pruneRing(ring, ts);
}

/** Call after any confirmed buy leg (open / scale_in / dca). */
export function stampFlashKillLastBuyLeg(ot: OpenTrade, marketPrice: number, ts: number): void {
  if (!(marketPrice > 0)) return;
  ot.liveFlashLastBuyLegMarketPx = marketPrice;
  ot.liveFlashLastBuyLegTs = ts;
}

export function markFlashKillDcaBlocked(ot: OpenTrade, cfg: PaperTraderConfig, now: number): void {
  const ms = cfg.flashCrashKillDcaBlockMs;
  if (!(ms > 0)) return;
  const until = now + ms;
  ot.liveFlashDcaBlockedUntilTs = Math.max(ot.liveFlashDcaBlockedUntilTs ?? 0, until);
}

export function isFlashKillDcaBlocked(cfg: PaperTraderConfig, ot: OpenTrade, now: number): boolean {
  if (!cfg.flashCrashKillEnabled) return false;
  const until = ot.liveFlashDcaBlockedUntilTs ?? 0;
  return until > now;
}

function impulseDrop(samples: FlashPriceSample[], now: number, windowMs: number): number | null {
  const pNow = priceAtOrBefore(samples, now);
  const p0 = priceAtOrBefore(samples, now - windowMs);
  if (pNow == null || p0 == null) return null;
  return dropPct(p0, pNow);
}

function postFillDrop(ot: OpenTrade, px: number): number | null {
  const ref = ot.liveFlashLastBuyLegMarketPx;
  const ts = ot.liveFlashLastBuyLegTs;
  if (!(ref != null && ref > 0) || !(ts != null && ts > 0)) return null;
  return dropPct(ref, px);
}

function msSinceLastBuy(now: number, ot: OpenTrade): number | null {
  const ts = ot.liveFlashLastBuyLegTs;
  if (ts == null || !(ts > 0)) return null;
  return Math.max(0, now - ts);
}

/**
 * Aggressive flash-kill profile (1.11.309+). Checks full exits before partial.
 */
export function evaluateFlashCrashKill(
  cfg: PaperTraderConfig,
  ot: OpenTrade,
  now: number,
  exitPx: number,
  quote?: FlashCrashKillQuoteCtx,
): FlashCrashKillVerdict {
  if (!cfg.flashCrashKillEnabled || !(exitPx > 0)) return { kind: 'none' };

  const samples = ot.flashKillPriceRing ?? [];
  const d30 = impulseDrop(samples, now, 30_000);
  const d60 = impulseDrop(samples, now, 60_000);
  const d180 = impulseDrop(samples, now, 180_000);
  const postDrop = postFillDrop(ot, exitPx);
  const sinceBuyMs = msSinceLastBuy(now, ot);

  const full30 = cfg.flashCrashKillDrop30sPct;
  const full60 = cfg.flashCrashKillDrop60sPct;
  const full180 = cfg.flashCrashKillDrop180sPct;
  const warnPct = cfg.flashCrashKillPostDcaWarnPct;
  const fullPostPct = cfg.flashCrashKillPostDcaFullPct;
  const warnWin = cfg.flashCrashKillPostDcaWarnWindowMs;
  const fullWin = cfg.flashCrashKillPostDcaFullWindowMs;

  if (
    sinceBuyMs != null &&
    sinceBuyMs <= fullWin &&
    postDrop != null &&
    postDrop <= fullPostPct * 100
  ) {
    return {
      kind: 'full',
      trigger: `post_fill_${Math.round(fullPostPct * 100)}%/${Math.round(fullWin / 1000)}s (Δ=${postDrop.toFixed(1)}%)`,
    };
  }

  if (d30 != null && d30 <= full30 * 100) {
    return { kind: 'full', trigger: `impulse_${Math.round(full30 * 100)}%/30s (Δ=${d30.toFixed(1)}%)` };
  }
  if (d60 != null && d60 <= full60 * 100) {
    return { kind: 'full', trigger: `impulse_${Math.round(full60 * 100)}%/60s (Δ=${d60.toFixed(1)}%)` };
  }
  if (d180 != null && d180 <= full180 * 100) {
    return { kind: 'full', trigger: `impulse_${Math.round(full180 * 100)}%/180s (Δ=${d180.toFixed(1)}%)` };
  }

  const jup = quote?.jupiterPx;
  const snap = quote?.snapshotPx;
  const disc = cfg.flashCrashKillQuoteMaxDiscountPct;
  if (
    jup != null &&
    snap != null &&
    jup > 0 &&
    snap > 0 &&
    jup <= snap * (1 - disc) &&
    d60 != null &&
    d60 <= cfg.flashCrashKillQuoteDrop60sPct * 100
  ) {
    return {
      kind: 'full',
      trigger: `quote_disc_${Math.round(disc * 100)}%+drop60_${Math.round(cfg.flashCrashKillQuoteDrop60sPct * 100)}% (Δ60=${d60.toFixed(1)}%)`,
    };
  }

  if (
    sinceBuyMs != null &&
    sinceBuyMs <= warnWin &&
    postDrop != null &&
    postDrop <= warnPct * 100
  ) {
    return {
      kind: 'partial',
      sellFraction: cfg.flashCrashKillPartialSellFraction,
      trigger: `post_fill_${Math.round(warnPct * 100)}%/${Math.round(warnWin / 1000)}s (Δ=${postDrop.toFixed(1)}%)`,
    };
  }

  return { kind: 'none' };
}
