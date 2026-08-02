/**
 * Per-mint record of how the leader has historically traded a token.
 *
 * A "session" is one flat-to-flat round trip by the leader. The 30d audit of
 * 8zkgFGVZ showed that mints the leader revisits with a positive track record
 * carry essentially all of his profit, while one-off entries are net negative —
 * so the copy gate needs this history before it can size a decision.
 */
import type { CopyTraderState, LeaderMintHistory } from './state.js';

export type LeaderMintStats = {
  sessions: number;
  avgPct: number;
  winRatePct: number;
  lastClosedTs: number | null;
};

export function getLeaderHistory(state: CopyTraderState, mint: string): LeaderMintHistory {
  const existing = state.leaderHistory[mint];
  if (existing) return existing;
  const fresh: LeaderMintHistory = { sessions: 0, wins: 0, sumPct: 0 };
  state.leaderHistory[mint] = fresh;
  return fresh;
}

export function leaderMintStats(state: CopyTraderState, mint: string): LeaderMintStats | null {
  const row = state.leaderHistory[mint];
  if (!row || row.sessions <= 0) return null;
  return {
    sessions: row.sessions,
    avgPct: row.sumPct / row.sessions,
    winRatePct: (row.wins / row.sessions) * 100,
    lastClosedTs: row.lastClosedTs ?? null,
  };
}

/** Session returns are winsorized so one 40× print cannot dominate the mint average. */
const MAX_SESSION_PCT = 300;
const MIN_SESSION_PCT = -100;

export type LeaderSwapHistoryInput = {
  mint: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  /** Leader balance after this swap — flat (≤ dust) closes the session. */
  leaderBalanceAfterRaw: bigint;
  dustRaw: bigint;
  nowMs: number;
};

/**
 * Fold one observed leader swap into the mint history. Returns the closed
 * session return in percent when this swap took the leader flat.
 */
export function applyLeaderSwapToHistory(
  state: CopyTraderState,
  input: LeaderSwapHistoryInput,
): number | null {
  const row = getLeaderHistory(state, input.mint);
  const usd = Number.isFinite(input.amountUsd) && input.amountUsd > 0 ? input.amountUsd : 0;

  if (input.side === 'buy') {
    row.openCostUsd = (row.openCostUsd ?? 0) + usd;
    row.openStartTs ??= input.nowMs;
    return null;
  }

  row.openProceedsUsd = (row.openProceedsUsd ?? 0) + usd;

  const flat = input.leaderBalanceAfterRaw <= input.dustRaw;
  if (!flat) return null;

  const cost = row.openCostUsd ?? 0;
  const proceeds = row.openProceedsUsd ?? 0;
  // Leader was already holding when we started watching — no cost basis to score.
  if (!(cost > 0)) {
    resetOpenSession(row);
    return null;
  }

  const pct = Math.max(MIN_SESSION_PCT, Math.min(MAX_SESSION_PCT, (proceeds / cost - 1) * 100));
  row.sessions += 1;
  row.sumPct += pct;
  if (pct > 0) row.wins += 1;
  row.lastClosedTs = input.nowMs;
  resetOpenSession(row);
  return pct;
}

function resetOpenSession(row: LeaderMintHistory): void {
  delete row.openCostUsd;
  delete row.openProceedsUsd;
  delete row.openStartTs;
}

/** Drop mints the leader has not touched in `ttlMs` and is not currently holding. */
export function gcLeaderHistory(state: CopyTraderState, ttlMs: number, nowMs = Date.now()): number {
  const cutoff = nowMs - ttlMs;
  let dropped = 0;
  for (const [mint, row] of Object.entries(state.leaderHistory)) {
    if (row.openCostUsd != null) continue;
    const last = row.lastClosedTs ?? 0;
    if (last >= cutoff) continue;
    delete state.leaderHistory[mint];
    dropped += 1;
  }
  return dropped;
}
