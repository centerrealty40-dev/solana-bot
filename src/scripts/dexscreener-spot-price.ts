/**
 * DexScreener token spot price fallback (no API key; rate-limit friendly batching).
 */
import { fetch } from 'undici';

export type DexScreenerSpotRow = {
  priceUsd: number;
  pairAddress: string;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
};

const cache = new Map<string, { at: number; row: DexScreenerSpotRow | null }>();
const CACHE_TTL_MS = 8_000;

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickBestDexScreenerPair(pairs: unknown[]): DexScreenerSpotRow | null {
  let best: DexScreenerSpotRow | null = null;
  let bestLiq = -1;
  for (const raw of pairs) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const chain = String(p.chainId ?? '');
    if (chain && chain !== 'solana') continue;
    const liq = Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0);
    const px = Number(p.priceUsd ?? 0);
    const pairAddress = String(p.pairAddress ?? '');
    if (!(px > 0) || pairAddress.length < 20) continue;
    if (liq > bestLiq) {
      bestLiq = liq;
      const mcap = Number(p.marketCap ?? p.fdv ?? 0);
      best = {
        priceUsd: px,
        pairAddress,
        liquidityUsd: liq > 0 ? liq : null,
        marketCapUsd: mcap > 0 ? mcap : null,
      };
    }
  }
  return best;
}

/** Best-effort spot from DexScreener `/latest/dex/tokens/{mint}`. */
export async function fetchDexScreenerSpotForMint(mint: string): Promise<DexScreenerSpotRow | null> {
  const id = mint.trim();
  if (id.length < 32) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;

  const timeoutMs = Math.max(2000, Math.min(12_000, envNum('DEXSCREENER_SPOT_TIMEOUT_MS', 6000)));
  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(id)}`;
    const resp = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!resp.ok) {
      cache.set(id, { at: Date.now(), row: null });
      return null;
    }
    const json = (await resp.json()) as { pairs?: unknown[] };
    const row = pickBestDexScreenerPair(Array.isArray(json?.pairs) ? json.pairs : []);
    cache.set(id, { at: Date.now(), row });
    return row;
  } catch {
    cache.set(id, { at: Date.now(), row: null });
    return null;
  } finally {
    clearTimeout(tt);
  }
}

/** Fallback for mints missing Jupiter spot (sequential, capped per tick). */
export async function fetchDexScreenerSpotFallbackBatch(
  mints: string[],
  maxPerTick = 12,
): Promise<Map<string, DexScreenerSpotRow>> {
  const out = new Map<string, DexScreenerSpotRow>();
  const cap = Math.max(0, Math.min(30, maxPerTick));
  let done = 0;
  for (const mint of mints) {
    if (done >= cap) break;
    done += 1;
    const row = await fetchDexScreenerSpotForMint(mint);
    if (row) out.set(mint.trim(), row);
    if (done < cap) await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

export { pickBestDexScreenerPair };
