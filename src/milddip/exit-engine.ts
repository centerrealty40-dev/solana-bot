/**
 * Pure helpers for mild-dip mark/exit scheduling.
 * Keep I/O (Dex / Jupiter / ATA) out of this module so unit tests stay offline.
 */
import type { MildDipExitGates, MildDipVolFadeSample } from './gates.js';
import {
  evaluateMildDipPeakGiveback,
  sustainedVolFade,
  type MildDipExitReason,
} from './gates.js';
import type { MildDipOpenPosition } from './state.js';
import { decideGreenExit, type GreenExitGates } from './green-lane.js';
import { evaluateLeaderStyleExit } from './leader-style.js';

/** How far the mark taken at entry may sit from the fill and still be a basis. */
const ENTRY_MARK_MAX_GAP_FRAC = 0.25;

/**
 * The basis every threshold measures from: the mark taken beside the fill, when
 * it is a comparable observation of the same token.
 *
 * A stored mark far from the fill is bad data, not an execution cost. 7rMnp9
 * carried 9.87e-06 against a 1.646e-03 fill and read MFE 17821%, which walks
 * the whole ladder in one tick and empties the bag. The band admits any real
 * gap (chase caps 4%, slippage 200bps, sample up to 30s old) and rejects that.
 * Outside it the fill serves, as it did before 1.11.873.
 */
export function resolveEntryMarkBasis(pos: MildDipOpenPosition): number | null {
  const raw = pos.entryMarkPriceUsd;
  if (raw == null || !Number.isFinite(raw) || !(raw > 0)) return null;
  if (!(pos.entryPriceUsd > 0)) return null;
  return Math.abs(raw / pos.entryPriceUsd - 1) <= ENTRY_MARK_MAX_GAP_FRAC ? raw : null;
}

export type MarkExitDecision = {
  mint: string;
  markPriceUsd: number;
  /** Mark taken at entry: the basis for every threshold. Null → fill basis. */
  entryMarketPriceUsd: number | null;
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
  /** 1.11.959 — green armed quarantine accepted after the blind-window cap. */
  markQuarantineForceReleased?: boolean;
  markQuarantineSinceMs?: number;
  markQuarantineBlindMs?: number;
  /** 1.11.921 — drop a stream outlier Dex never saw; pending clears, last mark stays. */
  markDiscardStreamOutlier?: boolean;
  /** Which feed this mark came from; a quarantine remembers it (1.11.889). */
  markSource?: 'stream' | 'dex' | null;
  mfePct: number;
  givebackPct: number;
  /** Move on the loss basis — what the stops compared. */
  pnlPct: number;
  /** Gain on the profit basis — what the ladder and banks compared. */
  gainPct: number;
  /** Price basis used for gainPct, needed to translate a real fill into rungs. */
  gainBasisPriceUsd: number;
  /** Move since the fill — real money, for logging only. */
  pnlPctVsFill: number;
  /** Safety cap that released the soft-loss bounce wait, if one did. */
  lossExitBounceCap?: 'drawdown' | 'trough_age';
  /** 1.11.994 — persisted small-loss reclaim wait transition. */
  lossReclaimWaitStartedAtMs?: number;
  lossReclaimWaitClearedReason?: 'target' | 'stop' | 'timeout' | 'protective_exit';
  lossReclaimWaitMs?: number;
  lossReclaimWaitDone?: boolean;
  /** Updated spaced vol5m ring — caller persists onto the open position. */
  volFadeSamples: MildDipVolFadeSample[];
  /** Updated post-entry low-water mark. */
  postEntryTroughPriceUsd: number;
  postEntryTroughAtMs: number;
  /** Current mark lift from the updated post-entry trough. */
  bounceOffTroughPct: number;
  /** Elapsed time since the updated post-entry trough. */
  troughAgeMs: number;
  /** Updated liquidity-drain confirmation count. */
  liquidityDrainConfirmTicks?: number;
  /** Last counted liquidity sample timestamp. */
  liquidityDrainSampleTsMs?: number;
  liquidityUsd?: number | null;
  liqRatio?: number | null;
  depthDrainRatio?: number | null;
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
  mirrorGates?: GreenExitGates & {
    leaderSellOnly?: boolean;
    lossCapActive?: boolean;
    ownExitEnabled?: boolean;
    ownExitTimeStopMs?: number;
    safetyMaxHoldMs?: number;
    ladderStepPct?: number;
    ladderStepAfterAveragePct?: number;
    ladderSellFraction?: number;
    ladderDustUsd?: number;
  };
  leaderStyleGates?: {
    profitReboundPct: number;
    pnlTpPct: number;
    volFadeRatio: number;
    depthDrainMax: number;
    maxHoldMs: number;
  };
  /** Which feed produced this mark; stream prints are held to a tighter jump guard. */
  markSource?: 'stream' | 'dex' | null;
  /** 1.11.910 — live 5m volume over pool liquidity, for the dead-set exit. */
  turnover5mLiq?: number | null;
  /** 1.11.969 — current fresh Dex liquidity for the drain exit. */
  liquidityUsd?: number | null;
  /** Stale open-mark metrics fail closed for liquidity-drain. */
  liquidityMetricsFresh?: boolean;
  /** Prior accepted marks confirming liquidity drain. */
  liquidityDrainConfirmTicks?: number | null;
  /** Timestamp of the current open-mark metrics sample. */
  liquidityMetricsTsMs?: number | null;
  /** 1.11.919 — how long a refused mark may stand before we accept it. */
  markJumpConfirmMaxMs?: number;
  /** 1.11.959 — green armed quarantine blind window; 0 = off. */
  markQuarantineGreenMaxMs?: number;
  /**
   * 1.11.921 — Dex price for cross-checking a stream print before a loss exit.
   * 3J8CiL: stream 1.98e-06 (-93%), Dex 3.124e-05 (+2%), cliff_dump fired anyway.
   */
  dexCrossCheckPx?: number | null;
}): MarkExitDecision | null {
  const { mint, pos, markPriceUsd, gates } = args;
  if (!(markPriceUsd > 0) || !(pos.entryPriceUsd > 0)) return null;

  /**
   * Green bags answer to their own rule. Fixed target, tight stop, short
   * ceiling — measured on the forward tape, where a +6/−15 dip-shaped exit
   * returns −2.20 against +4.91 for +30/−6 over ten minutes.
   */
  if (pos.lane === 'green' && args.greenGates) {
    const nowMsGreen = args.nowMs ?? Date.now();
    const heldMsGreen = Math.max(0, nowMsGreen - (pos.openedAtMs || 0));
    const basis =
      resolveEntryMarkBasis(pos) ?? pos.entryPriceUsd;
    const pnl = (markPriceUsd / basis - 1) * 100;
    const peakPriceUsd = Math.max(pos.peakPriceUsd ?? basis, markPriceUsd);
    const peakPnl = (peakPriceUsd / basis - 1) * 100;
    const peakDrawdown = peakPriceUsd > 0
      ? (1 - markPriceUsd / peakPriceUsd) * 100
      : 0;
    const wasArmed = pos.trailArmed === true;
    const g = decideGreenExit(pnl, heldMsGreen, args.greenGates, peakPnl, peakDrawdown);
    const armed =
      args.greenGates.trailEnabled === true &&
      (wasArmed || peakPnl >= (args.greenGates.armPct ?? 10));
    return {
      mint,
      markPriceUsd,
      entryMarketPriceUsd: null,
      peakPriceUsd,
      armed,
      justArmed: armed && !wasArmed,
      shouldExit: g.shouldExit,
      fraction: g.shouldExit ? 1 : 0,
      reason: g.reason,
      tpRungIndex: null,
      mfePct: peakPnl,
      givebackPct: 0,
      pnlPct: pnl,
      gainPct: pnl,
      gainBasisPriceUsd: basis,
      pnlPctVsFill: pnl,
      volFadeSamples: [...(pos.volFadeSamples ?? [])],
      postEntryTroughPriceUsd: Math.min(pos.postEntryTroughUsd ?? pos.entryPriceUsd, markPriceUsd),
      postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
      bounceOffTroughPct:
        Math.min(pos.postEntryTroughUsd ?? pos.entryPriceUsd, markPriceUsd) > 0
          ? (markPriceUsd /
              Math.min(pos.postEntryTroughUsd ?? pos.entryPriceUsd, markPriceUsd) -
              1) *
            100
          : 0,
      troughAgeMs: Math.max(
        0,
        nowMsGreen - ((pos.postEntryTroughAtMs ?? pos.openedAtMs) || 0),
      ),
    };
  }
  const entryMarketPriceUsd = resolveEntryMarkBasis(pos);
  const peakStored =
    pos.peakPriceUsd != null && pos.peakPriceUsd > 0 ? pos.peakPriceUsd : pos.entryPriceUsd;
  const peakPrev = Math.max(peakStored, pos.entryPriceUsd);

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
  let armedTrailUsesDex = false;
  let forceReleaseGreenQuarantine = false;
  let quarantineSinceMs: number | undefined;
  let quarantineBlindMs = 0;
  if (jumpLimit > 0 && lastMark != null && lastMark > 0) {
    const jumpPct = Math.abs(markPriceUsd / lastMark - 1) * 100;
    if (jumpPct > jumpLimit) {
      /**
       * 1.11.889 — a re-read is not a second opinion.
       *
       * DKxHTQCv sat at 3.8570e-04 for minutes, then took two stream prints of
       * 5.3768721e-04 two seconds apart — identical to the last digit — and the
       * second confirmed the first. The price was back at 3.8570e-04 on the next
       * mark, so 5.3768721e-04 never existed to trade on; MFE latched at +35.83%
       * and armed breakeven, which closed the bag at +2.28% while the name ran.
       *
       * Real prices tick. A value repeated exactly, from the same feed, is that
       * feed handing back one cached datum twice, so confirmation now has to come
       * from a different feed or at least a different number. Oscar answers the
       * same question by verifying an exit price against a fresh Jupiter quote
       * (`priceVerifyExit`, `tracker.ts:522`); this is the cheap form of it, on a
       * path that runs every two seconds.
       */
      const pendingPx = pos.pendingMarkPriceUsd;
      const pendingSrc = pos.pendingMarkSource;
      /**
       * 1.11.919 — the identical-re-read rule has to let go eventually.
       *
       * A feed handing back one cached datum twice is not two observations, which
       * is why 1.11.889 refused it. A value that keeps coming back for half a
       * minute is a stable price. nBxqeJsm sat on gain 0 / giveback 0 for 31
       * seconds across five identical Dex reads while the coin fell, and when the
       * guard finally let go the trail was at -23.88% instead of the -20% that
       * should have fired.
       */
      const quarantineMaxMs = args.markJumpConfirmMaxMs ?? 8_000;
      const seenAtMs = args.nowMs ?? Date.now();
      const pendingAgeMs =
        pos.pendingMarkAtMs != null && pos.pendingMarkAtMs > 0
          ? seenAtMs - pos.pendingMarkAtMs
          : 0;
      const quarantineExpired = quarantineMaxMs > 0 && pendingAgeMs >= quarantineMaxMs;
      const identicalReread =
        !quarantineExpired &&
        pendingPx != null &&
        markPriceUsd === pendingPx &&
        (pendingSrc == null || pendingSrc === args.markSource);
      const confirms =
        pendingPx != null &&
        pendingPx > 0 &&
        !identicalReread &&
        Math.abs(markPriceUsd / pendingPx - 1) * 100 <= jumpLimit;
      /**
       * 1.11.921 — ageing out is not confirmation of a stream phantom.
       *
       * 1.11.919 let an identical quarantined value through after 8s, which is
       * right for a Dex reading that landed and stayed, and wrong for a stream
       * print Dex never saw. 3J8CiL bought at 3.05e-05, Dex held +2%, stream
       * printed 1.98e-06 (-93%), quarantine expired on the same wrong number,
       * and cliff_dump fired. On chain the sell was -7.76%.
       */
      let acceptQuarantined = confirms;
      if (
        quarantineExpired &&
        pendingPx != null &&
        markPriceUsd === pendingPx
      ) {
        acceptQuarantined = args.markSource !== 'stream';
      }
      quarantineSinceMs =
        pos.markQuarantineSinceMs ??
        (pos.pendingMarkAtMs != null && pos.pendingMarkAtMs > 0
          ? pos.pendingMarkAtMs
          : seenAtMs);
      quarantineBlindMs = Math.max(0, seenAtMs - quarantineSinceMs);
      forceReleaseGreenQuarantine =
        (args.markQuarantineGreenMaxMs ?? 0) > 0 &&
        quarantineBlindMs >= (args.markQuarantineGreenMaxMs ?? 0) &&
        pos.trailArmed === true &&
        markPriceUsd >= pos.entryPriceUsd;
      if (forceReleaseGreenQuarantine) acceptQuarantined = true;
      /**
       * 1.11.923 — stream confirmation is not confirmation without Dex.
       *
       * 46vV3Z: Dex held −5% while stream printed 3.30e-05 (−52%). Two stream
       * ticks at the phantom confirmed each other through `confirms`, cliff_dump
       * fired on the red leg, fill came back at −41.9%. Dex agreement is required
       * for both expiry and the second-tick confirm path.
       */
      const streamNeedsDex =
        !forceReleaseGreenQuarantine &&
        args.markSource === 'stream' &&
        (acceptQuarantined ||
          (quarantineExpired &&
            pendingPx != null &&
            markPriceUsd === pendingPx));
      if (streamNeedsDex) {
        const dexPx = args.dexCrossCheckPx;
        const dexOk =
          dexPx != null &&
          dexPx > 0 &&
          Math.abs(markPriceUsd / dexPx - 1) * 100 <= jumpLimit;
        if (!dexOk) {
          if (
            quarantineExpired &&
            pendingPx != null &&
            markPriceUsd === pendingPx
          ) {
            return {
              mint,
              markPriceUsd: pos.lastMarkPriceUsd ?? peakPrev,
              entryMarketPriceUsd: null,
              peakPriceUsd: peakPrev,
              armed: pos.trailArmed === true,
              justArmed: false,
              shouldExit: false,
              fraction: 0,
              reason: null,
              tpRungIndex: null,
              markSource: args.markSource ?? null,
              markDiscardStreamOutlier: true,
              markQuarantineSinceMs: quarantineSinceMs,
              mfePct: 0,
              givebackPct: 0,
              pnlPct: 0,
              gainPct: 0,
              gainBasisPriceUsd: pos.entryPriceUsd,
              pnlPctVsFill: 0,
              bounceOffTroughPct: 0,
              troughAgeMs: 0,
              volFadeSamples: [...(pos.volFadeSamples ?? [])],
              postEntryTroughPriceUsd: pos.postEntryTroughUsd ?? pos.entryPriceUsd,
              postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
            };
          }
          acceptQuarantined = false;
        } else {
          acceptQuarantined = true;
        }
      }
      if (!acceptQuarantined) {
        const dexPx = args.dexCrossCheckPx;
        armedTrailUsesDex =
          pos.trailArmed === true &&
          args.markSource === 'stream' &&
          markPriceUsd < lastMark &&
          dexPx != null &&
          dexPx > 0 &&
          markPriceUsd < dexPx;
        if (!armedTrailUsesDex) {
          // Hold everything as it was; only remember what we saw.
          return {
            mint,
            markPriceUsd,
            entryMarketPriceUsd: null,
            peakPriceUsd: peakPrev,
            armed: pos.trailArmed === true,
            justArmed: false,
            shouldExit: false,
            fraction: 0,
            reason: null,
            tpRungIndex: null,
            markSource: args.markSource ?? null,
            mfePct: 0,
            givebackPct: 0,
            pnlPct: 0,
            gainPct: 0,
            gainBasisPriceUsd: pos.entryPriceUsd,
            pnlPctVsFill: 0,
            bounceOffTroughPct: 0,
            troughAgeMs: 0,
            volFadeSamples: [...(pos.volFadeSamples ?? [])],
            postEntryTroughPriceUsd: pos.postEntryTroughUsd ?? pos.entryPriceUsd,
            postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
            markQuarantined: true,
            markQuarantineSinceMs: quarantineSinceMs,
          };
        }
        // Dmkj4d: stream jumped down below Dex on an armed bag — trail on Dex, not blind.
      }
    }
  }
  /**
   * 1.11.921 — a stream loss Dex never saw is not a loss.
   *
   * Even when the jump guard lets a print through, cliff_dump and the stops
   * decide on the mark they are given. Cross-check Dex first; if it disagrees
   * by more than the jump limit, decide on Dex instead.
   */
  let decisionMark = markPriceUsd;
  let decisionSource = args.markSource ?? null;
  if (
    armedTrailUsesDex &&
    args.dexCrossCheckPx != null &&
    args.dexCrossCheckPx > 0
  ) {
    decisionMark = args.dexCrossCheckPx;
    decisionSource = 'dex';
  } else if (args.markSource === 'stream' && args.dexCrossCheckPx != null && args.dexCrossCheckPx > 0) {
    const crossLimit = jumpLimit > 0 ? jumpLimit : 10;
    if (Math.abs(markPriceUsd / args.dexCrossCheckPx - 1) * 100 > crossLimit) {
      decisionMark = args.dexCrossCheckPx;
      decisionSource = 'dex';
    }
  }
  if (pos.lane === 'leader_mirror' && args.mirrorGates) {
    const nowMsMirror = args.nowMs ?? Date.now();
    const heldMsMirror = Math.max(0, nowMsMirror - (pos.openedAtMs || 0));
    const basis = resolveEntryMarkBasis(pos) ?? pos.entryPriceUsd;
    const pnl = (decisionMark / basis - 1) * 100;
    const peakPriceUsd = Math.max(pos.peakPriceUsd ?? basis, decisionMark);
    const peakPnl = (peakPriceUsd / basis - 1) * 100;
    const peakDrawdown =
      peakPriceUsd > 0 ? (1 - decisionMark / peakPriceUsd) * 100 : 0;
    const ownExitEnabled = args.mirrorGates.ownExitEnabled === true;
    const wasArmed = pos.trailArmed === true;
    const armed =
      ownExitEnabled &&
      (args.mirrorGates.trailPct ?? 0) > 0 &&
      peakPnl >= (args.mirrorGates.armPct ?? 2);
    const safetyCut =
      (args.mirrorGates.safetyMaxHoldMs ?? 0) > 0 &&
      heldMsMirror >= (args.mirrorGates.safetyMaxHoldMs ?? 0);
    const ownTrailExit =
      ownExitEnabled &&
      armed &&
      (args.mirrorGates.trailPct ?? 0) > 0 &&
      peakDrawdown + 1e-9 >= (args.mirrorGates.trailPct ?? 0);
    const ownTimeStop =
      ownExitEnabled &&
      !armed &&
      (args.mirrorGates.ownExitTimeStopMs ?? 0) > 0 &&
      heldMsMirror >= (args.mirrorGates.ownExitTimeStopMs ?? 0);
    const ownShouldExit = ownTrailExit || ownTimeStop;
    const g =
      args.mirrorGates.leaderSellOnly === true
        ? null
        : decideGreenExit(
            pnl,
            heldMsMirror,
            args.mirrorGates,
            peakPnl,
            peakDrawdown,
          );
    const lossCap = args.mirrorGates.lossCapActive === true;
    const mirrorShouldExit = safetyCut
      ? true
      : lossCap
        ? true
      : ownShouldExit
        ? true
        : args.mirrorGates.leaderSellOnly === true
          ? false
          : g!.shouldExit;
    let ladderFraction = 0;
    let ladderRungIndex: number | null = null;
    if (
      !safetyCut &&
      !ownShouldExit &&
      args.mirrorGates.leaderSellOnly === true &&
      args.mirrorGates.ladderStepPct != null
    ) {
      const ladderBasis = pos.mirrorLadderBasisPriceUsd ?? pos.entryPriceUsd;
      const step = pos.mirrorAverageDone
        ? args.mirrorGates.ladderStepAfterAveragePct ?? 10
        : args.mirrorGates.ladderStepPct ?? 5;
      const rungStep = step > 0 ? step : 0;
      const gainPct = ladderBasis > 0 ? (decisionMark / ladderBasis - 1) * 100 : 0;
      const covered = rungStep > 0 && gainPct >= rungStep
        ? Math.floor((gainPct + 1e-9) / rungStep)
        : 0;
      const done = pos.mirrorLadderRungsDone ?? 0;
      const owed = Math.max(0, covered - done);
      if (owed > 0) {
        const sellFraction = Math.min(
          1,
          Math.max(0, args.mirrorGates.ladderSellFraction ?? 0.2),
        );
        ladderFraction = 1 - Math.pow(1 - sellFraction, owed);
        const remainderMarketUsd =
          pos.sizeUsd *
          (decisionMark / Math.max(ladderBasis, 1e-18)) *
          (1 - ladderFraction);
        if (
          remainderMarketUsd > 0 &&
          remainderMarketUsd < (args.mirrorGates.ladderDustUsd ?? 1)
        ) {
          ladderFraction = 1;
        }
        ladderRungIndex = done + owed;
      }
    }
    const ladderShouldExit = ladderFraction > 0;
    const mirrorReason: MildDipExitReason =
      safetyCut
        ? 'mirror_safety_cut'
        : lossCap
          ? 'mirror_loss_cap'
        : ownTrailExit
          ? 'mirror_trail'
          : ownTimeStop
            ? 'mirror_time_stop'
            : ladderShouldExit
              ? 'mirror_tp_ladder'
              : args.mirrorGates.leaderSellOnly === true
                ? null
                : g!.reason === 'green_stop'
                      ? 'mirror_stop'
                      : g!.reason === 'green_trail'
                        ? 'mirror_trail'
                        : g!.reason === 'green_no_move'
                          ? 'mirror_no_move'
                          : g!.reason === 'green_tp'
                            ? 'mirror_tp'
                            : g!.reason === 'green_max_hold'
                              ? 'mirror_max_hold'
                              : null;
    return {
      mint,
      markPriceUsd: decisionMark,
      entryMarketPriceUsd: null,
      peakPriceUsd,
      armed,
      justArmed: armed && !wasArmed,
      shouldExit: mirrorShouldExit || ladderShouldExit,
      fraction: mirrorShouldExit ? 1 : ladderFraction,
      reason: mirrorReason,
      tpRungIndex: ladderRungIndex,
      mfePct: peakPnl,
      givebackPct: peakDrawdown,
      pnlPct: pnl,
      gainPct: pnl,
      gainBasisPriceUsd: basis,
      pnlPctVsFill: pnl,
      volFadeSamples: [...(pos.volFadeSamples ?? [])],
      postEntryTroughPriceUsd: Math.min(
        pos.postEntryTroughUsd ?? pos.entryPriceUsd,
        decisionMark,
      ),
      postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
      bounceOffTroughPct: 0,
      troughAgeMs: Math.max(
        0,
        nowMsMirror - ((pos.postEntryTroughAtMs ?? pos.openedAtMs) || 0),
      ),
    };
  }
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
    entryMarketPriceUsd,
    markPriceUsd: decisionMark,
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
    turnover5mLiq: args.turnover5mLiq ?? null,
    liquidityUsd: args.liquidityUsd ?? null,
    liquidityMetricsFresh: args.liquidityMetricsFresh === true,
    liquidityMetricsTsMs: args.liquidityMetricsTsMs ?? null,
    entryLiquidityUsd: pos.entryLiquidityUsd ?? null,
    liquidityDrainConfirmTicks: pos.liquidityDrainConfirmTicks ?? 0,
    liquidityDrainSampleTsMs: pos.liquidityDrainSampleTsMs ?? null,
    entryTurnover5mLiq:
      pos.entryVolume5mUsd != null &&
      pos.entryLiquidityUsd != null &&
      pos.entryLiquidityUsd > 0
        ? pos.entryVolume5mUsd / pos.entryLiquidityUsd
        : null,
    volFadeSamples: pos.volFadeSamples ?? null,
    postEntryTroughPriceUsd: pos.postEntryTroughUsd ?? pos.entryPriceUsd,
    postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
    oneshotDumpGraceActive: args.oneshotDumpGraceActive === true,
    tpRungsDone: pos.tpRungsDone ?? 0,
    lastTpGridFillAtMs: pos.lastTpGridFillAtMs,
    lossReclaimWaitStartedAtMs: pos.lossReclaimWaitStartedAtMs ?? null,
    lossReclaimWaitDone: pos.lossReclaimWaitDone === true,
  });
  if (pos.lane === 'leader_style' && args.leaderStyleGates) {
    const protectedReason =
      verdict.reason === 'hard_stop' ||
      verdict.reason === 'cliff_dump' ||
      verdict.reason === 'liq_drain';
    if (!protectedReason) {
      const lstyle = evaluateLeaderStyleExit({
        heldMs,
        maxHoldMs: args.leaderStyleGates.maxHoldMs,
        pnlPct: verdict.pnlPct,
        pnlTpPct: args.leaderStyleGates.pnlTpPct,
        bounceOffTroughPct: verdict.bounceOffTroughPct,
        profitReboundPct: args.leaderStyleGates.profitReboundPct,
        liqRatio: verdict.liqRatio ?? null,
        volumeFade: sustainedVolFade(
          verdict.volFadeSamples,
          gates.neverArmVolFadeWeakWindows,
          pos.entryVolume5mUsd,
          args.leaderStyleGates.volFadeRatio,
          0,
        ),
        depthDrainRatio: verdict.depthDrainRatio ?? null,
        depthDrainMax: args.leaderStyleGates.depthDrainMax,
      });
      if (lstyle.shouldExit) {
        return {
          ...verdict,
          mint,
          markPriceUsd: decisionMark,
          entryMarketPriceUsd,
          gainBasisPriceUsd: pos.entryPriceUsd,
          shouldExit: true,
          fraction: 1,
          reason: lstyle.reason,
          tpRungIndex: null,
        };
      }
      verdict.shouldExit = false;
      verdict.fraction = 0;
      verdict.reason = null;
      verdict.tpRungIndex = null;
    }
  }
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
    markPriceUsd: decisionMark,
    entryMarketPriceUsd,
    peakPriceUsd: verdict.peakPriceUsd,
    armed: verdict.armed,
    justArmed: verdict.justArmed,
    shouldExit: dustClose ? true : verdict.shouldExit,
    fraction: dustClose ? 1 : verdict.fraction,
    reason: dustClose ? 'dust_close' : verdict.reason,
    tpRungIndex: dustClose ? null : verdict.tpRungIndex,
    markSource: decisionSource,
    mfePct: verdict.mfePct,
    givebackPct: verdict.givebackPct,
    pnlPct: verdict.pnlPct,
    gainPct: verdict.gainPct,
    gainBasisPriceUsd:
      (verdict as { gainBasisPriceUsd?: number }).gainBasisPriceUsd ??
      pos.entryPriceUsd,
    pnlPctVsFill: verdict.pnlPctVsFill,
    bounceOffTroughPct: verdict.bounceOffTroughPct,
    troughAgeMs: verdict.troughAgeMs,
    ...(verdict.lossExitBounceCap != null
      ? { lossExitBounceCap: verdict.lossExitBounceCap }
      : {}),
    ...(verdict.lossReclaimWaitStartedAtMs != null
      ? { lossReclaimWaitStartedAtMs: verdict.lossReclaimWaitStartedAtMs }
      : {}),
    ...(verdict.lossReclaimWaitClearedReason != null
      ? { lossReclaimWaitClearedReason: verdict.lossReclaimWaitClearedReason }
      : {}),
    ...(verdict.lossReclaimWaitMs != null ? { lossReclaimWaitMs: verdict.lossReclaimWaitMs } : {}),
    ...(verdict.lossReclaimWaitDone === true ? { lossReclaimWaitDone: true } : {}),
    volFadeSamples: verdict.volFadeSamples,
    postEntryTroughPriceUsd: verdict.postEntryTroughPriceUsd,
    postEntryTroughAtMs: verdict.postEntryTroughAtMs,
    liquidityDrainConfirmTicks: verdict.liquidityDrainConfirmTicks,
    liquidityDrainSampleTsMs: verdict.liquidityDrainSampleTsMs,
    liquidityUsd: verdict.liquidityUsd,
    liqRatio: verdict.liqRatio,
    depthDrainRatio: verdict.depthDrainRatio,
    ...(forceReleaseGreenQuarantine
      ? {
          markQuarantineForceReleased: true,
          markQuarantineSinceMs: quarantineSinceMs,
          markQuarantineBlindMs: quarantineBlindMs,
        }
      : {}),
  };
}

/** Merge mark decision into live position (peak / arm / vol-fade / trough). */
export function applyMarkDecisionToPosition(
  pos: MildDipOpenPosition,
  decision: MarkExitDecision,
): void {
  if (decision.markDiscardStreamOutlier) {
    pos.pendingMarkPriceUsd = undefined;
    pos.pendingMarkSource = undefined;
    pos.pendingMarkAtMs = undefined;
    return;
  }
  if (decision.markQuarantined) {
    // Remember the outlier so a second print at the same level can confirm it,
    // and leave every other field, including lastMarkPriceUsd, untouched.
    // Keep the original timestamp while the same value keeps coming back, so the
    // quarantine clock measures how long we have been refusing it (1.11.919).
    if (pos.pendingMarkPriceUsd !== decision.markPriceUsd || pos.pendingMarkAtMs == null) {
      pos.pendingMarkAtMs = Date.now();
    }
    pos.pendingMarkPriceUsd = decision.markPriceUsd;
    pos.pendingMarkSource = decision.markSource ?? undefined;
    pos.markQuarantineSinceMs =
      decision.markQuarantineSinceMs ?? pos.markQuarantineSinceMs ?? Date.now();
    return;
  }
  if (pos.lastMarkPriceUsd !== decision.markPriceUsd || pos.markUnchangedSinceMs == null) {
    pos.markUnchangedSinceMs = Date.now();
  }
  pos.lastMarkPriceUsd = decision.markPriceUsd;
  pos.pendingMarkPriceUsd = undefined;
  pos.pendingMarkSource = undefined;
  pos.pendingMarkAtMs = undefined;
  pos.markQuarantineSinceMs = undefined;
  pos.peakPriceUsd = decision.peakPriceUsd;
  pos.trailArmed = decision.armed;
  pos.volFadeSamples = decision.volFadeSamples;
  if (decision.liquidityDrainConfirmTicks != null) {
    pos.liquidityDrainConfirmTicks = decision.liquidityDrainConfirmTicks;
  }
  pos.liquidityDrainSampleTsMs = decision.liquidityDrainSampleTsMs;
  if (decision.postEntryTroughPriceUsd > 0) {
    pos.postEntryTroughUsd = decision.postEntryTroughPriceUsd;
  }
  if (decision.postEntryTroughAtMs > 0) {
    pos.postEntryTroughAtMs = decision.postEntryTroughAtMs;
  }
  if (decision.lossReclaimWaitClearedReason != null) {
    pos.lossReclaimWaitStartedAtMs = undefined;
  }
  if (decision.lossReclaimWaitDone === true) {
    pos.lossReclaimWaitDone = true;
  } else if (
    decision.lossReclaimWaitClearedReason == null &&
    decision.lossReclaimWaitStartedAtMs != null
  ) {
    pos.lossReclaimWaitStartedAtMs = decision.lossReclaimWaitStartedAtMs;
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
