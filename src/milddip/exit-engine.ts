/**
 * Pure helpers for mild-dip mark/exit scheduling.
 * Keep I/O (Dex / Jupiter / ATA) out of this module so unit tests stay offline.
 */
import type { MildDipExitGates, MildDipVolFadeSample } from './gates.js';
import { evaluateMildDipPeakGiveback, type MildDipExitReason } from './gates.js';
import type { MildDipOpenPosition } from './state.js';

export type MarkExitDecision = {
  mint: string;
  markPriceUsd: number;
  /** Movement baseline once latched; null while the fill still serves. */
  mfeBasisPriceUsd: number | null;
  peakPriceUsd: number;
  armed: boolean;
  justArmed: boolean;
  shouldExit: boolean;
  /** 1 = full close; (0,1) = scale-out leave runner. */
  fraction: number;
  reason: MildDipExitReason;
  mfePct: number;
  givebackPct: number;
  pnlPct: number;
  /** Updated spaced vol5m ring — caller persists onto the open position. */
  volFadeSamples: MildDipVolFadeSample[];
  /** Updated post-entry low-water mark. */
  postEntryTroughPriceUsd: number;
  postEntryTroughAtMs: number;
};

/** Armed positions first (trail can fire), then older opens. */
export function orderMintsForMark(open: Record<string, MildDipOpenPosition>): string[] {
  return Object.keys(open).sort((a, b) => {
    const pa = open[a];
    const pb = open[b];
    const aa = pa?.trailArmed === true ? 1 : 0;
    const ab = pb?.trailArmed === true ? 1 : 0;
    if (aa !== ab) return ab - aa;
    return (pa?.openedAtMs ?? 0) - (pb?.openedAtMs ?? 0);
  });
}

/**
 * 1.11.794 — background Dex→ring refresh order: blind / oldest ring age first.
 * Exit decisions stay armed-first (`orderMintsForMark`); refresh must not let a
 * handful of armed bags hog `maxInFlight` while new opens sit mark-null forever
 * (no arm / no mfe_bank TP).
 */
export function orderMintsForDexRefresh(args: {
  mints: string[];
  nowMs: number;
  ringAgeMs: (mint: string, nowMs: number) => number;
}): string[] {
  return [...args.mints].sort((a, b) => {
    const aa = args.ringAgeMs(a, args.nowMs);
    const ab = args.ringAgeMs(b, args.nowMs);
    if (aa !== ab) return ab - aa; // older / missing first
    return a.localeCompare(b);
  });
}

/**
 * Apply one mark to a position snapshot. Returns null if mark unusable.
 * Does not mutate `pos` — caller merges fields.
 */
export function decideMarkExit(args: {
  mint: string;
  pos: MildDipOpenPosition;
  markPriceUsd: number;
  gates: MildDipExitGates;
  nowMs?: number;
  /** Live Dex pc5m % for never-arm HELD+PC+SL. */
  pc5mPct?: number | null;
  /** Current 5m Dex volume — enables the activity-fade never-arm exit. */
  volume5mUsd?: number | null;
  /** Defer soft giveback exits while oneshot emptied-bag dump grace is active. */
  oneshotDumpGraceActive?: boolean;
}): MarkExitDecision | null {
  const { mint, pos, markPriceUsd, gates } = args;
  if (!(markPriceUsd > 0) || !(pos.entryPriceUsd > 0)) return null;
  const peakPrev =
    pos.peakPriceUsd != null && pos.peakPriceUsd > 0 ? pos.peakPriceUsd : pos.entryPriceUsd;
  const nowMs = args.nowMs ?? Date.now();
  const heldMs = Math.max(0, nowMs - (pos.openedAtMs > 0 ? pos.openedAtMs : nowMs));
  const stageRaw = Number(pos.mfeBankStage);
  const mfeBankStage = Number.isFinite(stageRaw)
    ? Math.max(0, Math.min(2, Math.floor(stageRaw)))
    : pos.scaleOutDone === true
      ? 1
      : 0;
  /**
   * First mark after the fill becomes the movement baseline when it sits above
   * the fill — the two prices come from different sources and a stale Dex
   * snapshot otherwise reads as instant profit. Latched once, so a later spike
   * cannot move the baseline up and erase a real gain.
   */
  const mfeBasisPriceUsd =
    pos.mfeBasisPriceUsd != null && pos.mfeBasisPriceUsd > 0
      ? pos.mfeBasisPriceUsd
      : pos.peakPriceUsd == null && markPriceUsd > pos.entryPriceUsd
        ? markPriceUsd
        : null;
  const verdict = evaluateMildDipPeakGiveback({
    entryPriceUsd: pos.entryPriceUsd,
    mfeBasisPriceUsd,
    markPriceUsd,
    peakPriceUsd: peakPrev,
    armed: pos.trailArmed === true,
    scaleOutDone: pos.scaleOutDone === true,
    mfeBankStage,
    gates,
    heldMs,
    nowMs,
    pc5mPct: args.pc5mPct ?? null,
    volume5mUsd: args.volume5mUsd ?? null,
    entryVolume5mUsd: pos.entryVolume5mUsd ?? null,
    volFadeSamples: pos.volFadeSamples ?? null,
    postEntryTroughPriceUsd: pos.postEntryTroughUsd ?? pos.entryPriceUsd,
    postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
    oneshotDumpGraceActive: args.oneshotDumpGraceActive === true,
  });
  /**
   * Dust close — operational, not strategic. Bank/bounce ladders leave $1–2
   * remnants that no price move can make matter (±1.3% of $1.20 is ±$0.02), and
   * they are not free: 8 such bags held 9–23h were burning 43% of all Dex marks
   * (6h census: 22_407 of 51_655, the six largest consumers each ~3_540 marks
   * for a $1–2 bag), starving the mark cadence the trail depends on. Gas to
   * close is $0.011, ~1% of the crumb.
   *
   * Applied after the gate so peak / arm / trough / vol-fade bookkeeping still
   * persists, and never over an exit the gates already chose.
   */
  const dustUsd = gates.dustCloseUsd > 0 ? gates.dustCloseUsd : 0;
  const dustHold = gates.dustCloseMinHoldMs > 0 ? gates.dustCloseMinHoldMs : 0;
  /**
   * Only a *remnant* is dust. The rule was written for bank/bounce leftovers, and
   * `pos.sizeUsd <= dustUsd` alone stopped distinguishing them once the live clip
   * dropped to $2 against a $2 threshold — every whole position then qualified,
   * turning this into an unintended 30-minute max-hold.
   */
  const isRemnant = pos.scaleOutDone === true || mfeBankStage >= 1;
  const dustClose =
    !verdict.shouldExit &&
    dustUsd > 0 &&
    isRemnant &&
    Number.isFinite(pos.sizeUsd) &&
    pos.sizeUsd > 0 &&
    pos.sizeUsd <= dustUsd &&
    heldMs >= dustHold;
  return {
    mint,
    markPriceUsd,
    mfeBasisPriceUsd,
    peakPriceUsd: verdict.peakPriceUsd,
    armed: verdict.armed,
    justArmed: verdict.justArmed,
    shouldExit: dustClose ? true : verdict.shouldExit,
    fraction: dustClose ? 1 : verdict.fraction,
    reason: dustClose ? 'dust_close' : verdict.reason,
    mfePct: verdict.mfePct,
    givebackPct: verdict.givebackPct,
    pnlPct: verdict.pnlPct,
    volFadeSamples: verdict.volFadeSamples,
    postEntryTroughPriceUsd: verdict.postEntryTroughPriceUsd,
    postEntryTroughAtMs: verdict.postEntryTroughAtMs,
  };
}

/** Merge mark decision into live position (peak / arm / vol-fade / trough). */
export function applyMarkDecisionToPosition(
  pos: MildDipOpenPosition,
  decision: MarkExitDecision,
): void {
  pos.peakPriceUsd = decision.peakPriceUsd;
  if (decision.mfeBasisPriceUsd != null && decision.mfeBasisPriceUsd > 0) {
    pos.mfeBasisPriceUsd = decision.mfeBasisPriceUsd;
  }
  pos.trailArmed = decision.armed;
  pos.volFadeSamples = decision.volFadeSamples;
  if (decision.postEntryTroughPriceUsd > 0) {
    pos.postEntryTroughUsd = decision.postEntryTroughPriceUsd;
  }
  if (decision.postEntryTroughAtMs > 0) {
    pos.postEntryTroughAtMs = decision.postEntryTroughAtMs;
  }
}

/**
 * Run async work over `items` with at most `concurrency` in flight.
 * Preserves result order matching `items`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const out = new Array<R>(n);
  if (n === 0) return out;
  const limit = Math.max(1, Math.min(concurrency, n));
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= n) return;
      out[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return out;
}
