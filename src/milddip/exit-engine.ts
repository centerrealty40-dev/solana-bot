/**
 * Pure helpers for mild-dip mark/exit scheduling.
 * Keep I/O (Dex / Jupiter / ATA) out of this module so unit tests stay offline.
 */
import type { MildDipExitGates } from './gates.js';
import { evaluateMildDipPeakGiveback, type MildDipExitReason } from './gates.js';
import type { MildDipOpenPosition } from './state.js';

export type MarkExitDecision = {
  mint: string;
  markPriceUsd: number;
  peakPriceUsd: number;
  armed: boolean;
  justArmed: boolean;
  shouldExit: boolean;
  reason: MildDipExitReason;
  mfePct: number;
  givebackPct: number;
  pnlPct: number;
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
 * Apply one mark to a position snapshot. Returns null if mark unusable.
 * Does not mutate `pos` — caller merges fields.
 */
export function decideMarkExit(args: {
  mint: string;
  pos: MildDipOpenPosition;
  markPriceUsd: number;
  gates: MildDipExitGates;
  nowMs?: number;
  /** Current 5m Dex volume — enables the activity-fade never-arm exit. */
  volume5mUsd?: number | null;
}): MarkExitDecision | null {
  const { mint, pos, markPriceUsd, gates } = args;
  if (!(markPriceUsd > 0) || !(pos.entryPriceUsd > 0)) return null;
  const peakPrev =
    pos.peakPriceUsd != null && pos.peakPriceUsd > 0 ? pos.peakPriceUsd : pos.entryPriceUsd;
  const nowMs = args.nowMs ?? Date.now();
  const heldMs = Math.max(0, nowMs - (pos.openedAtMs > 0 ? pos.openedAtMs : nowMs));
  const verdict = evaluateMildDipPeakGiveback({
    entryPriceUsd: pos.entryPriceUsd,
    markPriceUsd,
    peakPriceUsd: peakPrev,
    armed: pos.trailArmed === true,
    gates,
    heldMs,
    volume5mUsd: args.volume5mUsd ?? null,
    entryVolume5mUsd: pos.entryVolume5mUsd ?? null,
  });
  return {
    mint,
    markPriceUsd,
    peakPriceUsd: verdict.peakPriceUsd,
    armed: verdict.armed,
    justArmed: verdict.justArmed,
    shouldExit: verdict.shouldExit,
    reason: verdict.reason,
    mfePct: verdict.mfePct,
    givebackPct: verdict.givebackPct,
    pnlPct: verdict.pnlPct,
  };
}

/** Merge mark decision into live position (peak / arm only). */
export function applyMarkDecisionToPosition(
  pos: MildDipOpenPosition,
  decision: MarkExitDecision,
): void {
  pos.peakPriceUsd = decision.peakPriceUsd;
  pos.trailArmed = decision.armed;
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
