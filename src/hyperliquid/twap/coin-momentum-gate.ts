import type { TwapSide } from './types.js';

const HL_INFO = 'https://api.hyperliquid.xyz/info';

type HlCandle = {
  t: number;
  T: number;
  c: string | number;
  h: string | number;
};

export type CoinMomentumSnapshot = {
  dd24h_pct: number;
  updated_ts: number;
};

const cache = new Map<string, CoinMomentumSnapshot>();

function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

function envNum(name: string, fallback: number, min = 0): number {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

/** Gate A: block long when coin is ≥N% below 24h high (Hyperliquid 1h candles). Default on. */
export function hlTwapCoinMomentumGateEnabled(): boolean {
  return envBool('HL_TWAP_COIN_MOMENTUM_GATE', true);
}

/** Drawdown threshold in percent points (default 5 → block when dd24h ≤ −5%). */
export function hlTwapCoinMomentumDd24hPct(): number {
  return envNum('HL_TWAP_COIN_MOMENTUM_DD24H_PCT', 5, 0);
}

export function hlTwapCoinMomentumMaxStaleMs(): number {
  return envNum('HL_TWAP_COIN_MOMENTUM_MAX_STALE_MS', 900_000, 60_000);
}

export function getCoinMomentumSnapshot(coin: string): CoinMomentumSnapshot | null {
  return cache.get(coin) ?? null;
}

export function clearCoinMomentumCache(): void {
  cache.clear();
}

/** Pure helper for tests — dd from 24h high using closed 1h candles at or before `tsMs`. */
export function computeCoinDd24hPct(candles: HlCandle[], tsMs: number): number | null {
  const eligible = candles.filter((c) => Number(c.T) <= tsMs);
  if (eligible.length < 5) return null;
  const window = eligible.length >= 24 ? eligible.slice(-24) : eligible;
  const last = Number(window[window.length - 1]!.c);
  const peak = Math.max(...window.map((c) => Number(c.h)));
  if (!Number.isFinite(last) || !Number.isFinite(peak) || peak <= 0) return null;
  return +((last / peak - 1) * 100).toFixed(2);
}

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`hyperliquid info ${String(body.type)}: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Fetch HL 1h candles and cache dd24h for entry gate checks. */
export async function refreshCoinMomentumCache(coin: string, nowMs = Date.now()): Promise<void> {
  if (!hlTwapCoinMomentumGateEnabled()) return;
  const startMs = nowMs - 96 * 3_600_000;
  const candles = await postInfo<HlCandle[]>({
    type: 'candleSnapshot',
    req: { coin, interval: '1h', startTime: startMs, endTime: nowMs },
  });
  if (!Array.isArray(candles) || candles.length < 5) return;
  const dd = computeCoinDd24hPct(candles, nowMs);
  if (dd == null) return;
  cache.set(coin, { dd24h_pct: dd, updated_ts: nowMs });
}

/**
 * Gate A — long only: block when cached dd24h ≤ −threshold.
 * Stale/missing cache → allow (do not block entries on API miss).
 */
export function hlTwapCoinMomentumBlockReason(coin: string, side: TwapSide): string | null {
  if (!hlTwapCoinMomentumGateEnabled() || side !== 'buy') return null;
  const snap = cache.get(coin);
  if (!snap) return null;
  const staleMs = hlTwapCoinMomentumMaxStaleMs();
  if (nowMs() - snap.updated_ts > staleMs) return null;
  const thresh = hlTwapCoinMomentumDd24hPct();
  if (thresh <= 0) return null;
  if (snap.dd24h_pct <= -thresh) {
    return `coin_dd24h_${snap.dd24h_pct.toFixed(1)}`;
  }
  return null;
}

function nowMs(): number {
  return Date.now();
}
