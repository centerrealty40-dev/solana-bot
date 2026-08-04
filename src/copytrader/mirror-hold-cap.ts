/**
 * Mirror hold-time cap: force a full market sell when a copy leg has been open
 * longer than `mirrorHoldCapMs`, even if the leader has not sold yet.
 *
 * Optional volume extension: while 5m volume stays healthy (same floors as
 * vol-fade), stretch the deadline to `mirrorHoldCapVolOkMs` (e.g. 30m → 60m).
 *
 * Large liquid names (mcap + 1h vol floors) skip the timeout entirely and only
 * follow the leader.
 */
import type { CopyTraderConfig } from './config.js';
import {
  isLeaderFollowOnlyMarket,
  type LeaderFollowOnlyConfig,
} from './leader-follow-only.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import type { CopyPosition, CopyTraderState, PendingSell } from './state.js';
import { newId } from './state.js';
import { decideVolFadeExit } from './vol-fade-exit.js';

export const MIRROR_HOLD_CAP_LEADER_SIG = 'mirror_hold_cap:time';

export type MirrorHoldCapConfig = Pick<
  CopyTraderConfig,
  | 'mirrorHoldCapMs'
  | 'mirrorHoldCapVolOkMs'
  | 'volFadeMinVolume5mUsd'
  | 'volFadeDropPct'
  | 'sellRetryWindowMs'
  | 'leaderFollowOnlyMinMcapUsd'
  | 'leaderFollowOnlyMinVolume1hUsd'
>;

export type MirrorHoldCapDecision =
  | {
      action: 'hold';
      reason:
        | 'disabled'
        | 'under_cap'
        | 'vol_extended'
        | 'leader_follow_only'
        | 'oscar'
        | 'blocked';
    }
  | {
      action: 'sell';
      heldMs: number;
      reason: 'base_cap' | 'vol_ok_cap' | 'volume_weak';
    };

/** Effective hard deadline (ms). Volume-ok stretch only when configured above base. */
export function effectiveMirrorHoldCapMs(cfg: MirrorHoldCapConfig): number {
  if (!(cfg.mirrorHoldCapMs > 0)) return 0;
  if (cfg.mirrorHoldCapVolOkMs > cfg.mirrorHoldCapMs) return cfg.mirrorHoldCapVolOkMs;
  return cfg.mirrorHoldCapMs;
}

export function volumeSupportsHoldExtension(
  cfg: Pick<MirrorHoldCapConfig, 'volFadeMinVolume5mUsd' | 'volFadeDropPct'>,
  input: { entryVolume5mUsd?: number | null; volume5mUsd: number | null },
): boolean {
  const d = decideVolFadeExit(
    {
      volFadeCheckIntervalMs: 1,
      volFadeMinVolume5mUsd: cfg.volFadeMinVolume5mUsd,
      volFadeDropPct: cfg.volFadeDropPct,
      sellRetryWindowMs: 0,
      leaderFollowOnlyMinMcapUsd: 0,
      leaderFollowOnlyMinVolume1hUsd: 0,
    },
    input,
  );
  return d.action === 'hold' && d.reason === 'volume_ok';
}

export function decideMirrorHoldCap(
  cfg: MirrorHoldCapConfig,
  input: {
    entryTs: number;
    oscarPromotedAt?: number;
    sellBlockedUntilTs?: number;
    nowMs?: number;
    /** When past base cap and extension is configured: true = stretch, false/null = sell. */
    volumeHealthy?: boolean | null;
    /** Live mcap / 1h vol — when both clear floors, skip timeout. */
    marketCapUsd?: number | null;
    volume1hUsd?: number | null;
  },
): MirrorHoldCapDecision {
  if (!(cfg.mirrorHoldCapMs > 0)) return { action: 'hold', reason: 'disabled' };
  if (input.oscarPromotedAt != null) return { action: 'hold', reason: 'oscar' };
  const now = input.nowMs ?? Date.now();
  if ((input.sellBlockedUntilTs ?? 0) > now) return { action: 'hold', reason: 'blocked' };
  if (!(input.entryTs > 0)) return { action: 'hold', reason: 'under_cap' };

  const followCfg: LeaderFollowOnlyConfig = {
    leaderFollowOnlyMinMcapUsd: cfg.leaderFollowOnlyMinMcapUsd,
    leaderFollowOnlyMinVolume1hUsd: cfg.leaderFollowOnlyMinVolume1hUsd,
  };
  if (
    isLeaderFollowOnlyMarket(followCfg, {
      marketCapUsd: input.marketCapUsd,
      volume1hUsd: input.volume1hUsd,
    })
  ) {
    return { action: 'hold', reason: 'leader_follow_only' };
  }

  const heldMs = Math.max(0, now - input.entryTs);
  const baseMs = cfg.mirrorHoldCapMs;
  const volOkMs = cfg.mirrorHoldCapVolOkMs > baseMs ? cfg.mirrorHoldCapVolOkMs : 0;

  if (heldMs + 1e-9 < baseMs) return { action: 'hold', reason: 'under_cap' };

  if (!(volOkMs > 0)) return { action: 'sell', heldMs, reason: 'base_cap' };
  if (heldMs + 1e-9 >= volOkMs) return { action: 'sell', heldMs, reason: 'vol_ok_cap' };

  if (input.volumeHealthy === true) return { action: 'hold', reason: 'vol_extended' };
  return { action: 'sell', heldMs, reason: 'volume_weak' };
}

export type MirrorHoldCapScheduleResult = {
  mint: string;
  symbol: string;
  heldMs: number;
  reason: 'base_cap' | 'vol_ok_cap' | 'volume_weak';
  accelerated: boolean;
};

type ScheduleKind = 'scheduled' | 'accelerated' | 'noop';

function scheduleOrAccelerateFullSell(
  cfg: Pick<CopyTraderConfig, 'sellRetryWindowMs'>,
  state: CopyTraderState,
  pos: CopyPosition,
  nowMs: number,
): ScheduleKind {
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
      if (!String(p.leaderSignature).startsWith('mirror_hold_cap:')) {
        p.leaderSignature = MIRROR_HOLD_CAP_LEADER_SIG;
      }
    }
    for (const p of inFlight) {
      if (p.fraction < 0.999) {
        state.pendingSells = state.pendingSells.filter((x) => x.id !== p.id);
      }
    }
    return accelerated ? 'accelerated' : 'noop';
  }

  if (inFlight.length > 0) cancelPendingSellsForMint(state, pos.mint);
  const pending: PendingSell = {
    id: newId('ps'),
    mint: pos.mint,
    symbol: pos.symbol,
    leaderSignature: MIRROR_HOLD_CAP_LEADER_SIG,
    leaderSellTs: nowMs,
    dueTs: nowMs,
    fraction: 1,
    retryUntilTs: computeRetryUntilTs(nowMs, cfg.sellRetryWindowMs),
  };
  state.pendingSells.push(pending);
  return 'scheduled';
}

export type MirrorHoldCapMarketSnapshot = {
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  marketCapUsd: number | null;
};

export type MirrorHoldCapDeps = {
  /** Prefer full Dex snapshot; legacy `fetchVolume5mUsd` alone is not enough for exempt. */
  fetchMarketSnapshot?: (mint: string) => Promise<MirrorHoldCapMarketSnapshot>;
  fetchVolume5mUsd?: (mint: string) => Promise<number | null>;
};

/** Returns newly scheduled (or accelerated) full exits. */
export async function processMirrorHoldCapExits(
  cfg: MirrorHoldCapConfig,
  state: CopyTraderState,
  deps?: MirrorHoldCapDeps,
  nowMs = Date.now(),
): Promise<MirrorHoldCapScheduleResult[]> {
  if (!(cfg.mirrorHoldCapMs > 0)) return [];

  const needsMarket =
    deps != null &&
    (cfg.mirrorHoldCapVolOkMs > cfg.mirrorHoldCapMs ||
      (cfg.leaderFollowOnlyMinMcapUsd > 0 && cfg.leaderFollowOnlyMinVolume1hUsd > 0));

  const out: MirrorHoldCapScheduleResult[] = [];
  for (const pos of Object.values(state.positions)) {
    const heldMs = Math.max(0, nowMs - (pos.entryTs || 0));
    let volumeHealthy: boolean | null | undefined;
    let marketCapUsd: number | null | undefined;
    let volume1hUsd: number | null | undefined;

    const pastBase = heldMs + 1e-9 >= cfg.mirrorHoldCapMs;
    if (needsMarket && pastBase) {
      let snap: MirrorHoldCapMarketSnapshot | null = null;
      if (deps!.fetchMarketSnapshot) {
        snap = await deps!.fetchMarketSnapshot(pos.mint);
      } else if (deps!.fetchVolume5mUsd) {
        snap = {
          volume5mUsd: await deps!.fetchVolume5mUsd(pos.mint),
          volume1hUsd: null,
          marketCapUsd: null,
        };
      }
      if (snap) {
        if (snap.volume5mUsd != null && snap.volume5mUsd >= 0) pos.lastVolume5mUsd = snap.volume5mUsd;
        pos.lastVolFadeCheckTs = nowMs;
        marketCapUsd = snap.marketCapUsd;
        volume1hUsd = snap.volume1hUsd;
        if (
          cfg.mirrorHoldCapVolOkMs > cfg.mirrorHoldCapMs &&
          heldMs + 1e-9 < cfg.mirrorHoldCapVolOkMs
        ) {
          volumeHealthy = volumeSupportsHoldExtension(cfg, {
            entryVolume5mUsd: pos.entryVolume5mUsd,
            volume5mUsd: snap.volume5mUsd,
          });
        }
      }
    }

    const decision = decideMirrorHoldCap(cfg, {
      entryTs: pos.entryTs,
      oscarPromotedAt: pos.oscarPromotedAt,
      sellBlockedUntilTs: pos.sellBlockedUntilTs,
      nowMs,
      volumeHealthy,
      marketCapUsd,
      volume1hUsd,
    });
    if (decision.action !== 'sell') continue;

    const kind = scheduleOrAccelerateFullSell(cfg, state, pos, nowMs);
    if (kind === 'noop') continue;
    out.push({
      mint: pos.mint,
      symbol: pos.symbol,
      heldMs: decision.heldMs,
      reason: decision.reason,
      accelerated: kind === 'accelerated',
    });
  }
  return out;
}
