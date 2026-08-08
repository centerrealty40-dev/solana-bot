/**
 * Sole vol-green entry: 1m candle structure
 *   small green → small green → huge green
 * (Prometheus / 8zkg 10:43–10:45: +6.5%, +9.3%, +30.5%).
 *
 * OHLCV from GeckoTerminal (public). Serialized + cached to avoid 429 storms.
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

const ohlcvCache = new Map<string, { at: number; bars: Ohlcv1m[]; rateLimited?: boolean }>();
// Short TTL — F1Xd sat on stale last3=18.2,1.5,-2.1 while 11:45 printed +100%.
const OHLCV_TTL_MS = 25_000;
const OHLCV_TTL_429_MS = 35_000;
/** Min gap between Gecko HTTP calls process-wide (public free tier). */
const GECKO_MIN_GAP_MS = 1_500;
/** Hard cap — without this every enrich mint hits 429 and buys die. */
const GECKO_MAX_HTTP_PER_MIN = 6;

let geckoChain: Promise<void> = Promise.resolve();
let geckoNextAt = 0;
let geckoHttpWindowStartMs = 0;
let geckoHttpInWindow = 0;

function geckoBudgetAllow(nowMs: number): boolean {
  if (nowMs - geckoHttpWindowStartMs >= 60_000) {
    geckoHttpWindowStartMs = nowMs;
    geckoHttpInWindow = 0;
  }
  return geckoHttpInWindow < GECKO_MAX_HTTP_PER_MIN;
}

function geckoBudgetConsume(nowMs: number): void {
  if (nowMs - geckoHttpWindowStartMs >= 60_000) {
    geckoHttpWindowStartMs = nowMs;
    geckoHttpInWindow = 0;
  }
  geckoHttpInWindow += 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withGeckoSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = geckoChain.then(async () => {
    const wait = Math.max(0, geckoNextAt - Date.now());
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      geckoNextAt = Date.now() + GECKO_MIN_GAP_MS;
    }
  });
  // Keep chain alive even if fn throws.
  geckoChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function candleChgPct(b: Ohlcv1m): number {
  if (!(b.open > 0)) return 0;
  return (b.close / b.open - 1) * 100;
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

  for (let i = ordered.length - 1; i >= 2; i--) {
    const huge = ordered[i]!;
    const s1 = ordered[i - 1]!;
    const s0 = ordered[i - 2]!;
    if (huge.ts - s1.ts > 180 || s1.ts - s0.ts > 180) continue;
    if (nowSec - huge.ts > maxAgeSec) continue;

    const c0 = candleChgPct(s0);
    const c1 = candleChgPct(s1);
    const cH = candleChgPct(huge);

    if (!isGreen(s0) || !isGreen(s1) || !isGreen(huge)) continue;
    if (!(c0 > gates.smallMinPc && c0 <= gates.smallMaxPc)) continue;
    if (!(c1 > gates.smallMinPc && c1 <= gates.smallMaxPc)) continue;
    if (!(cH >= gates.hugeMinPc)) continue;
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

  const reasons = ['triple_pattern_not_found'];
  const last3 = ordered.slice(-3);
  if (last3.length === 3) {
    const ch = last3.map((b) => candleChgPct(b));
    reasons.push(`last3_chg=${ch.map((x) => x.toFixed(1)).join(',')}`);
  }
  return { pass: false, reasons };
}

export type OhlcvFetchResult = {
  bars: Ohlcv1m[];
  rateLimited: boolean;
  /** True when process-wide HTTP budget exhausted (no request sent). */
  budgetSkipped?: boolean;
};

export async function fetchGeckoOhlcv1m(
  pairAddress: string,
  opts?: { fetchImpl?: typeof fetch; limit?: number; nowMs?: number },
): Promise<OhlcvFetchResult> {
  const pair = pairAddress?.trim();
  if (!pair || pair.length < 32) return { bars: [], rateLimited: false };
  const nowMs = opts?.nowMs ?? Date.now();
  const cached = ohlcvCache.get(pair);
  if (cached && nowMs - cached.at < (cached.rateLimited ? OHLCV_TTL_429_MS : OHLCV_TTL_MS)) {
    return { bars: cached.bars, rateLimited: !!cached.rateLimited };
  }

  const limit = Math.max(10, Math.min(120, opts?.limit ?? 40));
  const url =
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/` +
    `${encodeURIComponent(pair)}/ohlcv/minute?aggregate=1&limit=${limit}&currency=usd`;
  const doFetch = opts?.fetchImpl ?? fetch;

  return withGeckoSlot(async () => {
    // Re-check cache after waiting for slot.
    const again = ohlcvCache.get(pair);
    const t = Date.now();
    if (again && t - again.at < (again.rateLimited ? OHLCV_TTL_429_MS : OHLCV_TTL_MS)) {
      return { bars: again.bars, rateLimited: !!again.rateLimited };
    }
    if (!geckoBudgetAllow(t)) {
      if (again && again.bars.length > 0) {
        return { bars: again.bars, rateLimited: false };
      }
      return { bars: [], rateLimited: false, budgetSkipped: true };
    }
    geckoBudgetConsume(t);
    try {
      const res = await doFetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 429) {
        ohlcvCache.set(pair, { at: t, bars: again?.bars ?? [], rateLimited: true });
        return { bars: again?.bars ?? [], rateLimited: true };
      }
      if (!res.ok) {
        ohlcvCache.set(pair, { at: t, bars: [], rateLimited: false });
        return { bars: [], rateLimited: false };
      }
      const j = (await res.json()) as {
        data?: { attributes?: { ohlcv_list?: unknown[] } };
        status?: { error_code?: string | number };
      };
      if (j.status?.error_code === 429 || j.status?.error_code === '429') {
        ohlcvCache.set(pair, { at: t, bars: [], rateLimited: true });
        return { bars: [], rateLimited: true };
      }
      const raw = j.data?.attributes?.ohlcv_list;
      if (!Array.isArray(raw)) {
        ohlcvCache.set(pair, { at: t, bars: [], rateLimited: false });
        return { bars: [], rateLimited: false };
      }
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
      ohlcvCache.set(pair, { at: t, bars, rateLimited: false });
      return { bars, rateLimited: false };
    } catch {
      ohlcvCache.set(pair, { at: t, bars: [], rateLimited: false });
      return { bars: [], rateLimited: false };
    }
  });
}

/**
 * Build 1m OHLCV from local price-ring / stream samples.
 * Volume = sample count (proxy); callers should set hugeMinVolUsd=0 for local.
 */
export function buildOhlcv1mFromPriceSamples(
  samples: Array<{ tsMs: number; priceUsd: number }>,
  opts?: { lookbackMs?: number; nowMs?: number },
): Ohlcv1m[] {
  const nowMs = opts?.nowMs ?? Date.now();
  const lookback = opts?.lookbackMs ?? 20 * 60_000;
  const cut = nowMs - lookback;
  const buckets = new Map<number, Ohlcv1m & { n: number }>();
  for (const s of samples) {
    if (s.tsMs < cut || !(s.priceUsd > 0)) continue;
    const minuteSec = Math.floor(s.tsMs / 60_000) * 60;
    let b = buckets.get(minuteSec);
    if (!b) {
      b = {
        ts: minuteSec,
        open: s.priceUsd,
        high: s.priceUsd,
        low: s.priceUsd,
        close: s.priceUsd,
        volumeUsd: 0,
        n: 0,
      };
      buckets.set(minuteSec, b);
    }
    b.high = Math.max(b.high, s.priceUsd);
    b.low = Math.min(b.low, s.priceUsd);
    b.close = s.priceUsd;
    b.n += 1;
    // Proxy vol so hugeMinVol can stay on when mixed with gecko later.
    b.volumeUsd = b.n * 80;
  }
  return [...buckets.values()]
    .map(({ n: _n, ...bar }) => bar)
    .sort((a, b) => a.ts - b.ts);
}

export async function evaluateTripleGreenEntry(args: {
  pairAddress: string | null | undefined;
  gates: TripleGreenGates;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** Local stream/dex price samples — preferred (faster than Gecko / leaders). */
  localPriceSamples?: Array<{ tsMs: number; priceUsd: number }>;
  /**
   * When false, never hit Gecko HTTP (local/cache only). Use for non-priority
   * mints so force/hot keep the 6/min budget.
   */
  allowGeckoHttp?: boolean;
}): Promise<TripleGreenVerdict> {
  if (!args.gates.enabled) {
    return { pass: false, reasons: ['triple_green_disabled'] };
  }
  const nowMs = args.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // 1) Local 1m bars from stream/dex prices — race the candle.
  let localMissReason: string | null = null;
  if (args.localPriceSamples && args.localPriceSamples.length >= 3) {
    const localBars = buildOhlcv1mFromPriceSamples(args.localPriceSamples, { nowMs });
    if (localBars.length >= 3) {
      const localGates = { ...args.gates, hugeMinVolUsd: 0 };
      const localHit = detectTripleGreen(localBars, localGates, nowSec);
      if (localHit.pass) return localHit;
      localMissReason = localHit.reasons[0] ?? 'triple_pattern_not_found';
    } else {
      localMissReason = `triple_local_bars=${localBars.length}<3`;
    }
  } else {
    localMissReason = `triple_local_samples=${args.localPriceSamples?.length ?? 0}<3`;
  }

  // 2) Gecko fallback — optional + budgeted.
  const pair = args.pairAddress?.trim();
  if (!pair) {
    return {
      pass: false,
      reasons: [localMissReason ?? 'triple_missing_pair_and_local_bars'],
    };
  }
  if (args.allowGeckoHttp === false) {
    // Still serve warm cache without consuming HTTP budget.
    const cached = ohlcvCache.get(pair);
    if (cached && !cached.rateLimited && cached.bars.length >= 3) {
      return detectTripleGreen(cached.bars, args.gates, nowSec);
    }
    return {
      pass: false,
      reasons: [localMissReason ?? 'triple_pattern_not_found', 'triple_gecko_deferred'],
    };
  }
  const fetched = await fetchGeckoOhlcv1m(pair, {
    fetchImpl: args.fetchImpl,
    nowMs,
  });
  if (fetched.budgetSkipped) {
    return {
      pass: false,
      reasons: [localMissReason ?? 'triple_pattern_not_found', 'triple_ohlcv_budget'],
    };
  }
  if (fetched.rateLimited && fetched.bars.length < 3) {
    return {
      pass: false,
      reasons: [localMissReason ?? 'triple_pattern_not_found', 'triple_ohlcv_rate_limited'],
    };
  }
  if (fetched.bars.length < 3) {
    return {
      pass: false,
      reasons: [localMissReason ?? 'triple_ohlcv_insufficient'],
    };
  }
  return detectTripleGreen(fetched.bars, args.gates, nowSec);
}

/** Trending Solana pools → base mints (no Helius). */
export async function discoverGeckoTrendingMints(opts?: {
  fetchImpl?: typeof fetch;
  pages?: number;
}): Promise<string[]> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const pages = Math.max(1, Math.min(3, opts?.pages ?? 2));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`;
    try {
      const res = await withGeckoSlot(async () =>
        doFetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        }),
      );
      if (!res.ok) break;
      const j = (await res.json()) as {
        data?: Array<{
          relationships?: { base_token?: { data?: { id?: string } } };
        }>;
      };
      for (const row of j.data ?? []) {
        const id = row.relationships?.base_token?.data?.id ?? '';
        // id like "solana_So111..." or "solana_<mint>"
        const mint = id.includes('_') ? id.slice(id.indexOf('_') + 1) : '';
        if (mint.length >= 32 && !seen.has(mint)) {
          seen.add(mint);
          out.push(mint);
        }
      }
    } catch {
      break;
    }
  }
  return out;
}

/** Test helper — clear OHLCV L1 cache. */
export function __resetTripleGreenCacheForTests(): void {
  ohlcvCache.clear();
  geckoNextAt = 0;
}
