import { fetch } from 'undici';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export type DexInfo = {
  symbol: string;
  name: string;
  priceUsd: number;
  marketCap: number;
  liquidityUsd: number;
  volume24h: number;
  volume1h: number;
  pairCreatedAtMs: number | null;
  dexId: string;
};

const cache = new Map<string, { at: number; val: DexInfo | null }>();

function looksLikeMintAddress(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
}

function pickBestPair(pairs: unknown[], mint: string): Record<string, unknown> | null {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const solQuote = pairs.filter((p) => {
    const row = p as { baseToken?: { address?: string }; quoteToken?: { address?: string } };
    const base = row.baseToken?.address ?? '';
    const quote = row.quoteToken?.address ?? '';
    return base === mint || quote === mint;
  });
  const pool = solQuote.length > 0 ? solQuote : pairs;
  let best: Record<string, unknown> | null = null;
  let bestLiq = -1;
  for (const p of pool) {
    const row = p as { liquidity?: { usd?: number } };
    const liq = Number(row.liquidity?.usd ?? 0);
    if (liq > bestLiq) {
      bestLiq = liq;
      best = p as Record<string, unknown>;
    }
  }
  return best;
}

function dexInfoFromPair(pair: Record<string, unknown>, mint: string): DexInfo {
  const base = pair.baseToken as { address?: string; symbol?: string; name?: string } | undefined;
  const quote = pair.quoteToken as { address?: string; symbol?: string; name?: string } | undefined;
  const token =
    base?.address === mint ? base : quote?.address === mint ? quote : base ?? quote ?? {};
  const priceUsd = Number(pair.priceUsd ?? 0);
  const marketCap = Number((pair as { marketCap?: number }).marketCap ?? (pair as { fdv?: number }).fdv ?? 0);
  const liquidityUsd = Number((pair.liquidity as { usd?: number } | undefined)?.usd ?? 0);
  const volume = pair.volume as { h24?: number; h1?: number } | undefined;
  const created = Number((pair as { pairCreatedAt?: number }).pairCreatedAt ?? 0);
  return {
    symbol: String(token.symbol ?? '?').slice(0, 16),
    name: String(token.name ?? token.symbol ?? '?').slice(0, 48),
    priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : 0,
    marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : 0,
    liquidityUsd: Number.isFinite(liquidityUsd) && liquidityUsd > 0 ? liquidityUsd : 0,
    volume24h: Number(volume?.h24 ?? 0),
    volume1h: Number(volume?.h1 ?? 0),
    pairCreatedAtMs: Number.isFinite(created) && created > 0 ? created : null,
    dexId: String((pair as { dexId?: string }).dexId ?? ''),
  };
}

export async function fetchDexInfo(mint: string, solUsd: number): Promise<DexInfo | null> {
  if (!looksLikeMintAddress(mint)) return null;
  if (mint === SOL_MINT) {
    return {
      symbol: 'SOL',
      name: 'Solana',
      priceUsd: solUsd,
      marketCap: 0,
      liquidityUsd: 0,
      volume24h: 0,
      volume1h: 0,
      pairCreatedAtMs: null,
      dexId: '',
    };
  }

  const now = Date.now();
  const cached = cache.get(mint);
  if (cached && now - cached.at < 60_000) return cached.val;

  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(12_000),
      headers: { accept: 'application/json' },
    });
    if (!r.ok) {
      cache.set(mint, { at: now, val: null });
      return null;
    }
    const j = (await r.json()) as { pairs?: unknown[] };
    const best = pickBestPair(j.pairs ?? [], mint);
    if (!best) {
      cache.set(mint, { at: now, val: null });
      return null;
    }
    const info = dexInfoFromPair(best, mint);
    cache.set(mint, { at: now, val: info });
    return info;
  } catch {
    cache.set(mint, { at: now, val: null });
    return null;
  }
}
