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
  /**
   * First-strong branch (8zkg on 8XjTbP): buy when the *latest* 1m bar is the
   * first real green impulse — not waiting for small→small→huge.
   * 0 = off.
   */
  firstStrongMinPc?: number;
  /** Prior 1m bar must be ≤ this % (or red). Default = smallMaxPc. */
  firstStrongMaxPriorPc?: number;
};

export type TripleGreenVerdict = {
  pass: boolean;
  reasons: string[];
  /** % bodies of the matched triple (small, small, huge). */
  pattern?: { small0: number; small1: number; huge: number; hugeVol: number; hugeTs: number };
};

const ohlcvCache = new Map<string, { at: number; bars: Ohlcv1m[]; rateLimited?: boolean }>();
// Short TTL — F1Xd sat on stale last3=18.2,1.5,-2.1 while 11:45 printed +100%.
const OHLCV_TTL_MS = 20_000;
const OHLCV_TTL_429_MS = 25_000;
/** Min gap between Gecko HTTP calls process-wide (public free tier). */
const GECKO_MIN_GAP_MS = 900;
/**
 * Hard cap — raised 6→12 so triple_only can actually fetch OHLCV
 * (journal: thousands of triple_ohlcv_budget / rate_limited skips).
 */
const GECKO_MAX_HTTP_PER_MIN = 12;

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
    // Huge must clearly dominate the two smalls (was +5; +3 with hugeMin=10).
    if (!(cH > Math.max(c0, c1) + 3)) continue;
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

/**
 * First strong 1m green (leader-style): latest bar is the impulse, prior bar
 * is not already a huge green. Example 8XjTbP / 5n4FsG: last3=-8.8,16.1,42.0
 * — leader bought on the +42% candle; we waited for a later triple.
 */
export function detectFirstStrongGreen(
  bars: Ohlcv1m[],
  gates: TripleGreenGates,
  nowSec: number,
): TripleGreenVerdict {
  const minPc = gates.firstStrongMinPc ?? 0;
  if (!(minPc > 0)) {
    return { pass: false, reasons: ['first_strong_disabled'] };
  }
  if (!Array.isArray(bars) || bars.length < 2) {
    return { pass: false, reasons: ['first_strong_ohlcv_insufficient'] };
  }
  const ordered = [...bars].sort((a, b) => a.ts - b.ts);
  const latest = ordered[ordered.length - 1]!;
  const prior = ordered[ordered.length - 2]!;
  const maxAgeSec = Math.max(60, Math.floor(gates.maxAgeAfterHugeMs / 1000));
  if (nowSec - latest.ts > maxAgeSec) {
    return { pass: false, reasons: ['first_strong_stale'] };
  }
  if (!isGreen(latest)) {
    return { pass: false, reasons: ['first_strong_latest_red'] };
  }
  const cH = candleChgPct(latest);
  const cP = candleChgPct(prior);
  if (!(cH >= minPc)) {
    return {
      pass: false,
      reasons: [`first_strong_chg=${cH.toFixed(1)}<${minPc}`],
    };
  }
  const maxPrior =
    gates.firstStrongMaxPriorPc != null && gates.firstStrongMaxPriorPc > 0
      ? gates.firstStrongMaxPriorPc
      : gates.smallMaxPc;
  // Prior must not already be a huge green (then this isn't the "first" strong).
  if (isGreen(prior) && cP > maxPrior) {
    return {
      pass: false,
      reasons: [`first_strong_prior_already_huge=${cP.toFixed(1)}>${maxPrior}`],
    };
  }
  if (gates.hugeMinVolUsd > 0 && !(latest.volumeUsd >= gates.hugeMinVolUsd)) {
    return { pass: false, reasons: ['first_strong_low_vol'] };
  }
  return {
    pass: true,
    reasons: [],
    pattern: {
      small0: +cP.toFixed(2),
      small1: 0,
      huge: +cH.toFixed(2),
      hugeVol: +latest.volumeUsd.toFixed(0),
      hugeTs: latest.ts,
    },
  };
}

/**
 * Mid-impulse flex: classic triple wants huge LAST, but leaders often buy
 * on the huge bar while the tip consolidates / prints soft red
 * (Y8ETVJ last3=-29.6,+47.1,-3.3). Accept huge in last3 when fresh; tip may
 * be mild red if the impulse is not the latest bar.
 */
export function detectLeaderImpulseGreen(
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
  const last3 = ordered.slice(-3);
  if (last3.length < 3) {
    return { pass: false, reasons: ['triple_ohlcv_insufficient'] };
  }
  const maxAgeSec = Math.max(60, Math.floor(gates.maxAgeAfterHugeMs / 1000));
  const chgs = last3.map((b) => candleChgPct(b));
  // Find the biggest green bar in last3 as the impulse first (tip may be red).
  let bestIdx = -1;
  let bestChg = -Infinity;
  for (let i = 0; i < 3; i++) {
    const b = last3[i]!;
    const c = chgs[i]!;
    if (!isGreen(b)) continue;
    if (c >= gates.hugeMinPc && c > bestChg) {
      bestChg = c;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) {
    return {
      pass: false,
      reasons: [
        'leader_impulse_no_huge',
        `last3_chg=${chgs.map((x) => x.toFixed(1)).join(',')}`,
      ],
    };
  }
  const tipChg = chgs[2]!;
  const hugeIsTip = bestIdx === 2;
  // Tip = impulse: must stay green. Mid-impulse: allow mild tip pullback.
  const maxTipPullbackPc = Math.max(8, gates.smallMaxPc);
  if (hugeIsTip) {
    if (!isGreen(last3[2]!) || !(tipChg > gates.smallMinPc)) {
      return {
        pass: false,
        reasons: [
          'leader_impulse_latest_not_green',
          `last3_chg=${chgs.map((x) => x.toFixed(1)).join(',')}`,
        ],
      };
    }
  } else if (tipChg < -maxTipPullbackPc) {
    return {
      pass: false,
      reasons: [
        `leader_impulse_tip_dump=${tipChg.toFixed(1)}<-${maxTipPullbackPc}`,
        `last3_chg=${chgs.map((x) => x.toFixed(1)).join(',')}`,
      ],
    };
  }
  const hugeBar = last3[bestIdx]!;
  if (nowSec - hugeBar.ts > maxAgeSec) {
    return { pass: false, reasons: ['leader_impulse_stale'] };
  }
  if (gates.hugeMinVolUsd > 0 && !(hugeBar.volumeUsd >= gates.hugeMinVolUsd)) {
    return { pass: false, reasons: ['leader_impulse_low_vol'] };
  }
  // Need at least one other green in the window (not a lone wick).
  const otherGreen = last3.some(
    (b, i) => i !== bestIdx && isGreen(b) && candleChgPct(b) > gates.smallMinPc,
  );
  if (!otherGreen) {
    return { pass: false, reasons: ['leader_impulse_no_setup_green'] };
  }
  const others = chgs.filter((_, i) => i !== bestIdx);
  return {
    pass: true,
    reasons: [],
    pattern: {
      small0: +others[0]!.toFixed(2),
      small1: +others[1]!.toFixed(2),
      huge: +bestChg.toFixed(2),
      hugeVol: +hugeBar.volumeUsd.toFixed(0),
      hugeTs: hugeBar.ts,
    },
  };
}

export type OhlcvFetchResult = {
  bars: Ohlcv1m[];
  rateLimited: boolean;
  /** True when process-wide HTTP budget exhausted (no request sent). */
  budgetSkipped?: boolean;
};

export async function fetchGeckoOhlcv1m(
  pairAddress: string,
  opts?: {
    fetchImpl?: typeof fetch;
    limit?: number;
    nowMs?: number;
    /** Leader-highlight: may exceed process budget (still serialized). */
    priority?: boolean;
  },
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
    // Leader-highlight may exceed soft budget so we don't miss must-see mints
    // (5mPVUc: rate_limited/budget while 8zkg bought).
    if (!opts?.priority && !geckoBudgetAllow(t)) {
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
  const ordered = [...buckets.values()]
    .map(({ n: _n, ...bar }) => bar)
    .sort((a, b) => a.ts - b.ts);
  // Sparse stream samples often yield 1 tick/minute → open===close (flat).
  // Stitch open to previous close so 1m % matches the price path leaders see.
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    cur.open = prev.close;
    cur.high = Math.max(cur.high, cur.open, cur.close);
    cur.low = Math.min(cur.low, cur.open, cur.close);
  }
  return ordered;
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
  /** Leader-highlight: bypass soft Gecko budget skip. */
  geckoPriority?: boolean;
  /** Leader-highlight: also accept huge-in-middle impulse (not only classic triple). */
  leaderFlex?: boolean;
}): Promise<TripleGreenVerdict> {
  if (!args.gates.enabled) {
    return { pass: false, reasons: ['triple_green_disabled'] };
  }
  const nowMs = args.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const leaderFlex = args.leaderFlex === true || args.geckoPriority === true;

  const tryPaths = (bars: Ohlcv1m[], volGate: TripleGreenGates): TripleGreenVerdict | null => {
    const classic = detectTripleGreen(bars, volGate, nowSec);
    if (classic.pass) return classic;
    const first = detectFirstStrongGreen(bars, volGate, nowSec);
    if (first.pass) return first;
    if (leaderFlex) {
      const flex = detectLeaderImpulseGreen(bars, volGate, nowSec);
      if (flex.pass) return flex;
    }
    return null;
  };

  // 1) Local 1m bars from stream/dex prices — race the candle.
  let localMissReason: string | null = null;
  if (args.localPriceSamples && args.localPriceSamples.length >= 2) {
    const localBars = buildOhlcv1mFromPriceSamples(args.localPriceSamples, { nowMs });
    if (localBars.length >= 2) {
      const localGates = { ...args.gates, hugeMinVolUsd: 0 };
      const hit = tryPaths(localBars, localGates);
      if (hit) return hit;
      if (localBars.length < 3) {
        localMissReason = `triple_local_bars=${localBars.length}<3`;
      } else {
        localMissReason = 'triple_pattern_not_found';
      }
    } else {
      localMissReason = `triple_local_bars=${localBars.length}<2`;
    }
  } else {
    localMissReason = `triple_local_samples=${args.localPriceSamples?.length ?? 0}<2`;
  }

  // 2) Gecko fallback — optional + budgeted.
  const pair = args.pairAddress?.trim();
  if (!pair) {
    // Stream-impulse path: no pair — surface local miss + last3 / first_strong detail.
    if (args.localPriceSamples && args.localPriceSamples.length >= 2) {
      const localBars = buildOhlcv1mFromPriceSamples(args.localPriceSamples, { nowMs });
      if (localBars.length >= 2) {
        const localGates = { ...args.gates, hugeMinVolUsd: 0 };
        const classic = detectTripleGreen(localBars, localGates, nowSec);
        const first = detectFirstStrongGreen(localBars, localGates, nowSec);
        return {
          pass: false,
          reasons: [
            ...(classic.reasons.length
              ? classic.reasons
              : [localMissReason ?? 'triple_pattern_not_found']),
            ...(first.reasons[0] && first.reasons[0] !== 'first_strong_disabled'
              ? [first.reasons[0]]
              : []),
          ],
        };
      }
    }
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
    priority: args.geckoPriority === true,
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
  const hit = tryPaths(fetched.bars, args.gates);
  if (hit) return hit;
  const classic = detectTripleGreen(fetched.bars, args.gates, nowSec);
  const first = detectFirstStrongGreen(fetched.bars, args.gates, nowSec);
  return {
    pass: false,
    reasons: [
      ...(classic.reasons.length ? classic.reasons : [localMissReason ?? 'triple_pattern_not_found']),
      ...(first.reasons[0] && first.reasons[0] !== 'first_strong_disabled'
        ? [first.reasons[0]]
        : []),
    ],
  };
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
