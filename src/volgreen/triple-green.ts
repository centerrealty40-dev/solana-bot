/**
 * Sole vol-green entry: 1m candle structure
 *   small green → small green → huge green
 * (Prometheus / 8zkg 10:43–10:45: +6.5%, +9.3%, +30.5%).
 *
 * OHLCV from GeckoTerminal (public). Cheap structural filters must pass
 * before this is called — do not fan out to every mint.
 */

export type Ohlcv1m = {
  /** Candle open time unix seconds. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

export type TripleGreenGates = {
  /** Master switch — when true, discover uses only this path. */
  enabled: boolean;
  /** Small green body % (exclusive min, inclusive max). */
  smallMinPc: number;
  smallMaxPc: number;
  /** Huge green body % (inclusive min). */
  hugeMinPc: number;
  /** Min USD volume on the huge candle (0 = off). */
  hugeMinVolUsd: number;
  /**
   * Enter while the huge candle is still the latest completed bar, or within
   * this many ms after its open (default 3m — buy on/just after the spike).
   */
  maxAgeAfterHugeMs: number;
};

export type TripleGreenVerdict = {
  pass: boolean;
  reasons: string[];
  /** % bodies of the matched triple (small, small, huge). */
  pattern?: { small0: number; small1: number; huge: number; hugeVol: number; hugeTs: number };
};

const ohlcvCache = new Map<string, { at: number; bars: Ohlcv1m[] }>();
const OHLCV_TTL_MS = 25_000;

function candleChgPct(b: Ohlcv1m): number {
  if (!(b.open > 0)) return 0;
  return ((b.close / b.open) - 1) * 100;
}

function isGreen(b: Ohlcv1m): boolean {
  return b.close > b.open;
}

/** Pure detector — unit-testable without network. */
export function detectTripleGreen(
  bars: Ohlcv1m[],
  gates: TripleGreenGates,
  nowSec: number,
): TripleGreenVerdict {
  if (!gates.enabled) {
    return { pass: false, reasons: ['triple_green_disabled'] };
  }
  if (!Array.isArray(bars) || bars.length < 3) {
    return { pass: false, reasons: ['triple_ohlcv_insufficient'] };
  }

  const ordered = [...bars].sort((a, b) => a.ts - b.ts);
  const maxAgeSec = Math.max(60, Math.floor(gates.maxAgeAfterHugeMs / 1000));
  const reasons: string[] = [];

  // Scan newest-first for a fresh huge leg.
  for (let i = ordered.length - 1; i >= 2; i--) {
    const huge = ordered[i]!;
    const s1 = ordered[i - 1]!;
    const s0 = ordered[i - 2]!;
    // Prefer consecutive 1m opens (allow 1m gap for missing bars).
    if (huge.ts - s1.ts > 180 || s1.ts - s0.ts > 180) continue;
    if (nowSec - huge.ts > maxAgeSec) continue;

    const c0 = candleChgPct(s0);
    const c1 = candleChgPct(s1);
    const cH = candleChgPct(huge);

    if (!isGreen(s0) || !isGreen(s1) || !isGreen(huge)) continue;
    if (!(c0 > gates.smallMinPc && c0 <= gates.smallMaxPc)) continue;
    if (!(c1 > gates.smallMinPc && c1 <= gates.smallMaxPc)) continue;
    if (!(cH >= gates.hugeMinPc)) continue;
    // Huge must dominate the two smalls (not three equal mediums).
    if (!(cH > Math.max(c0, c1) + 5)) continue;
    if (gates.hugeMinVolUsd > 0 && !(huge.volumeUsd >= gates.hugeMinVolUsd)) continue;

    return {
      pass: true,
      reasons: [],
      pattern: {
        small0: +c0.toFixed(2),
        small1: +c1.toFixed(2),
        huge: +cH.toFixed(2),
        hugeVol: +huge.volumeUsd.toFixed(0),
        hugeTs: huge.ts,
      },
    };
  }

  reasons.push('triple_pattern_not_found');
  // Debug hint from last 3 completed bars.
  const last3 = ordered.slice(-3);
  if (last3.length === 3) {
    const ch = last3.map((b) => candleChgPct(b));
    reasons.push(
      `last3_chg=${ch.map((x) => x.toFixed(1)).join(',')}`,
    );
  }
  return { pass: false, reasons };
}

export async function fetchGeckoOhlcv1m(
  pairAddress: string,
  opts?: { fetchImpl?: typeof fetch; limit?: number; nowMs?: number },
): Promise<Ohlcv1m[]> {
  const pair = pairAddress?.trim();
  if (!pair || pair.length < 32) return [];
  const nowMs = opts?.nowMs ?? Date.now();
  const cached = ohlcvCache.get(pair);
  if (cached && nowMs - cached.at < OHLCV_TTL_MS) return cached.bars;

  const limit = Math.max(10, Math.min(120, opts?.limit ?? 40));
  const url =
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/` +
    `${encodeURIComponent(pair)}/ohlcv/minute?aggregate=1&limit=${limit}&currency=usd`;
  const doFetch = opts?.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: unknown[] } };
    };
    const raw = j.data?.attributes?.ohlcv_list;
    if (!Array.isArray(raw)) return [];
    const bars: Ohlcv1m[] = [];
    for (const row of raw) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const ts = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      const volumeUsd = Number(row[5]);
      if (!(ts > 0) || !(open > 0) || !(close > 0)) continue;
      bars.push({
        ts,
        open,
        high: high > 0 ? high : Math.max(open, close),
        low: low > 0 ? low : Math.min(open, close),
        close,
        volumeUsd: Number.isFinite(volumeUsd) ? volumeUsd : 0,
      });
    }
    ohlcvCache.set(pair, { at: nowMs, bars });
    return bars;
  } catch {
    return [];
  }
}

export async function evaluateTripleGreenEntry(args: {
  pairAddress: string | null | undefined;
  gates: TripleGreenGates;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<TripleGreenVerdict> {
  if (!args.gates.enabled) {
    return { pass: false, reasons: ['triple_green_disabled'] };
  }
  const pair = args.pairAddress?.trim();
  if (!pair) return { pass: false, reasons: ['triple_missing_pair'] };
  const bars = await fetchGeckoOhlcv1m(pair, {
    fetchImpl: args.fetchImpl,
    nowMs: args.nowMs,
  });
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  return detectTripleGreen(bars, args.gates, nowSec);
}

/** Test helper — clear OHLCV L1 cache. */
export function __resetTripleGreenCacheForTests(): void {
  ohlcvCache.clear();
}
