/**
 * Mirror paper `eval` / `eval-skip-open` rows into validated live JSONL so ops can see gate failures
 * (live-oscar uses noop `journalAppend` for paper store — W8.0 P4-I1).
 */
import { appendLiveJsonlEvent } from './store-jsonl.js';

function trimStr(v: unknown, max: number): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.length <= max ? s : s.slice(0, max);
}

function normalizeReasons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['(no_reasons)'];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (!t) continue;
    out.push(t.length <= 400 ? t : t.slice(0, 400));
    if (out.length >= 40) break;
  }
  return out.length ? out : ['(no_reasons)'];
}

function reasonsForEval(raw: unknown, passTrue: boolean): string[] {
  if (passTrue) {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const x of raw) {
      if (typeof x !== 'string') continue;
      const t = x.trim();
      if (!t) continue;
      out.push(t.length <= 400 ? t : t.slice(0, 400));
      if (out.length >= 24) break;
    }
    return out;
  }
  return normalizeReasons(raw);
}

/** Skip duplicate: `live_whitelist_skip` already records this path. */
const SKIP_OPEN_DEDUPE_REASONS = new Set(['live_mint_whitelist']);

function detailFromEvalSkipOpenRest(row: Record<string, unknown>): string | undefined {
  const { kind: _k, mint: _m, symbol: _s, lane: _l, source: _src, reason: _r, ...rest } = row;
  const keys = Object.keys(rest);
  if (!keys.length) return undefined;
  try {
    return JSON.stringify(rest).slice(0, 2000);
  } catch {
    return undefined;
  }
}

/**
 * Returns a `journalAppend` handler for `paperOscarMain` when running live-oscar.
 */
export function createLiveDiscoveryAuditJournalAppend(enabled: boolean): (event: Record<string, unknown>) => void {
  return (row) => {
    if (!enabled) return;
    const kind = row.kind;
    if (kind === 'eval') {
      const deep = row._liveDiscoveryDeepAudit === true;
      if (row.pass === true && !deep) return;
      appendLiveJsonlEvent({
        kind: 'live_discovery_eval',
        pass: Boolean(row.pass),
        mint: trimStr(row.mint, 64) ?? '(missing_mint)',
        symbol: trimStr(row.symbol, 64),
        lane: trimStr(row.lane, 32),
        source: trimStr(row.source, 64),
        ageMin: typeof row.ageMin === 'number' && Number.isFinite(row.ageMin) ? row.ageMin : undefined,
        reasons: reasonsForEval(row.reasons, row.pass === true),
        entryPath: trimStr(row.entry_path, 120),
      });
      return;
    }
    if (kind === 'live_discovery_tick_skip') {
      appendLiveJsonlEvent({
        kind: 'live_discovery_tick_skip',
        mint: trimStr(row.mint, 64) ?? '(missing_mint)',
        symbol: trimStr(row.symbol, 64),
        lane: trimStr(row.lane, 32),
        source: trimStr(row.source, 64),
        reason: trimStr(row.reason, 120) ?? 'unknown',
        discoveryReevalSec:
          typeof row.discoveryReevalSec === 'number' && Number.isFinite(row.discoveryReevalSec)
            ? Math.floor(row.discoveryReevalSec)
            : undefined,
      });
      return;
    }
    if (kind === 'live_discovery_universe_miss') {
      appendLiveJsonlEvent({
        kind: 'live_discovery_universe_miss',
        mint: trimStr(row.mint, 64) ?? '(missing_mint)',
        symbol: trimStr(row.symbol, 64),
        lane: trimStr(row.lane, 32),
        source: trimStr(row.source, 64),
        reasons: normalizeReasons(row.reasons),
        snapshotHint: trimStr(row.snapshotHint, 1600),
      });
      return;
    }
    if (kind === 'eval-skip-open') {
      const reason = trimStr(row.reason, 500) ?? 'unknown';
      if (SKIP_OPEN_DEDUPE_REASONS.has(reason)) return;
      appendLiveJsonlEvent({
        kind: 'live_discovery_skip_open',
        mint: trimStr(row.mint, 64) ?? '(missing_mint)',
        symbol: trimStr(row.symbol, 64),
        lane: trimStr(row.lane, 32),
        source: trimStr(row.source, 64),
        reason,
        detail: detailFromEvalSkipOpenRest(row),
      });
    }
  };
}
