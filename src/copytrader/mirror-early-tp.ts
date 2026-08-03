/**
 * Mirror early take-profit: once mark is ≥ +N% vs entry and the leader has not
 * sold any of this mint since our entry, peel a fraction of the remaining size.
 * Complements (does not replace) leader-sell mirroring.
 */
import type { CopyTraderConfig } from './config.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import type { CopyPosition, CopyTraderState, PendingSell } from './state.js';
import { newId } from './state.js';
import { isSaneTrailMark } from './trail-exit.js';

export const MIRROR_EARLY_TP_LEADER_SIG = 'mirror_early_tp:+gain';

export type MirrorEarlyTpConfig = Pick<
  CopyTraderConfig,
  'mirrorEarlyTpGainPct' | 'mirrorEarlyTpSellFraction' | 'sellRetryWindowMs'
>;

export type MirrorEarlyTpDecision =
  | {
      action: 'hold';
      reason:
        | 'disabled'
        | 'already_taken'
        | 'leader_sold'
        | 'no_entry'
        | 'below_gain'
        | 'pending_sell'
        | 'oscar'
        | 'blocked';
    }
  | {
      action: 'sell';
      gainPct: number;
      sellFraction: number;
    };

export function decideMirrorEarlyTp(
  cfg: MirrorEarlyTpConfig,
  input: {
    entryPriceUsd: number;
    priceUsd: number;
    mirrorEarlyTpTaken?: boolean;
    leaderSoldSinceEntry?: boolean;
    oscarPromotedAt?: number;
    sellBlockedUntilTs?: number;
    hasPendingSell: boolean;
    nowMs?: number;
  },
): MirrorEarlyTpDecision {
  if (!(cfg.mirrorEarlyTpGainPct > 0) || !(cfg.mirrorEarlyTpSellFraction > 0)) {
    return { action: 'hold', reason: 'disabled' };
  }
  if (input.oscarPromotedAt != null) return { action: 'hold', reason: 'oscar' };
  if (input.mirrorEarlyTpTaken) return { action: 'hold', reason: 'already_taken' };
  if (input.leaderSoldSinceEntry) return { action: 'hold', reason: 'leader_sold' };
  if (input.hasPendingSell) return { action: 'hold', reason: 'pending_sell' };
  const now = input.nowMs ?? Date.now();
  if ((input.sellBlockedUntilTs ?? 0) > now) return { action: 'hold', reason: 'blocked' };
  if (!(input.entryPriceUsd > 0) || !(input.priceUsd > 0)) {
    return { action: 'hold', reason: 'no_entry' };
  }
  if (!isSaneTrailMark(input.entryPriceUsd, input.priceUsd)) {
    return { action: 'hold', reason: 'no_entry' };
  }

  const gainPct = (input.priceUsd / input.entryPriceUsd - 1) * 100;
  if (gainPct + 1e-9 < cfg.mirrorEarlyTpGainPct) {
    return { action: 'hold', reason: 'below_gain' };
  }

  const sellFraction = Math.min(1, Math.max(0, cfg.mirrorEarlyTpSellFraction));
  if (!(sellFraction > 0)) return { action: 'hold', reason: 'disabled' };

  return { action: 'sell', gainPct, sellFraction };
}

export type MirrorEarlyTpScheduleResult = {
  mint: string;
  symbol: string;
  gainPct: number;
  sellFraction: number;
  entryPriceUsd: number;
  priceUsd: number;
};

function hasPendingSellForMint(state: CopyTraderState, mint: string): boolean {
  return state.pendingSells.some((p) => p.mint === mint);
}

function schedulePartialSell(
  cfg: Pick<CopyTraderConfig, 'sellRetryWindowMs'>,
  state: CopyTraderState,
  pos: CopyPosition,
  fraction: number,
  nowMs: number,
): void {
  pos.sellBlockedUntilTs = undefined;
  const pending: PendingSell = {
    id: newId('ps'),
    mint: pos.mint,
    symbol: pos.symbol,
    leaderSignature: MIRROR_EARLY_TP_LEADER_SIG,
    leaderSellTs: nowMs,
    dueTs: nowMs,
    fraction,
    retryUntilTs: computeRetryUntilTs(nowMs, cfg.sellRetryWindowMs),
  };
  state.pendingSells.push(pending);
}

export type MirrorEarlyTpDeps = {
  resolvePriceUsd: (mint: string) => Promise<number>;
};

/** Returns newly scheduled peels. */
export async function processMirrorEarlyTpExits(
  cfg: MirrorEarlyTpConfig & Pick<CopyTraderConfig, 'mirrorEarlyTpTickIntervalMs'>,
  state: CopyTraderState,
  deps: MirrorEarlyTpDeps,
  nowMs = Date.now(),
): Promise<MirrorEarlyTpScheduleResult[]> {
  if (!(cfg.mirrorEarlyTpGainPct > 0) || !(cfg.mirrorEarlyTpSellFraction > 0)) return [];

  const out: MirrorEarlyTpScheduleResult[] = [];
  const tickMs = cfg.mirrorEarlyTpTickIntervalMs > 0 ? cfg.mirrorEarlyTpTickIntervalMs : 5_000;

  for (const pos of Object.values(state.positions)) {
    const last = pos.lastMirrorEarlyTpCheckTs ?? 0;
    if (nowMs - last < tickMs) continue;
    pos.lastMirrorEarlyTpCheckTs = nowMs;

    const priceUsd = await deps.resolvePriceUsd(pos.mint);
    const decision = decideMirrorEarlyTp(cfg, {
      entryPriceUsd: pos.entryPriceUsd,
      priceUsd,
      mirrorEarlyTpTaken: pos.mirrorEarlyTpTaken,
      leaderSoldSinceEntry: pos.leaderSoldSinceEntry,
      oscarPromotedAt: pos.oscarPromotedAt,
      sellBlockedUntilTs: pos.sellBlockedUntilTs,
      hasPendingSell: hasPendingSellForMint(state, pos.mint),
      nowMs,
    });
    if (decision.action !== 'sell') continue;

    schedulePartialSell(cfg, state, pos, decision.sellFraction, nowMs);
    pos.mirrorEarlyTpTaken = true;
    if (!(pos.peakPriceUsd != null && pos.peakPriceUsd > priceUsd)) {
      pos.peakPriceUsd = priceUsd;
    }
    out.push({
      mint: pos.mint,
      symbol: pos.symbol,
      gainPct: Number(decision.gainPct.toFixed(2)),
      sellFraction: decision.sellFraction,
      entryPriceUsd: pos.entryPriceUsd,
      priceUsd,
    });
  }

  return out;
}
