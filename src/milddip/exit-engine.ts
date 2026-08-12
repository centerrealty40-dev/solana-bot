/**
 * Pure helpers for mild-dip mark/exit scheduling.
 * Keep I/O (Dex / Jupiter / ATA) out of this module so unit tests stay offline.
 */
import type { MildDipExitGates, MildDipVolFadeSample } from './gates.js';
import { evaluateMildDipPeakGiveback, type MildDipExitReason } from './gates.js';
import type { MildDipOpenPosition } from './state.js';
import { decideGreenExit, type GreenExitGates } from './green-lane.js';

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
  /** Rung filled by this decision; null unless `reason` is `tp_grid`. */
  tpRungIndex: number | null;
  /** 1.11.852 — mark held back pending confirmation; nothing was decided. */
  markQuarantined?: boolean;
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
  /** Required for `lane === 'green'` bags; ignored otherwise. */
  greenGates?: GreenExitGates;
  /** Which feed produced this mark; stream prints are held to a tighter jump guard. */
  markSource?: 'stream' | 'dex' | null;
}): MarkExitDecision | null {
  const { mint, pos, markPriceUsd, gates } = args;
  if (!(markPriceUsd > 0) || !(pos.entryPriceUsd > 0)) return null;

  /**
   * Green bags answer to their own rule. Fixed target, tight stop, short
   * ceiling — measured on the forward tape, where a +6/−15 dip-shaped exit
   * returns −2.20 against +4.91 for +30/−6 over ten minutes.
   */
  if (pos.lane === 'green' && args.greenGates) {
    const heldMsGreen = Math.max(0, (args.nowMs ?? Date.now()) - (pos.openedAtMs || 0));
    const pnl = (markPriceUsd / pos.entryPriceUsd - 1) * 100;
    const g = decideGreenExit(pnl, heldMsGreen, args.greenGates);
    return {
      mint,
      markPriceUsd,
      mfeBasisPriceUsd: null,
      peakPriceUsd: Math.max(pos.peakPriceUsd ?? pos.entryPriceUsd, markPriceUsd),
      armed: false,
      justArmed: false,
      shouldExit: g.shouldExit,
      fraction: g.shouldExit ? 1 : 0,
      reason: g.reason,
      tpRungIndex: null,
      mfePct: 0,
      givebackPct: 0,
      pnlPct: pnl,
      volFadeSamples: [...(pos.volFadeSamples ?? [])],
      postEntryTroughPriceUsd: Math.min(pos.postEntryTroughUsd ?? pos.entryPriceUsd, markPriceUsd),
      postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
    };
  }
  const peakPrev =
    pos.peakPriceUsd != null && pos.peakPriceUsd > 0 ? pos.peakPriceUsd : pos.entryPriceUsd;

  /**
   * A violent single-tick move has to be seen twice before it decides anything.
   * One stream print took 5.6420e-04 to 3.2402e-04 — −42.57% between adjacent
   * marks, every neighbour steady at +21% — and the −25% stop closed the whole
   * bag on it. The fill came back at the real 5.6545e-04, so the money was
   * fine; the position was not, and the name kept climbing.
   *
   * A genuine collapse costs one extra tick before we act on it. A phantom
   * costs the position.
   */
  const streamLimit =
    gates.markJumpConfirmStreamPct > 0 ? gates.markJumpConfirmStreamPct : 0;
  const jumpLimit =
    args.markSource === 'stream' && streamLimit > 0
      ? streamLimit
      : gates.markJumpConfirmPct > 0
        ? gates.markJumpConfirmPct
        : 0;
  const lastMark = pos.lastMarkPriceUsd;
  if (jumpLimit > 0 && lastMark != null && lastMark > 0) {
    const jumpPct = Math.abs(markPriceUsd / lastMark - 1) * 100;
    if (jumpPct > jumpLimit) {
      const pendingPx = pos.pendingMarkPriceUsd;
      const confirms =
        pendingPx != null &&
        pendingPx > 0 &&
        Math.abs(markPriceUsd / pendingPx - 1) * 100 <= jumpLimit;
      if (!confirms) {
        // Hold everything as it was; only remember what we saw.
        return {
          mint,
          markPriceUsd,
          mfeBasisPriceUsd: null,
          peakPriceUsd: peakPrev,
          armed: pos.trailArmed === true,
          justArmed: false,
          shouldExit: false,
          fraction: 0,
          reason: null,
          tpRungIndex: null,
          mfePct: 0,
          givebackPct: 0,
          pnlPct: 0,
          volFadeSamples: [...(pos.volFadeSamples ?? [])],
          postEntryTroughPriceUsd: pos.postEntryTroughUsd ?? pos.entryPriceUsd,
          postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
          markQuarantined: true,
        };
      }
    }
  }
  const nowMs = args.nowMs ?? Date.now();
  const heldMs = Math.max(0, nowMs - (pos.openedAtMs > 0 ? pos.openedAtMs : nowMs));
  const stageRaw = Number(pos.mfeBankStage);
  const mfeBankStage = Number.isFinite(stageRaw)
    ? Math.max(0, Math.min(2, Math.floor(stageRaw)))
    : pos.scaleOutDone === true
      ? 1
      : 0;
  /**
   * The Dex price the entry decision was made on is the movement baseline. Only
   * used when it sits above the fill, which is the case that misreads a
   * motionless price as profit; buying above the mark needs no correction
   * because it understates MFE, and the stop already answers for it.
   */
  const mfeBasisPriceUsd =
    pos.entryMarkPriceUsd != null && pos.entryMarkPriceUsd > pos.entryPriceUsd
      ? pos.entryMarkPriceUsd
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
    tpRungsDone: pos.tpRungsDone ?? 0,
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
    tpRungIndex: dustClose ? null : verdict.tpRungIndex,
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
  if (decision.markQuarantined) {
    // Remember the outlier so a second print at the same level can confirm it,
    // and leave every other field, including lastMarkPriceUsd, untouched.
    pos.pendingMarkPriceUsd = decision.markPriceUsd;
    return;
  }
  pos.lastMarkPriceUsd = decision.markPriceUsd;
  pos.pendingMarkPriceUsd = undefined;
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
