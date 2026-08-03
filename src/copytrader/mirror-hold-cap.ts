/**
 * Mirror hold-time cap: force a full market sell when a copy leg has been open
 * longer than `mirrorHoldCapMs`, even if the leader has not sold yet.
 */
import type { CopyTraderConfig } from './config.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import type { CopyPosition, CopyTraderState, PendingSell } from './state.js';
import { newId } from './state.js';

export const MIRROR_HOLD_CAP_LEADER_SIG = 'mirror_hold_cap:time';

export type MirrorHoldCapConfig = Pick<CopyTraderConfig, 'mirrorHoldCapMs' | 'sellRetryWindowMs'>;

export type MirrorHoldCapDecision =
  | { action: 'hold'; reason: 'disabled' | 'under_cap' | 'oscar' | 'blocked' }
  | { action: 'sell'; heldMs: number };

export function decideMirrorHoldCap(
  cfg: MirrorHoldCapConfig,
  input: {
    entryTs: number;
    oscarPromotedAt?: number;
    sellBlockedUntilTs?: number;
    nowMs?: number;
  },
): MirrorHoldCapDecision {
  if (!(cfg.mirrorHoldCapMs > 0)) return { action: 'hold', reason: 'disabled' };
  if (input.oscarPromotedAt != null) return { action: 'hold', reason: 'oscar' };
  const now = input.nowMs ?? Date.now();
  if ((input.sellBlockedUntilTs ?? 0) > now) return { action: 'hold', reason: 'blocked' };
  if (!(input.entryTs > 0)) return { action: 'hold', reason: 'under_cap' };
  const heldMs = Math.max(0, now - input.entryTs);
  if (heldMs + 1e-9 < cfg.mirrorHoldCapMs) return { action: 'hold', reason: 'under_cap' };
  return { action: 'sell', heldMs };
}

export type MirrorHoldCapScheduleResult = {
  mint: string;
  symbol: string;
  heldMs: number;
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

/** Returns newly scheduled (or accelerated) full exits. */
export function processMirrorHoldCapExits(
  cfg: MirrorHoldCapConfig,
  state: CopyTraderState,
  nowMs = Date.now(),
): MirrorHoldCapScheduleResult[] {
  if (!(cfg.mirrorHoldCapMs > 0)) return [];

  const out: MirrorHoldCapScheduleResult[] = [];
  for (const pos of Object.values(state.positions)) {
    const decision = decideMirrorHoldCap(cfg, {
      entryTs: pos.entryTs,
      oscarPromotedAt: pos.oscarPromotedAt,
      sellBlockedUntilTs: pos.sellBlockedUntilTs,
      nowMs,
    });
    if (decision.action !== 'sell') continue;

    const kind = scheduleOrAccelerateFullSell(cfg, state, pos, nowMs);
    if (kind === 'noop') continue;
    out.push({
      mint: pos.mint,
      symbol: pos.symbol,
      heldMs: decision.heldMs,
      accelerated: kind === 'accelerated',
    });
  }
  return out;
}
