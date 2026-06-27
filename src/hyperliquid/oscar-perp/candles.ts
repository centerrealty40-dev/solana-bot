const HL_INFO = 'https://api.hyperliquid.xyz/info';
export const OSCAR_CANDLE_INTERVAL = '15m';
export const OSCAR_MS_PER_BAR = 15 * 60 * 1000;

export type OscarCandle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export function barsForMinutes(min: number): number {
  return Math.ceil(min / 15);
}

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`hyperliquid ${body.type}: ${res.status} ${text.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

export async function fetchOscarCandles(
  coin: string,
  startMs: number,
  endMs: number,
): Promise<OscarCandle[]> {
  const raw = await postInfo<
    Array<{ t: number; o: string; h: string; l: string; c: string }>
  >({
    type: 'candleSnapshot',
    req: { coin, interval: OSCAR_CANDLE_INTERVAL, startTime: startMs, endTime: endMs },
  });
  if (!Array.isArray(raw)) return [];
  return raw
    .map((k) => ({
      ts: Number(k.t),
      open: +k.o,
      high: +k.h,
      low: +k.l,
      close: +k.c,
    }))
    .filter((c) => c.ts > 0 && c.close > 0)
    .sort((a, b) => a.ts - b.ts);
}

export function windowHighLow(candles: OscarCandle[], i: number, bars: number): {
  high: number;
  low: number;
} {
  const start = Math.max(0, i - bars + 1);
  let high = -Infinity;
  let low = Infinity;
  for (let j = start; j <= i; j++) {
    high = Math.max(high, candles[j]!.high);
    low = Math.min(low, candles[j]!.low);
  }
  return { high, low };
}
