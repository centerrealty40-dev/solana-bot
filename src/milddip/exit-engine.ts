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
  const verdict = evaluateMildDipPeakGiveback({
    entryPriceUsd: pos.entryPriceUsd,
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
  return {
    mint,
    markPriceUsd,
    peakPriceUsd: verdict.peakPriceUsd,
    armed: verdict.armed,
    justArmed: verdict.justArmed,
    shouldExit: verdict.shouldExit,
    fraction: verdict.fraction,
    reason: verdict.reason,
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
