import type { TwapEndDetails } from './format-telegram.js';
import type { NormalizedTwapSignal } from './types.js';

const HL_INFO = 'https://api.hyperliquid.xyz/info';

type TwapHistoryRow = {
  time: number;
  twapId?: number;
  state: {
    coin: string;
    user: string;
    side: 'B' | 'A';
    sz: string;
    executedSz: string;
    executedNtl: string;
    minutes: number;
    timestamp: number;
  };
  status: { status: string; description?: string };
};

export async function enrichEndFromTwapHistory(
  sig: NormalizedTwapSignal,
  endedStatus: string,
): Promise<TwapEndDetails> {
  const base: TwapEndDetails = {
    status: endedStatus,
    executedPct: null,
    executedSz: null,
    totalSz: null,
    coin: sig.displaySymbol,
    twapId: null,
    priceStart: sig.midPx > 0 ? sig.midPx : null,
    priceEnd: null,
    priceChangePct: null,
  };

  try {
    const rows = await fetchTwapHistory(sig.user);
    const match = pickHistoryRow(rows, sig);
    if (!match) return base;

    const totalSz = Number(match.state.sz);
    const executedSz = Number(match.state.executedSz);
    const executedPct =
      Number.isFinite(totalSz) && totalSz > 0 && Number.isFinite(executedSz)
        ? (executedSz / totalSz) * 100
        : null;

    const executedNtl = Number(match.state.executedNtl);
    const priceEnd =
      Number.isFinite(executedSz) && executedSz > 0 && Number.isFinite(executedNtl)
        ? executedNtl / executedSz
        : null;

    let priceChangePct: number | null = null;
    if (base.priceStart != null && priceEnd != null && base.priceStart > 0) {
      priceChangePct = ((priceEnd - base.priceStart) / base.priceStart) * 100;
    }

    return {
      status: match.status.status,
      executedPct,
      executedSz: Number.isFinite(executedSz) ? executedSz : null,
      totalSz: Number.isFinite(totalSz) ? totalSz : null,
      coin: stripCoin(match.state.coin),
      twapId: match.twapId ?? null,
      priceStart: base.priceStart,
      priceEnd,
      priceChangePct,
    };
  } catch {
    return base;
  }
}

async function fetchTwapHistory(user: string): Promise<TwapHistoryRow[]> {
  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'twapHistory', user }),
  });
  if (!res.ok) throw new Error(`twapHistory ${res.status}`);
  return (await res.json()) as TwapHistoryRow[];
}

function pickHistoryRow(rows: TwapHistoryRow[], sig: NormalizedTwapSignal): TwapHistoryRow | null {
  const targetMs = sig.startedAtMs;
  let best: TwapHistoryRow | null = null;
  let bestDt = Infinity;
  for (const row of rows) {
    const ts = row.state?.timestamp ?? row.time * 1000;
    const dt = Math.abs(ts - targetMs);
    if (dt > 120_000) continue;
    if (sig.coin && row.state.coin !== sig.coin && stripCoin(row.state.coin) !== sig.displaySymbol) continue;
    if (dt < bestDt) {
      bestDt = dt;
      best = row;
    }
  }
  return best;
}

function stripCoin(coin: string): string {
  const c = coin.trim();
  if (c.startsWith('@')) return c.slice(1);
  const i = c.indexOf(':');
  return i > 0 ? c.slice(i + 1) : c;
}
