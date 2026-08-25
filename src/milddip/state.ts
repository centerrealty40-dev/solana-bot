import fs from 'node:fs';
import path from 'node:path';
import type { KnifeWatchEntry } from './knife-stabilize.js';
import type { WaitDipWatchEntry } from './wait-dip.js';
import type { MildDipCandidateMetrics } from './gates.js';
import type { LeaderSeedHit } from './discover-extra.js';
import { sanitizeRecentEntryMsByMint } from './entry-churn.js';
import { rotateMildDipJournal } from './journal-rotation.js';

let journalWriteFailures = 0;
let journalWriteLastWarnAtMs = 0;
let stateSaveFailures = 0;
let stateSaveFirstFailureAtMs = 0;

function stateSaveFailureLimit(): number {
  const value = Number(process.env.MILD_DIP_STATE_SAVE_FAILURE_LIMIT ?? 3);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3;
}

export function mildDipPersistenceStats(): {
  journalWriteFailures: number;
  stateSaveFailures: number;
  stateSaveBlocked: boolean;
} {
  return {
    journalWriteFailures,
    stateSaveFailures,
    stateSaveBlocked: stateSaveFailures >= stateSaveFailureLimit(),
  };
}

export function mildDipStateSaveBlocked(): boolean {
  return stateSaveFailures >= stateSaveFailureLimit();
}

export function noteMildDipJournalWriteFailure(err: unknown): void {
  journalWriteFailures += 1;
  const nowMs = Date.now();
  if (nowMs - journalWriteLastWarnAtMs >= 60_000) {
    journalWriteLastWarnAtMs = nowMs;
    console.warn(
      `[mild-dip] journal write failed count=${journalWriteFailures}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type MildDipOpenPosition = {
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  sizeUsd: number;
  /** Intended curve notional and first-fill anchor for the optional staged add. */
  stagedEntryIntendedUsd?: number;
  stagedEntryFirstFillPriceUsd?: number;
  stagedEntryFilledUsd?: number;
  stagedEntryTotalCostUsd?: number;
  stagedEntryTotalTokenAmount?: number;
  stagedEntryAvgCostPriceUsd?: number;
  stagedEntryAddDone?: boolean;
  stagedEntryAddAttempts?: number;
  stagedEntryLastAttemptAtMs?: number;
  stagedEntryRugRiskTier?: 'normal' | 'knife' | 'blocked';
  tokenRaw: string | null;
  openedAtMs: number;
  entryPc5mPct: number | null;
  buySignature: string | null;
  /** Leader buy copied by the mirror, when available. */
  leaderBuyTsMs?: number;
  leaderBuySignature?: string;
  leaderMirrorLeader?: string;
  mirrorOriginalEntryPriceUsd?: number;
  mirrorFirstClipLegsFilled?: number;
  mirrorFirstClipFirstFillAtMs?: number;
  mirrorLadderBasisPriceUsd?: number;
  mirrorLadderRungsDone?: number;
  mirrorAverageDone?: boolean;
  mirrorAverageFillPriceUsd?: number;
  mirrorAverageLastFillAtMs?: number;
  mirrorAverageAttempts?: number;
  mirrorAverageLastAttemptAtMs?: number;
  mirrorCrossLeaderAverageCount?: number;
  mirrorCrossLeaderAverageLastAttemptAtMs?: number;
  mirrorCrossLeaderAverageSignature?: string;
  mirrorCrossLeaderAverageFillPriceUsd?: number;
  mirrorCrossLeaderAverageBasePriceUsd?: number;
  mirrorCrossLeaderAverageBaseUsd?: number;
  mirrorCrossLeaderAverageUsdTotal?: number;
  /** Running high-water mark from entry (W9.1). */
  peakPriceUsd?: number;
  /** 1.11.919 — when the quarantined mark first appeared, so it can time out. */
  pendingMarkAtMs?: number;
  /** 1.11.959 — continuous quarantine start, cleared by the first accepted mark. */
  markQuarantineSinceMs?: number;
  /**
   * 1.11.848 — the Dex price the entry decision was made on.
   *
   * Marks and fills do not share a scale: a stale or different-pool snapshot can
   * sit well above what Jupiter gave us, and measuring the gap as gain reads a
   * motionless price as instant profit. MFE / arm / giveback measure from this
   * so that only movement inside the mark series counts. `entryPriceUsd` keeps
   * serving P&L, where the money actually is.
   */
  entryMarkPriceUsd?: number;
  /**
   * 1.11.849 — rungs of the unbounded TP ladder already filled. Unlike
   * `mfeBankStage` this is not capped: rung 9 is +72% MFE at an 8% step.
   */
  tpRungsDone?: number;
  /** 1.11.993 — successful TP-grid fill timestamp for rung spacing. */
  lastTpGridFillAtMs?: number;
  /** 1.11.993 — consecutive failed full-exit attempts for the current reason. */
  exitRetryCount?: number;
  exitRetryReason?: string;
  /** 1.11.993 — first staged-profit veto timestamp. */
  stagedProfitVetoSinceMs?: number;
  stagedProfitVetoLastJournalAtMs?: number;
  stagedProfitVetoLastReason?: string;
  stagedProfitVetoLastThresholdPx?: number;
  profitExitMinHoldLastJournalAtMs?: number;
  profitExitMinHoldLastReason?: string;
  /**
   * 1.11.860 — which lane opened this bag. `green` is a momentum entry and is
   * managed by `decideGreenExit`, not by the dip ladder: the tape says those
   * names are done within minutes either way, so a trail would only donate.
   */
  lane?: 'dip' | 'green' | 'leader_mirror' | 'tier' | 'leader_style';
  mirrorExitArmPct?: number;
  mirrorExitTrailPct?: number;
  mirrorExitStopPct?: number;
  mirrorExitMaxHoldMs?: number;
  mirrorExitNoMoveCutMs?: number;
  mirrorExitNoMoveMinMfePct?: number;
  /** GREEN exit profile fixed when the position was opened. */
  greenExitProfile?: 'standard' | 'fast';
  greenExitTrailEnabled?: boolean;
  greenExitTakeProfitPct?: number;
  greenExitStopPct?: number;
  greenExitArmPct?: number;
  greenExitTrailPct?: number;
  greenExitMaxHoldMs?: number;
  greenExitNoMoveCutMs?: number;
  greenExitNoMoveMinMfePct?: number;
  /**
   * 1.11.852 — last mark accepted for this bag, and a quarantined one awaiting
   * confirmation. A single stream print collapsed 5.6420e-04 to 3.2402e-04
   * (−42.57% in one tick) on a bag sitting at +21.75%, fired the −25% stop and
   * closed it while the name kept climbing. A move that large has to be seen
   * twice before it decides anything.
   */
  lastMarkPriceUsd?: number;
  /** 1.11.920 — since when the feed has been handing back the same number. */
  markUnchangedSinceMs?: number;
  pendingMarkPriceUsd?: number;
  /**
   * 1.11.889 — which feed the quarantined print came from. Two byte-identical
   * prints from one feed are a stale value read twice, not a market at that
   * price, so they may not confirm each other.
   */
  pendingMarkSource?: 'stream' | 'dex';
  /** Running low-water mark from entry (never-arm bounce / freefall). */
  postEntryTroughUsd?: number;
  /** When postEntryTroughUsd was last deepened. */
  postEntryTroughAtMs?: number;
  /** W9.1 trail armed after MFE ≥ armPct. */
  trailArmed?: boolean;
  /** True after a successful partial scale-out (half bag sold). */
  scaleOutDone?: boolean;
  /**
   * MFE-bank ladder progress: 0/undefined = none, 1 = bank1 filled, 2 = bank2 filled.
   * Sleeve trail owns the remainder after stage ≥ 1 (wide giveback).
   */
  mfeBankStage?: number;
  /** 5m Dex volume at entry — baseline for the activity-fade exit. */
  entryVolume5mUsd?: number | null;
  /** Dex liquidity at entry — fallback baseline for exit → rebuy liq-drop. */
  entryLiquidityUsd?: number | null;
  /** 1.11.969 — consecutive accepted marks confirming liquidity drain. */
  liquidityDrainConfirmTicks?: number;
  /** 1.11.969 — Dex metrics sample timestamp counted by the drain confirmer. */
  liquidityDrainSampleTsMs?: number;
  /**
   * 1.11.874 — carried so the exit path can ask the entry gate whether it would
   * open this position now. Market cap is scaled by the price move since entry,
   * pair age grows with the hold; neither is re-read on the mark path.
   */
  entryMarketCapUsd?: number | null;
  entryPairAgeHours?: number | null;
  /** Dex pool at entry — exit defer allow-list fallback when mark refresh lags. */
  entryDexId?: string | null;
  /** dipSource at entry — stabilize-exempt sources skip re-check on defer. */
  entryDipSource?: string | null;
  /**
   * 1.11.879 — when this bag last sold. A partial changes the size on chain and
   * the balance read lags, so the next decision has to wait for data that
   * postdates the sell; two `never_arm_bounce` legs fired 4.1s apart on 33Grh5V
   * / 2HJmyTW, the second on a reading from before the first.
   */
  lastSellAtMs?: number;
  /** 1.11.920 — the mark the last sell fired on; the next needs a different one. */
  lastSellMarkPriceUsd?: number;
  /** Cumulative ms this bag has held a soft exit because the gate still passes. */
  exitDeferredMs?: number;
  /** Wall clock of the last such deferral, for accumulating the budget. */
  exitDeferredAtMs?: number;
  /** 1.11.994 — start of the small-loss reclaim wait, if active. */
  lossReclaimWaitStartedAtMs?: number;
  /** 1.11.994 — the reclaim wait is one-shot for a position. */
  lossReclaimWaitDone?: boolean;
  /**
   * Spaced Dex vol5m samples (≥5m apart) for sustained `never_arm_vol_fade`.
   * A single weak tick must not sell — need N consecutive weak windows.
   */
  volFadeSamples?: Array<{ ts: number; vol: number }>;
  /**
   * 1.11.761 — one-shot leader-align average-in already filled on this bag.
   * Prevents spam scale-in when soft exits keep re-firing under a leader buy.
   */
  leaderAlignScaleInDone?: boolean;
  /**
   * `tokenRaw` came from a settled sell (`before − sold`), not from the buy
   * quote. Only then may it cap the next sell: a buy's Jupiter `outAmount` runs
   * a few % above the confirmed fill, which is what made us ask for more than we
   * held in the first place.
   */
  tokenRawSettled?: boolean;
  /** Durable full-exit intent after the bound leader sells. */
  mirrorLeaderSellIntent?: {
    leader: string;
    signature: string | null;
    leaderBlockTimeMs: number;
    detectedAtMs: number;
    attemptCount?: number;
    lastAttemptAtMs?: number;
  };
};

export function isMirrorLane(lane: MildDipOpenPosition['lane']): boolean {
  return lane === 'leader_mirror' || lane === 'tier';
}

/** Last full exit — block rebuy near the same USD price (no Dex needed). */
export type MildDipLastExit = {
  priceUsd: number;
  atMs: number;
  pnlPct?: number;
  /** Dex pool liquidity at (or near) exit — rebuy liq-drop baseline. */
  liquidityUsd?: number | null;
};

export type MildDipState = {
  open: Record<string, MildDipOpenPosition>;
  /** mint → last close/attempt ms (cooldown). */
  cooldownUntilMs: Record<string, number>;
  /** mint → successful entry timestamps (rolling 24h anti-churn). */
  recentEntryMsByMint?: Record<string, number[]>;
  /** GREEN buy attempts in the rolling one-hour exposure window. */
  recentGreenBuyMs?: number[];
  /** mint → last full-exit fill/mark price for same-price rebuy guard. */
  lastExitByMint?: Record<string, MildDipLastExit>;
  /**
   * 1.11.906 — mint → when a leader was last seen holding or buying it, kept for
   * as long as `leaderSeenMemoryMs`.
   *
   * The first-touch gate asks whether a leader finds a name worth trading at all.
   * The measurement behind it used exactly that - ever - and found first touches
   * on leader-traded names at −0.1470 per position against −0.3068 on names no
   * leader wants. The implementation read the seed file instead, which carries a
   * two-hour window for its own purposes, so the gate was stricter than the
   * evidence: of 20,614 rejections, 1,066 were names the leaders had bought
   * earlier than two hours, which is the better population being turned away.
   */
  leaderSeenMints?: Record<string, number>;
  /** mint → deep-knife watch (wait for stabilize / bounce). */
  knifeWatch?: Record<string, KnifeWatchEntry>;
  /** mint → wait-dip watch (park signal; buy after extra dump). */
  waitDipWatch?: Record<string, WaitDipWatchEntry>;
  leaderMirrorWatches?: Record<
    string,
    {
      hit: LeaderSeedHit;
      hitKey: string;
      startedAtMs: number;
      expiresAtMs: number;
      metricSource: 'seed' | 'backfill';
      lastWaitReason?: string;
      lastWaitAtMs?: number;
    }
  >;
  leaderMirrorDecisions?: Record<
    string,
    { hitKey: string; decidedAtMs: number; reason: string }
  >;
  mirrorTradingCashUsd?: number;
  mirrorLossCapBaselineAtMs?: number;
  mirrorLossCapBaselineUsd?: number;
  mirrorLossCapTriggeredAtMs?: number;
  mirrorLossCapTriggeredPnlUsd?: number;
  mirrorLossCapPendingDrawdownUsd?: number;
  mirrorLossCapPendingAtMs?: number;
  updatedAtMs: number;
};

export const MAX_LEADER_MIRROR_DECISIONS = 512;
const LEADER_MIRROR_STATE_RETENTION_MULTIPLIER = 2;
const LEADER_MIRROR_STATE_MIN_RETENTION_MS = 5 * 60_000;

function sanitizeKnifeWatch(
  raw: unknown,
): Record<string, KnifeWatchEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, KnifeWatchEntry> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<KnifeWatchEntry>;
    const detectedAtMs = Number(o.detectedAtMs);
    const knifeDipPct = Number(o.knifeDipPct);
    const peakPriceUsd = Number(o.peakPriceUsd);
    const troughPriceUsd = Number(o.troughPriceUsd);
    const troughAtMs = Number(o.troughAtMs);
    const lastPriceUsd = Number(o.lastPriceUsd);
    const lastAtMs = Number(o.lastAtMs);
    if (
      !(detectedAtMs > 0) ||
      !Number.isFinite(knifeDipPct) ||
      !(peakPriceUsd > 0) ||
      !(troughPriceUsd > 0) ||
      !(troughAtMs > 0) ||
      !(lastPriceUsd > 0) ||
      !(lastAtMs > 0)
    ) {
      continue;
    }
    const readyNotifiedAtMs = Number(o.readyNotifiedAtMs);
    out[mint] = {
      detectedAtMs,
      knifeDipPct,
      peakPriceUsd,
      troughPriceUsd,
      troughAtMs,
      lastPriceUsd,
      lastAtMs,
      ...(readyNotifiedAtMs > 0 ? { readyNotifiedAtMs } : {}),
    };
  }
  return out;
}

function sanitizeWaitDipWatch(raw: unknown): Record<string, WaitDipWatchEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, WaitDipWatchEntry> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<WaitDipWatchEntry>;
    const detectedAtMs = Number(o.detectedAtMs);
    const signalPriceUsd = Number(o.signalPriceUsd);
    const waitDipPct = Number(o.waitDipPct);
    const lastPriceUsd = Number(o.lastPriceUsd);
    const lastAtMs = Number(o.lastAtMs);
    const troughPriceUsd = Number(o.troughPriceUsd);
    const troughAtMs = Number(o.troughAtMs);
    const symbol = typeof o.symbol === 'string' ? o.symbol : mint.slice(0, 6);
    const originalDipSource =
      typeof o.originalDipSource === 'string' ? o.originalDipSource : 'dex';
    if (
      !(detectedAtMs > 0) ||
      !(signalPriceUsd > 0) ||
      !Number.isFinite(waitDipPct) ||
      !(waitDipPct < 0) ||
      !(lastPriceUsd > 0) ||
      !(lastAtMs > 0) ||
      !(troughPriceUsd > 0) ||
      !(troughAtMs > 0)
    ) {
      continue;
    }
    const metricsRaw =
      o.metrics && typeof o.metrics === 'object'
        ? (o.metrics as Partial<MildDipCandidateMetrics>)
        : {};
    const metrics: MildDipCandidateMetrics = {
      priceChange5mPct:
        typeof metricsRaw.priceChange5mPct === 'number' ? metricsRaw.priceChange5mPct : null,
      volume5mUsd: typeof metricsRaw.volume5mUsd === 'number' ? metricsRaw.volume5mUsd : null,
      liquidityUsd: typeof metricsRaw.liquidityUsd === 'number' ? metricsRaw.liquidityUsd : null,
      marketCapUsd: typeof metricsRaw.marketCapUsd === 'number' ? metricsRaw.marketCapUsd : null,
      pairAgeHours: typeof metricsRaw.pairAgeHours === 'number' ? metricsRaw.pairAgeHours : null,
      dexId: typeof metricsRaw.dexId === 'string' ? metricsRaw.dexId : null,
      buys5m: typeof metricsRaw.buys5m === 'number' ? metricsRaw.buys5m : null,
      sells5m: typeof metricsRaw.sells5m === 'number' ? metricsRaw.sells5m : null,
      volume1hUsd: typeof metricsRaw.volume1hUsd === 'number' ? metricsRaw.volume1hUsd : null,
      priceChange1hPct:
        typeof metricsRaw.priceChange1hPct === 'number' ? metricsRaw.priceChange1hPct : null,
    };
    out[mint] = {
      detectedAtMs,
      signalPriceUsd,
      waitDipPct,
      symbol,
      originalDipSource,
      metrics,
      lastPriceUsd,
      lastAtMs,
      troughPriceUsd,
      troughAtMs,
    };
  }
  return out;
}

function sanitizeLastExitByMint(raw: unknown): Record<string, MildDipLastExit> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, MildDipLastExit> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<MildDipLastExit>;
    const priceUsd = Number(o.priceUsd);
    const atMs = Number(o.atMs);
    if (!(priceUsd > 0) || !(atMs > 0)) continue;
    const pnlPct = Number(o.pnlPct);
    const liquidityUsd = Number(o.liquidityUsd);
    out[mint] = {
      priceUsd,
      atMs,
      ...(Number.isFinite(pnlPct) ? { pnlPct } : {}),
      ...(Number.isFinite(liquidityUsd) && liquidityUsd > 0
        ? { liquidityUsd }
        : {}),
    };
  }
  return out;
}

function sanitizeOpenPositions(raw: unknown): Record<string, MildDipOpenPosition> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, MildDipOpenPosition> = {};
  for (const [mint, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const pos = value as MildDipOpenPosition;
    if (Number.isFinite(Number(pos.mirrorFirstClipLegsFilled))) {
      pos.mirrorFirstClipLegsFilled = Math.max(
        0,
        Math.floor(Number(pos.mirrorFirstClipLegsFilled)),
      );
    } else {
      delete pos.mirrorFirstClipLegsFilled;
    }
    if (!Number.isFinite(Number(pos.mirrorFirstClipFirstFillAtMs))) {
      delete pos.mirrorFirstClipFirstFillAtMs;
    }
    const intent = pos.mirrorLeaderSellIntent;
    if (
      intent &&
      typeof intent === 'object' &&
      typeof intent.leader === 'string' &&
      intent.leader &&
      Number.isFinite(Number(intent.leaderBlockTimeMs)) &&
      Number(intent.leaderBlockTimeMs) > 0 &&
      Number.isFinite(Number(intent.detectedAtMs)) &&
      Number(intent.detectedAtMs) > 0
    ) {
      pos.mirrorLeaderSellIntent = {
        leader: intent.leader,
        signature: typeof intent.signature === 'string' ? intent.signature : null,
        leaderBlockTimeMs: Number(intent.leaderBlockTimeMs),
        detectedAtMs: Number(intent.detectedAtMs),
        ...(Number.isFinite(Number(intent.attemptCount))
          ? { attemptCount: Math.max(0, Number(intent.attemptCount)) }
          : {}),
        ...(Number.isFinite(Number(intent.lastAttemptAtMs))
          ? { lastAttemptAtMs: Number(intent.lastAttemptAtMs) }
          : {}),
      };
    } else {
      delete pos.mirrorLeaderSellIntent;
    }
    out[mint] = pos;
  }
  return out;
}

function sanitizeLeaderMirrorWatches(
  raw: unknown,
  nowMs: number,
): MildDipState['leaderMirrorWatches'] {
  if (!raw || typeof raw !== 'object') return {};
  const out: NonNullable<MildDipState['leaderMirrorWatches']> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const watch = value as Partial<NonNullable<MildDipState['leaderMirrorWatches']>[string]>;
    if (!watch.hit || typeof watch.hit !== 'object') continue;
    if (
      typeof watch.hitKey !== 'string' ||
      !(Number(watch.startedAtMs) > 0) ||
      !(Number(watch.expiresAtMs) > 0) ||
      Number(watch.expiresAtMs) <= nowMs ||
      (watch.metricSource !== 'seed' && watch.metricSource !== 'backfill')
    ) continue;
    out[key] = {
      hit: watch.hit as LeaderSeedHit,
      hitKey: watch.hitKey,
      startedAtMs: Number(watch.startedAtMs),
      expiresAtMs: Number(watch.expiresAtMs),
      metricSource: watch.metricSource,
      ...(typeof watch.lastWaitReason === 'string'
        ? { lastWaitReason: watch.lastWaitReason }
        : {}),
      ...(Number.isFinite(Number(watch.lastWaitAtMs))
        ? { lastWaitAtMs: Number(watch.lastWaitAtMs) }
        : {}),
    };
  }
  return out;
}

function sanitizeLeaderMirrorDecisions(
  raw: unknown,
  nowMs: number,
  observeMs: number,
): MildDipState['leaderMirrorDecisions'] {
  if (!raw || typeof raw !== 'object') return {};
  const out: NonNullable<MildDipState['leaderMirrorDecisions']> = {};
  const cutoff =
    nowMs -
    Math.max(
      observeMs * LEADER_MIRROR_STATE_RETENTION_MULTIPLIER,
      LEADER_MIRROR_STATE_MIN_RETENTION_MS,
    );
  const entries: Array<
    [string, NonNullable<MildDipState['leaderMirrorDecisions']>[string]]
  > = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const decision = value as Partial<NonNullable<MildDipState['leaderMirrorDecisions']>[string]>;
    if (
      typeof decision.hitKey !== 'string' ||
      !(Number(decision.decidedAtMs) > 0) ||
      typeof decision.reason !== 'string'
    ) continue;
    entries.push([key, {
      hitKey: decision.hitKey,
      decidedAtMs: Number(decision.decidedAtMs),
      reason: decision.reason,
    }]);
  }
  entries
    .filter(([, decision]) => decision.decidedAtMs >= cutoff)
    .sort(([, a], [, b]) => b.decidedAtMs - a.decidedAtMs)
    .slice(0, MAX_LEADER_MIRROR_DECISIONS)
    .forEach(([key, decision]) => {
      out[key] = decision;
    });
  return out;
}

export function emptyMildDipState(nowMs = Date.now()): MildDipState {
  return {
    open: {},
    cooldownUntilMs: {},
    lastExitByMint: {},
    leaderSeenMints: {},
    knifeWatch: {},
    waitDipWatch: {},
    leaderMirrorWatches: {},
    leaderMirrorDecisions: {},
    recentEntryMsByMint: {},
    mirrorTradingCashUsd: 0,
    updatedAtMs: nowMs,
  };
}

export function loadMildDipState(
  statePath: string,
  options?: { mirrorObserveMs?: number; nowMs?: number },
): MildDipState {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as MildDipState;
    if (!parsed || typeof parsed !== 'object') return emptyMildDipState();
    const nowMs = options?.nowMs ?? Date.now();
    const mirrorObserveMs = options?.mirrorObserveMs ?? 45_000;
    return {
      open: sanitizeOpenPositions(parsed.open),
      cooldownUntilMs:
        parsed.cooldownUntilMs && typeof parsed.cooldownUntilMs === 'object'
          ? parsed.cooldownUntilMs
          : {},
      lastExitByMint: sanitizeLastExitByMint(parsed.lastExitByMint),
      /**
       * 1.11.909 — this loader builds a fresh object field by field, so anything
       * it does not name is dropped on every restart. The leader memory added in
       * 1.11.906 was not named, so it reset each reload and never grew past the
       * handful of mints one seed window holds.
       */
      leaderSeenMints:
        parsed.leaderSeenMints && typeof parsed.leaderSeenMints === 'object'
          ? parsed.leaderSeenMints
          : {},
      knifeWatch: sanitizeKnifeWatch(parsed.knifeWatch),
      waitDipWatch: sanitizeWaitDipWatch(parsed.waitDipWatch),
      leaderMirrorWatches: sanitizeLeaderMirrorWatches(
        parsed.leaderMirrorWatches,
        nowMs,
      ),
      leaderMirrorDecisions: sanitizeLeaderMirrorDecisions(
        parsed.leaderMirrorDecisions,
        nowMs,
        mirrorObserveMs,
      ),
      recentEntryMsByMint: sanitizeRecentEntryMsByMint(parsed.recentEntryMsByMint),
      mirrorTradingCashUsd:
        Number.isFinite(Number(parsed.mirrorTradingCashUsd))
          ? Number(parsed.mirrorTradingCashUsd)
          : 0,
      ...(Number.isFinite(Number(parsed.mirrorLossCapBaselineAtMs))
        ? { mirrorLossCapBaselineAtMs: Number(parsed.mirrorLossCapBaselineAtMs) }
        : {}),
      ...(Number.isFinite(Number(parsed.mirrorLossCapBaselineUsd))
        ? { mirrorLossCapBaselineUsd: Number(parsed.mirrorLossCapBaselineUsd) }
        : {}),
      ...(Number.isFinite(Number(parsed.mirrorLossCapTriggeredAtMs))
        ? { mirrorLossCapTriggeredAtMs: Number(parsed.mirrorLossCapTriggeredAtMs) }
        : {}),
      ...(Number.isFinite(Number(parsed.mirrorLossCapTriggeredPnlUsd))
        ? { mirrorLossCapTriggeredPnlUsd: Number(parsed.mirrorLossCapTriggeredPnlUsd) }
        : {}),
      ...(Number.isFinite(Number(parsed.mirrorLossCapPendingDrawdownUsd))
        ? { mirrorLossCapPendingDrawdownUsd: Number(parsed.mirrorLossCapPendingDrawdownUsd) }
        : {}),
      ...(Number.isFinite(Number(parsed.mirrorLossCapPendingAtMs))
        ? { mirrorLossCapPendingAtMs: Number(parsed.mirrorLossCapPendingAtMs) }
        : {}),
      updatedAtMs: Number(parsed.updatedAtMs) || Date.now(),
    };
  } catch {
    return emptyMildDipState();
  }
}

export function saveMildDipState(statePath: string, state: MildDipState): boolean {
  try {
    const dir = path.dirname(statePath);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    state.updatedAtMs = Date.now();
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, statePath);
    stateSaveFailures = 0;
    stateSaveFirstFailureAtMs = 0;
    return true;
  } catch (err) {
    stateSaveFailures += 1;
    if (stateSaveFirstFailureAtMs === 0) stateSaveFirstFailureAtMs = Date.now();
    console.error(
      `[mild-dip] state save failed consecutive=${stateSaveFailures} ` +
        `path=${statePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (stateSaveFailures >= stateSaveFailureLimit()) {
      console.error(
        `[mild-dip] STATE UNSAVEABLE: blocking new entries after ${stateSaveFailures} consecutive failures; exits remain enabled`,
      );
    }
    return false;
  }
}

export function appendMildDipJournal(
  journalPath: string,
  event: Record<string, unknown>,
): void {
  try {
    const dir = path.dirname(journalPath);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`;
    rotateMildDipJournal(
      journalPath,
      Number(process.env.MILD_DIP_JOURNAL_MAX_BYTES ?? 512 * 1024 * 1024),
      Buffer.byteLength(line),
    );
    fs.appendFileSync(journalPath, line, 'utf8');
  } catch (err) {
    noteMildDipJournalWriteFailure(err);
  }
}
