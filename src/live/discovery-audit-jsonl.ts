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

/** Extract a finite number from unknown; null/undefined → undefined; non-finite → undefined. */
function numOrUndef(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Same but allow explicit null pass-through (for nullable jsonl fields). */
function numOrNullOrUndef(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface EvalNumericTelemetry {
  priceUsd?: number | null;
  liqUsd?: number | null;
  marketCapUsd?: number | null;
  vol1hUsd?: number | null;
  vol5mUsd?: number | null;
  buySellRatio5m?: number | null;
  dipPct?: number | null;
  dipLookbackMin?: number | null;
  dipPctByWindow?: Record<string, number>;
  localHighDistMinPct?: number | null;
  priceChange30mPct?: number | null;
  priceChange1hPct?: number | null;
  bounceFromMin30mPct?: number | null;
}

/**
 * Pull numeric telemetry out of `eval` row's `m` field (= SnapshotFeatures).
 * Skips fields when source is missing/non-finite — keeps payload small.
 */
function extractEvalTelemetry(row: Record<string, unknown>): EvalNumericTelemetry {
  const out: EvalNumericTelemetry = {};
  const m = row.m;
  if (!m || typeof m !== 'object') return out;
  const f = m as Record<string, unknown>;
  const price = numOrUndef(f.price_usd);
  if (price !== undefined) out.priceUsd = price;
  const liq = numOrUndef(f.liq_usd);
  if (liq !== undefined) out.liqUsd = liq;
  const mcap = numOrNullOrUndef(f.market_cap_usd);
  if (mcap !== undefined) out.marketCapUsd = mcap;
  const v1h = numOrUndef(f.vol1h_usd);
  if (v1h !== undefined) out.vol1hUsd = v1h;
  const v5m = numOrUndef(f.vol5m_usd);
  if (v5m !== undefined) out.vol5mUsd = v5m;
  const bs = numOrNullOrUndef(f.buy_sell_ratio_5m);
  if (bs !== undefined) out.buySellRatio5m = bs;
  const dipPct = numOrNullOrUndef(f.dip_pct);
  if (dipPct !== undefined) out.dipPct = dipPct;
  const dipLb = numOrNullOrUndef(f.dip_lookback_min);
  if (dipLb !== undefined) out.dipLookbackMin = dipLb;
  const dipByWin = f.dip_pct_by_window;
  if (dipByWin && typeof dipByWin === 'object' && !Array.isArray(dipByWin)) {
    const tmp: Record<string, number> = {};
    for (const [k, v] of Object.entries(dipByWin)) {
      const n = Number(v);
      if (Number.isFinite(n)) tmp[String(k)] = +n.toFixed(2);
    }
    if (Object.keys(tmp).length > 0) out.dipPctByWindow = tmp;
  }
  const lhv = f.local_high_veto;
  if (lhv && typeof lhv === 'object') {
    const distRec = (lhv as Record<string, unknown>).distance_from_high_pct;
    if (distRec && typeof distRec === 'object' && !Array.isArray(distRec)) {
      let minDist: number | null = null;
      for (const v of Object.values(distRec)) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (minDist === null || n > minDist) minDist = n; // "closest to high" = smallest negative = max value (since values are negative or zero)
      }
      if (minDist !== null) out.localHighDistMinPct = +minDist.toFixed(2);
    }
  }
  const pap = f.policy_a_plus;
  if (pap && typeof pap === 'object') {
    const p = pap as Record<string, unknown>;
    const pc30 = numOrNullOrUndef(p.priceChange30mPct);
    if (pc30 !== undefined) out.priceChange30mPct = pc30;
    const pc1h = numOrNullOrUndef(p.priceChange1hPct);
    if (pc1h !== undefined) out.priceChange1hPct = pc1h;
    const b30 = numOrNullOrUndef(p.bounceFromMin30mPct);
    if (b30 !== undefined) out.bounceFromMin30mPct = b30;
  }
  return out;
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

/** Skip duplicate: live JSONL already records this path. */
const SKIP_OPEN_DEDUPE_REASONS = new Set(['live_mint_whitelist', 'live_permanent_deny']);

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
    const kind = row.kind;
    if (kind === 'entry_split_add' || kind === 'staged_avg_add') {
      appendLiveJsonlEvent({
        kind,
        mint: trimStr(row.mint, 64) ?? '(missing_mint)',
        ts: typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : undefined,
        price: numOrUndef(row.price),
        marketPrice: numOrUndef(row.marketPrice),
        sizeUsd: numOrUndef(row.sizeUsd),
        avgEntry: numOrUndef(row.avgEntry),
        avgEntryMarket: numOrUndef(row.avgEntryMarket),
        totalInvestedUsd: numOrUndef(row.totalInvestedUsd),
        legCount:
          typeof row.legCount === 'number' && Number.isFinite(row.legCount)
            ? Math.max(0, Math.floor(row.legCount))
            : undefined,
        mcUsdLive: numOrNullOrUndef(row.mcUsdLive),
        priorityFee: numOrUndef(row.priorityFee),
        timelineLabelRu: trimStr(row.timelineLabelRu, 512),
        liveExitProfileMode: row.liveExitProfileMode === 'B' ? 'B' : undefined,
      });
      return;
    }
    if (!enabled) return;
    if (kind === 'eval') {
      const deep = row._liveDiscoveryDeepAudit === true;
      const priority = row._priorityDiscovery === true;
      const volumeLeader = row._volumeLeaderDiscovery === true;
      if (row.pass === true && !deep && !priority && !volumeLeader) return;
      const tele = extractEvalTelemetry(row);
      appendLiveJsonlEvent({
        kind: 'live_discovery_eval',
        pass: Boolean(row.pass),
        mint: trimStr(row.mint, 64) ?? '(missing_mint)',
        symbol: trimStr(row.symbol, 64),
        lane: trimStr(row.lane, 32),
        source: trimStr(row.source, 64),
        ageMin: typeof row.ageMin === 'number' && Number.isFinite(row.ageMin) ? row.ageMin : undefined,
        tradeLane: trimStr(row.tradeLane, 32),
        volumeLeaderTier: volumeLeader ? true : undefined,
        reasons: reasonsForEval(row.reasons, row.pass === true),
        entryPath: trimStr(row.entry_path, 120),
        ...tele,
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
        tradeLane: trimStr(row.tradeLane, 32),
        openTradeLane: trimStr(row.openTradeLane, 32),
        detail: detailFromEvalSkipOpenRest(row),
      });
    }
  };
}
