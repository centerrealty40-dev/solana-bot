type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type Candle = { tsMs: number; low: number };
export type MirrorAverageSkipReason =
  | 'first_clip_incomplete'
  | 'no_reference'
  | 'leader_not_held'
  | 'average_limit_reached'
  | 'average_attempt_cooldown'
  | 'average_disabled'
  | 'buy_in_flight'
  | 'sell_in_flight'
  | 'local_low_unavailable'
  | 'hold_not_reached'
  | 'price_not_at_low'
  | 'size_stop';

const mirrorAverageSkipLastJournaled = new Map<
  string,
  { reason: MirrorAverageSkipReason; atMs: number }
>();
const MIRROR_AVERAGE_SKIP_JOURNAL_THROTTLE_MS = 5 * 60_000;
const MIRROR_AVERAGE_SKIP_MAX_TRACKED = 2048;

export function shouldJournalMirrorAverageSkip(
  mint: string,
  reason: MirrorAverageSkipReason,
  nowMs: number,
): boolean {
  const previous = mirrorAverageSkipLastJournaled.get(mint);
  if (
    previous &&
    previous.reason === reason &&
    nowMs - previous.atMs < MIRROR_AVERAGE_SKIP_JOURNAL_THROTTLE_MS
  ) {
    return false;
  }
  mirrorAverageSkipLastJournaled.set(mint, { reason, atMs: nowMs });
  if (mirrorAverageSkipLastJournaled.size > MIRROR_AVERAGE_SKIP_MAX_TRACKED) {
    const oldest = mirrorAverageSkipLastJournaled.keys().next().value;
    if (oldest) mirrorAverageSkipLastJournaled.delete(oldest);
  }
  return true;
}

const poolCache = new Map<string, { pool: string; fetchedAtMs: number }>();
const candleCache = new Map<string, { candles: Candle[]; fetchedAtMs: number }>();

function numberValue(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function mirrorAveragePriceAllowed(args: {
  markPriceUsd: number;
  entryPriceUsd: number;
  targetPriceUsd: number;
  tolerancePct: number;
  minDiscountPct: number;
}): boolean {
  return (
    args.markPriceUsd > 0 &&
    args.entryPriceUsd > 0 &&
    args.targetPriceUsd > 0 &&
    args.markPriceUsd <= args.targetPriceUsd * (1 + args.tolerancePct / 100) &&
    args.markPriceUsd <= args.entryPriceUsd * (1 - args.minDiscountPct / 100)
  );
}

export function mirrorAverageDeepDiscountTarget(args: {
  markPriceUsd: number;
  entryPriceUsd: number;
  minDiscountPct: number;
}): number | null {
  if (!(args.markPriceUsd > 0) || !(args.entryPriceUsd > 0)) return null;
  const targetPrice = args.entryPriceUsd * (1 - args.minDiscountPct / 100);
  return args.markPriceUsd <= targetPrice ? args.markPriceUsd : null;
}

export function mirrorAverageHoldAllowed(args: {
  openedAtMs: number;
  nowMs: number;
  minHoldMs: number;
}): boolean {
  return args.nowMs - args.openedAtMs >= Math.max(0, args.minHoldMs);
}

export function mirrorAverageReference(args: {
  entryPriceUsd: number;
  lastAverageFillPriceUsd?: number;
  attempts: number;
  initialDiscountPct: number;
  nextDiscountPct: number;
}): { entryPriceUsd: number; minDiscountPct: number } | null {
  if (args.attempts > 0) {
    const lastFillPriceUsd = numberValue(args.lastAverageFillPriceUsd);
    if (lastFillPriceUsd == null) return null;
    return {
      entryPriceUsd: lastFillPriceUsd,
      minDiscountPct: args.nextDiscountPct,
    };
  }
  return {
    entryPriceUsd: args.entryPriceUsd,
    minDiscountPct: args.initialDiscountPct,
  };
}

export function parseMirrorOhlcvList(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const ts = numberValue(row[0]);
    const low = numberValue(row[3]);
    return ts != null && low != null ? [{ tsMs: ts * 1000, low }] : [];
  });
}

export function recentMirrorLocalLow(args: {
  candles: Candle[];
  nowMs: number;
  windowMs: number;
  excludeTailMs: number;
}): number | null {
  const from = args.nowMs - args.windowMs;
  const until = args.nowMs - args.excludeTailMs;
  const lows = args.candles
    .filter((c) => c.tsMs >= from && c.tsMs <= until)
    .map((c) => c.low)
    .filter((n) => Number.isFinite(n) && n > 0);
  return lows.length > 0 ? Math.min(...lows) : null;
}

export function recentMirrorLocalLowCascade(args: {
  candles: Candle[];
  nowMs: number;
  windowsMs: readonly number[];
  excludeTailMs: number;
  entryPriceUsd: number;
  minDiscountPct: number;
}): number | null {
  if (!(args.entryPriceUsd > 0)) return null;
  const targetPrice = args.entryPriceUsd * (1 - args.minDiscountPct / 100);
  for (const windowMs of args.windowsMs) {
    const low = recentMirrorLocalLow({
      candles: args.candles,
      nowMs: args.nowMs,
      windowMs,
      excludeTailMs: args.excludeTailMs,
    });
    if (low != null && low <= targetPrice) return low;
  }
  return null;
}

export async function mirrorRecentLocalLow(args: {
  mint: string;
  nowMs: number;
  windowsMs: readonly number[];
  excludeTailMs: number;
  entryPriceUsd: number;
  minDiscountPct: number;
  refreshMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<number | null> {
  const fetchImpl = args.fetchImpl ?? (fetch as unknown as FetchLike);
  const refreshMs = args.refreshMs ?? 90_000;
  let pool = poolCache.get(args.mint);
  if (!pool || args.nowMs - pool.fetchedAtMs >= 6 * 3_600_000) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 8_000);
      const response = await fetchImpl(
        `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(args.mint)}/pools?page=1`,
        { headers: { accept: 'application/json' }, signal: controller.signal },
      );
      clearTimeout(timer);
      if (!response.ok) return null;
      const payload = (await response.json()) as any;
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const best = rows
        .map((row: any) => ({
          id: typeof row?.id === 'string' ? row.id.split('_').pop() : null,
          liq: numberValue(row?.attributes?.reserve_in_usd),
        }))
        .filter((row: any) => row.id && row.liq != null)
        .sort((a: any, b: any) => b.liq - a.liq)[0];
      if (!best?.id) return null;
      pool = { pool: best.id, fetchedAtMs: args.nowMs };
      poolCache.set(args.mint, pool);
    } catch {
      return null;
    }
  }
  let candles = candleCache.get(args.mint);
  if (!candles || args.nowMs - candles.fetchedAtMs >= refreshMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 8_000);
      const response = await fetchImpl(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(pool.pool)}/ohlcv/minute?aggregate=1&limit=${Math.max(1, Math.ceil(Math.max(...args.windowsMs) / 60_000))}&currency=usd`,
        { headers: { accept: 'application/json' }, signal: controller.signal },
      );
      clearTimeout(timer);
      if (!response.ok) return null;
      const payload = (await response.json()) as any;
      const parsed = parseMirrorOhlcvList(payload?.data?.attributes?.ohlcv_list);
      if (parsed.length === 0) return null;
      candles = { candles: parsed, fetchedAtMs: args.nowMs };
      candleCache.set(args.mint, candles);
    } catch {
      return null;
    }
  }
  return recentMirrorLocalLowCascade({
    candles: candles.candles,
    nowMs: args.nowMs,
    windowsMs: args.windowsMs,
    excludeTailMs: args.excludeTailMs,
    entryPriceUsd: args.entryPriceUsd,
    minDiscountPct: args.minDiscountPct,
  });
}

export function __resetMirrorAveragingCacheForTests(): void {
  poolCache.clear();
  candleCache.clear();
}
