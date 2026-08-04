/**
 * Volume-fade exit: periodically re-check DexScreener 5m volume on open legs.
 * Uses a multi-window majority over recent samples so one noisy m5 tick does
 * not dump the book. Complements mirror exits on the vol lane.
 *
 * Skipped on leader-follow-only markets (large mcap + strong 1h volume).
 */
import type { CopyTraderConfig } from './config.js';
import { isLeaderFollowOnlyMarket } from './leader-follow-only.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import type { CopyPosition, CopyTraderState, PendingSell } from './state.js';
import { newId } from './state.js';
import {
  decideMultiWindowVolume,
  pushVolume5mSample,
  type MultiWindowVolumeDecision,
} from './volume-health.js';

export const VOL_FADE_LEADER_SIG = 'vol_fade:drop';

export type VolFadeConfig = Pick<
  CopyTraderConfig,
  | 'volFadeCheckIntervalMs'
  | 'volFadeMinVolume5mUsd'
  | 'volFadeDropPct'
  | 'volFadeSampleWindow'
  | 'volFadeMinWeakSamples'
  | 'sellRetryWindowMs'
  | 'leaderFollowOnlyMinMcapUsd'
  | 'leaderFollowOnlyMinVolume1hUsd'
>;

export type VolFadeDecision =
  | { action: 'hold'; reason: 'disabled' | 'volume_ok' | 'volume_unknown' | 'leader_follow_only' | 'warming' }
  | {
      action: 'sell';
      reason: 'below_floor' | 'dropped_vs_entry';
      volume5mUsd: number;
      entryVolume5mUsd: number | null;
      medianVolume5mUsd: number | null;
      weakCount: number;
      sampleCount: number;
    };

function windowCfg(cfg: VolFadeConfig) {
  return {
    minVolume5mUsd: cfg.volFadeMinVolume5mUsd,
    dropPct: cfg.volFadeDropPct,
    sampleWindow: cfg.volFadeSampleWindow > 0 ? cfg.volFadeSampleWindow : 1,
    minWeakSamples: cfg.volFadeMinWeakSamples > 0 ? cfg.volFadeMinWeakSamples : 1,
  };
}

/** Pure decision from an already-updated sample series (newest included). */
export function decideVolFadeExit(
  cfg: VolFadeConfig,
  input: {
    entryVolume5mUsd?: number | null;
    /** Latest reading; when `samples` omitted, treated as a 1-length series. */
    volume5mUsd: number | null;
    /** Prefer full series (includes latest). */
    samples?: number[];
    marketCapUsd?: number | null;
    volume1hUsd?: number | null;
  },
): VolFadeDecision {
  if (!(cfg.volFadeCheckIntervalMs > 0)) return { action: 'hold', reason: 'disabled' };
  if (!(cfg.volFadeMinVolume5mUsd > 0) && !(cfg.volFadeDropPct > 0)) {
    return { action: 'hold', reason: 'disabled' };
  }

  if (
    isLeaderFollowOnlyMarket(cfg, {
      marketCapUsd: input.marketCapUsd,
      volume1hUsd: input.volume1hUsd,
    })
  ) {
    return { action: 'hold', reason: 'leader_follow_only' };
  }

  const samples =
    input.samples && input.samples.length > 0
      ? input.samples
      : input.volume5mUsd != null && input.volume5mUsd >= 0
        ? [input.volume5mUsd]
        : [];

  if (samples.length === 0) {
    return { action: 'hold', reason: 'volume_unknown' };
  }

  const multi: MultiWindowVolumeDecision = decideMultiWindowVolume(windowCfg(cfg), {
    entryVolume5mUsd: input.entryVolume5mUsd,
    samples,
  });

  if (!multi.shouldExit) {
    if (multi.reason === 'warming') return { action: 'hold', reason: 'warming' };
    if (multi.reason === 'unknown') return { action: 'hold', reason: 'volume_unknown' };
    return { action: 'hold', reason: 'volume_ok' };
  }

  const entryVol =
    input.entryVolume5mUsd != null && input.entryVolume5mUsd > 0 ? input.entryVolume5mUsd : null;
  const latest = samples[samples.length - 1]!;
  return {
    action: 'sell',
    reason: multi.reason === 'below_floor' ? 'below_floor' : 'dropped_vs_entry',
    volume5mUsd: latest,
    entryVolume5mUsd: entryVol,
    medianVolume5mUsd: multi.medianUsd,
    weakCount: multi.weakCount,
    sampleCount: multi.sampleCount,
  };
}

export type VolFadeScheduleResult = {
  mint: string;
  symbol: string;
  reason: 'below_floor' | 'dropped_vs_entry';
  volume5mUsd: number;
  entryVolume5mUsd: number | null;
  medianVolume5mUsd: number | null;
  weakCount: number;
  sampleCount: number;
  accelerated: boolean;
};

function scheduleOrAccelerateFullSell(
  cfg: Pick<CopyTraderConfig, 'sellRetryWindowMs'>,
  state: CopyTraderState,
  pos: CopyPosition,
  nowMs: number,
): boolean {
  pos.sellBlockedUntilTs = undefined;
  const inFlight = state.pendingSells.filter((p) => p.mint === pos.mint);
  const fullInFlight = inFlight.filter((p) => p.fraction >= 0.999);
  if (fullInFlight.length > 0) {
    let accelerated = false;
    for (const p of fullInFlight) {
      if (p.dueTs > nowMs) {
        p.dueTs = nowMs;
        accelerated = true;
      }
      if (!String(p.leaderSignature).startsWith('vol_fade:')) {
        p.leaderSignature = VOL_FADE_LEADER_SIG;
      }
    }
    for (const p of inFlight) {
      if (p.fraction < 0.999) {
        state.pendingSells = state.pendingSells.filter((x) => x.id !== p.id);
      }
    }
    return accelerated;
  }

  if (inFlight.length > 0) cancelPendingSellsForMint(state, pos.mint);
  const pending: PendingSell = {
    id: newId('ps'),
    mint: pos.mint,
    symbol: pos.symbol,
    leaderSignature: VOL_FADE_LEADER_SIG,
    leaderSellTs: nowMs,
    dueTs: nowMs,
    fraction: 1,
    retryUntilTs: computeRetryUntilTs(nowMs, cfg.sellRetryWindowMs),
  };
  state.pendingSells.push(pending);
  return false;
}

export type VolFadeMarketSnapshot = {
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  marketCapUsd: number | null;
};

export type VolFadeDeps = {
  fetchMarketSnapshot?: (mint: string) => Promise<VolFadeMarketSnapshot>;
  /** Legacy: volume-only; leader-follow exempt will not fire without mcap/vol1h. */
  fetchVolume5mUsd?: (mint: string) => Promise<number | null>;
};

/** Returns scheduled (or accelerated) exits. Always stamps lastVolFadeCheckTs when a check ran. */
export async function processVolFadeExits(
  cfg: VolFadeConfig,
  state: CopyTraderState,
  deps: VolFadeDeps,
  nowMs = Date.now(),
): Promise<VolFadeScheduleResult[]> {
  if (!(cfg.volFadeCheckIntervalMs > 0)) return [];
  if (!(cfg.volFadeMinVolume5mUsd > 0) && !(cfg.volFadeDropPct > 0)) return [];

  const out: VolFadeScheduleResult[] = [];

  for (const pos of Object.values(state.positions)) {
    if (pos.oscarPromotedAt != null) continue;

    const due =
      nowMs - (pos.lastVolFadeCheckTs ?? pos.entryTs) >= cfg.volFadeCheckIntervalMs;
    if (!due) continue;

    let snap: VolFadeMarketSnapshot;
    if (deps.fetchMarketSnapshot) {
      snap = await deps.fetchMarketSnapshot(pos.mint);
    } else {
      snap = {
        volume5mUsd: deps.fetchVolume5mUsd ? await deps.fetchVolume5mUsd(pos.mint) : null,
        volume1hUsd: null,
        marketCapUsd: null,
      };
    }

    if (snap.volume5mUsd != null && snap.volume5mUsd >= 0) {
      pos.volume5mSamples = pushVolume5mSample(pos.volume5mSamples, snap.volume5mUsd);
      pos.lastVolume5mUsd = snap.volume5mUsd;
    }

    const decision = decideVolFadeExit(cfg, {
      entryVolume5mUsd: pos.entryVolume5mUsd,
      volume5mUsd: snap.volume5mUsd,
      samples: pos.volume5mSamples,
      marketCapUsd: snap.marketCapUsd,
      volume1hUsd: snap.volume1hUsd,
    });
    pos.lastVolFadeCheckTs = nowMs;

    if (decision.action !== 'sell') continue;

    const accelerated = scheduleOrAccelerateFullSell(cfg, state, pos, nowMs);
    out.push({
      mint: pos.mint,
      symbol: pos.symbol,
      reason: decision.reason,
      volume5mUsd: decision.volume5mUsd,
      entryVolume5mUsd: decision.entryVolume5mUsd,
      medianVolume5mUsd: decision.medianVolume5mUsd,
      weakCount: decision.weakCount,
      sampleCount: decision.sampleCount,
      accelerated,
    });
  }

  return out;
}
