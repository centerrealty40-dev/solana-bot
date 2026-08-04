/**
 * Volume-fade exit: periodically re-check DexScreener 5m volume on open legs.
 * If volume has fallen vs entry (or under an absolute floor), force a full market
 * sell — independent of leader peels. Complements mirror exits on the vol lane.
 *
 * Skipped on leader-follow-only markets (large mcap + strong 1h volume).
 */
import type { CopyTraderConfig } from './config.js';
import { isLeaderFollowOnlyMarket } from './leader-follow-only.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import type { CopyPosition, CopyTraderState, PendingSell } from './state.js';
import { newId } from './state.js';

export const VOL_FADE_LEADER_SIG = 'vol_fade:drop';

export type VolFadeConfig = Pick<
  CopyTraderConfig,
  | 'volFadeCheckIntervalMs'
  | 'volFadeMinVolume5mUsd'
  | 'volFadeDropPct'
  | 'sellRetryWindowMs'
  | 'leaderFollowOnlyMinMcapUsd'
  | 'leaderFollowOnlyMinVolume1hUsd'
>;

export type VolFadeDecision =
  | { action: 'hold'; reason: 'disabled' | 'volume_ok' | 'volume_unknown' | 'leader_follow_only' }
  | {
      action: 'sell';
      reason: 'below_floor' | 'dropped_vs_entry';
      volume5mUsd: number;
      entryVolume5mUsd: number | null;
    };

export function decideVolFadeExit(
  cfg: VolFadeConfig,
  input: {
    entryVolume5mUsd?: number | null;
    volume5mUsd: number | null;
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

  const vol = input.volume5mUsd;
  if (vol == null || !(vol >= 0)) {
    return { action: 'hold', reason: 'volume_unknown' };
  }

  const entryVol =
    input.entryVolume5mUsd != null && input.entryVolume5mUsd > 0 ? input.entryVolume5mUsd : null;

  if (cfg.volFadeMinVolume5mUsd > 0 && vol < cfg.volFadeMinVolume5mUsd) {
    return {
      action: 'sell',
      reason: 'below_floor',
      volume5mUsd: vol,
      entryVolume5mUsd: entryVol,
    };
  }

  if (entryVol != null && cfg.volFadeDropPct > 0) {
    const floor = entryVol * (1 - cfg.volFadeDropPct / 100);
    if (vol + 1e-9 < floor) {
      return {
        action: 'sell',
        reason: 'dropped_vs_entry',
        volume5mUsd: vol,
        entryVolume5mUsd: entryVol,
      };
    }
  }

  return { action: 'hold', reason: 'volume_ok' };
}

export type VolFadeScheduleResult = {
  mint: string;
  symbol: string;
  reason: 'below_floor' | 'dropped_vs_entry';
  volume5mUsd: number;
  entryVolume5mUsd: number | null;
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
    const decision = decideVolFadeExit(cfg, {
      entryVolume5mUsd: pos.entryVolume5mUsd,
      volume5mUsd: snap.volume5mUsd,
      marketCapUsd: snap.marketCapUsd,
      volume1hUsd: snap.volume1hUsd,
    });
    pos.lastVolFadeCheckTs = nowMs;
    if (snap.volume5mUsd != null && snap.volume5mUsd >= 0) pos.lastVolume5mUsd = snap.volume5mUsd;

    if (decision.action !== 'sell') continue;

    const accelerated = scheduleOrAccelerateFullSell(cfg, state, pos, nowMs);
    out.push({
      mint: pos.mint,
      symbol: pos.symbol,
      reason: decision.reason,
      volume5mUsd: decision.volume5mUsd,
      entryVolume5mUsd: decision.entryVolume5mUsd,
      accelerated,
    });
  }

  return out;
}
