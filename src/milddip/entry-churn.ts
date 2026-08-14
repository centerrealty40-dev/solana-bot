import type { MildDipConfig } from './config.js';
import type { MildDipState } from './state.js';

export const ENTRY_CHURN_WINDOW_MS = 86_400_000;

/** Prune and count entry timestamps inside the rolling window. */
export function recentEntryCount(
  state: MildDipState,
  mint: string,
  nowMs: number,
  windowMs = ENTRY_CHURN_WINDOW_MS,
): number {
  const raw = state.recentEntryMsByMint?.[mint];
  if (!raw?.length) return 0;
  const cutoff = nowMs - windowMs;
  let n = 0;
  for (const ts of raw) {
    if (ts >= cutoff) n += 1;
  }
  return n;
}

export function maxEntriesBlock(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  nowMs: number,
): { block: boolean; count: number; limit: number } {
  const limit = cfg.maxEntriesPerMint24h;
  if (!(limit > 0)) return { block: false, count: 0, limit: 0 };
  const count = recentEntryCount(state, mint, nowMs);
  return { block: count >= limit, count, limit };
}

/** Record a successful buy for anti-churn window (prunes stale stamps). */
export function noteMintEntry(state: MildDipState, mint: string, nowMs: number): void {
  if (!state.recentEntryMsByMint) state.recentEntryMsByMint = {};
  const cutoff = nowMs - ENTRY_CHURN_WINDOW_MS;
  const prev = state.recentEntryMsByMint[mint] ?? [];
  state.recentEntryMsByMint[mint] = [...prev.filter((t) => t >= cutoff), nowMs];
}

export function sanitizeRecentEntryMsByMint(raw: unknown): Record<string, number[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number[]> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !Array.isArray(v)) continue;
    const stamps = v
      .map((x) => Number(x))
      .filter((t) => Number.isFinite(t) && t > 0);
    if (stamps.length) out[mint] = stamps;
  }
  return out;
}
