/**
 * W8.0-p7.1 (P7-I9) — paper ticket vs live limits alignment for `live-oscar`.
 */

export function evaluateLiveNotionalParity(args: {
  strict: boolean;
  strategyEnabled: boolean;
  executionMode: string;
  paperPositionUsd: number;
  liveMaxPositionUsd?: number;
  liveEntryNotionalUsd?: number;
}): { ok: true } | { ok: false; detail: Record<string, unknown> } {
  if (!args.strict || !args.strategyEnabled || args.executionMode !== 'live') return { ok: true };
  const x = args.paperPositionUsd;
  if (!(Number.isFinite(x) && x > 0)) {
    return {
      ok: false,
      detail: {
        limit: 'parity_notional_mismatch',
        reason: 'invalid_paper_position_usd',
        paperPositionUsd: x,
      },
    };
  }
  const max = args.liveMaxPositionUsd;
  if (max != null && Number.isFinite(max) && x > max + 1e-6) {
    return {
      ok: false,
      detail: {
        limit: 'parity_notional_mismatch',
        reason: 'paper_exceeds_live_max_position_usd',
        paperPositionUsd: x,
        liveMaxPositionUsd: max,
        liveEntryNotionalUsd: args.liveEntryNotionalUsd ?? null,
      },
    };
  }
  const entry = args.liveEntryNotionalUsd;
  if (entry != null && Number.isFinite(entry) && Math.abs(entry - x) > 1e-6) {
    return {
      ok: false,
      detail: {
        limit: 'parity_notional_mismatch',
        reason: 'paper_vs_live_entry_notional_usd',
        paperPositionUsd: x,
        liveMaxPositionUsd: max ?? null,
        liveEntryNotionalUsd: entry,
      },
    };
  }
  return { ok: true };
}
