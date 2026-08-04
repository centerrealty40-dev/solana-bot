/**
 * Serious ops-only watch for copy-trader.
 * Trade chatter / yellow stream flags stay out of Telegram — only stalls,
 * stuck exits, dead ingress, and prolonged leader silence.
 */

export type CopyOpsWatchSnapshot = {
  nowMs: number;
  appName: string;
  /** Last time we applied a leader buy or sell swap. */
  lastLeaderActivityTs: number;
  /** Last successful our_buy fill. */
  lastOurBuyTs: number;
  /** Count of leader buys applied in the buy-stall window. */
  leaderBuysInWindow: number;
  /** Open positions (mint → entryTs / sellBlockedUntilTs). */
  positions: Array<{ mint: string; entryTs: number; sellBlockedUntilTs?: number; symbol?: string }>;
  /** Pending sells still open. */
  pendingSells: Array<{ mint: string; leaderSellTs: number; attempts?: number; symbol?: string }>;
  /** Stream health when LEADER_STREAM=1; null if stream disabled. */
  stream: {
    subscribed: boolean;
    notifyCount: number;
    lastSubscribedAtMs: number;
    lastNotifyAtMs: number;
  } | null;
};

export type CopyOpsWatchThresholds = {
  leaderIdleMs: number;
  buyStallMs: number;
  stuckSellMs: number;
  streamDeadMs: number;
};

export type CopyOpsAlert = {
  key: string;
  text: string;
};

export function evaluateCopyOpsWatch(
  snap: CopyOpsWatchSnapshot,
  th: CopyOpsWatchThresholds,
): CopyOpsAlert[] {
  const out: CopyOpsAlert[] = [];
  const app = snap.appName || 'copy-trader';

  if (th.leaderIdleMs > 0 && snap.lastLeaderActivityTs > 0) {
    const idle = snap.nowMs - snap.lastLeaderActivityTs;
    if (idle >= th.leaderIdleMs) {
      const hours = (idle / 3_600_000).toFixed(1);
      out.push({
        key: 'leader_idle',
        text:
          `[ALERT][copy_ops] ${app}: no leader activity for ${hours}h — ` +
          `leader idle or wallet may have changed (check COPY_TRADER_TARGET_WALLET)`,
      });
    }
  }

  if (th.buyStallMs > 0 && snap.leaderBuysInWindow > 0) {
    const sinceBuy =
      snap.lastOurBuyTs > 0 ? snap.nowMs - snap.lastOurBuyTs : Number.POSITIVE_INFINITY;
    if (sinceBuy >= th.buyStallMs) {
      const hours = Number.isFinite(sinceBuy) ? (sinceBuy / 3_600_000).toFixed(1) : '∞';
      out.push({
        key: 'buy_stall',
        text:
          `[ALERT][copy_ops] ${app}: leader bought ${snap.leaderBuysInWindow}× recently but ` +
          `no our fill for ${hours}h — entries stalled (gates/RPC/slippage?)`,
      });
    }
  }

  if (th.stuckSellMs > 0) {
    const stuckPending = snap.pendingSells.filter(
      (s) => snap.nowMs - s.leaderSellTs >= th.stuckSellMs,
    );
    for (const s of stuckPending.slice(0, 3)) {
      const min = Math.round((snap.nowMs - s.leaderSellTs) / 60_000);
      out.push({
        key: `stuck_sell:${s.mint}`,
        text:
          `[ALERT][copy_ops] ${app}: sell stuck ${min}m on ${s.symbol ?? s.mint.slice(0, 8)}… ` +
          `(attempts=${s.attempts ?? 0}) — orphan bag risk`,
      });
    }
    for (const p of snap.positions) {
      if (p.sellBlockedUntilTs != null && p.sellBlockedUntilTs > snap.nowMs) {
        out.push({
          key: `sell_blocked:${p.mint}`,
          text:
            `[ALERT][copy_ops] ${app}: sell abandoned / blocked on ${p.symbol ?? p.mint.slice(0, 8)}… ` +
            `until ${new Date(p.sellBlockedUntilTs).toISOString()} — bag may be orphaned`,
        });
      }
    }
  }

  if (th.streamDeadMs > 0 && snap.stream?.subscribed) {
    const age = snap.nowMs - snap.stream.lastSubscribedAtMs;
    const neverNotified =
      snap.stream.notifyCount === 0 ||
      snap.stream.lastNotifyAtMs === 0 ||
      snap.nowMs - snap.stream.lastNotifyAtMs >= th.streamDeadMs;
    if (age >= th.streamDeadMs && neverNotified && snap.stream.notifyCount === 0) {
      out.push({
        key: 'stream_dead',
        text:
          `[ALERT][copy_ops] ${app}: leader stream subscribed ${(age / 60_000).toFixed(0)}m ` +
          `with 0 notifies — ingress may be dead (poll-only / Helius WS)`,
      });
    }
  }

  return out;
}
