/**
 * Hybrid Jupiter spot prices: Price v3 batch + buy-quote on hot mints + DexScreener fallback.
 */
import { fetchJupiterPriceV3Batch } from '../core/jupiter-http.js';
import { fetchDexScreenerSpotFallbackBatch } from './dexscreener-spot-price.js';
import { jupiterQuoteBuyPriceUsd } from '../papertrader/pricing/price-verify.js';
import { getSolUsd, refreshSolPrice } from '../papertrader/pricing.js';

export type PrioritySpotPriceSource = 'jupiter_v3' | 'jupiter_quote' | 'dexscreener';

export type PrioritySpotPrice = {
  priceUsd: number;
  source: PrioritySpotPriceSource;
  pairAddress?: string | null;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
};

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

function quoteProbeUsd(): number {
  return Math.min(50, Math.max(10, envNum('PRIORITY_JUPITER_SPOT_QUOTE_PROBE_USD', 25)));
}

function quoteSlippageBps(): number {
  return Math.max(50, Math.min(2000, envNum('PRIORITY_JUPITER_SPOT_QUOTE_SLIPPAGE_BPS', 300)));
}

function quoteTimeoutMs(): number {
  return Math.max(1500, Math.min(15_000, envNum('PRIORITY_JUPITER_SPOT_QUOTE_TIMEOUT_MS', 6000)));
}

function quoteMaxPerTick(): number {
  return Math.max(0, Math.min(40, Math.floor(envNum('PRIORITY_JUPITER_SPOT_QUOTE_MAX_PER_TICK', 25))));
}

function quoteEnabled(): boolean {
  return envBool('PRIORITY_JUPITER_SPOT_QUOTE_ENABLED', true);
}

function dexFallbackEnabled(): boolean {
  return envBool('PRIORITY_JUPITER_SPOT_DEXSCREENER_FALLBACK', true);
}

function dexFallbackMaxPerTick(): number {
  return Math.max(0, Math.min(30, Math.floor(envNum('PRIORITY_JUPITER_SPOT_DEXSCREENER_MAX_PER_TICK', 12))));
}

async function quoteHotMintPrice(
  mint: string,
  snapshotPriceUsd: number,
  solUsd: number,
): Promise<number | null> {
  if (!(snapshotPriceUsd > 0)) return null;
  const q = await jupiterQuoteBuyPriceUsd({
    mint,
    outMintDecimals: 6,
    sizeUsd: quoteProbeUsd(),
    solUsd,
    snapshotPriceUsd,
    slippageBps: quoteSlippageBps(),
    timeoutMs: quoteTimeoutMs(),
    resilience: null,
  });
  if (q.kind !== 'ok' || q.jupiterPriceUsd == null || !(q.jupiterPriceUsd > 0)) return null;
  return q.jupiterPriceUsd;
}

/**
 * v3 for wide universe; Jupiter buy-quote overrides hot mints; DexScreener fills gaps.
 */
export async function fetchPrioritySpotPrices(args: {
  mints: string[];
  hotMintSet: ReadonlySet<string>;
  snapshotPxByMint: ReadonlyMap<string, number>;
  timeoutMs: number;
}): Promise<Map<string, PrioritySpotPrice>> {
  const out = new Map<string, PrioritySpotPrice>();
  if (args.mints.length === 0) return out;

  const v3 = await fetchJupiterPriceV3Batch(args.mints, args.timeoutMs);
  for (const [mint, px] of v3) {
    if (px > 0) out.set(mint, { priceUsd: px, source: 'jupiter_v3' });
  }

  if (quoteEnabled() && args.hotMintSet.size > 0) {
    await refreshSolPrice();
    const solUsd = getSolUsd();
    if (solUsd > 0) {
      let quoted = 0;
      const maxQ = quoteMaxPerTick();
      for (const mint of args.mints) {
        if (!args.hotMintSet.has(mint)) continue;
        if (quoted >= maxQ) break;
        quoted += 1;

        const snapPx = args.snapshotPxByMint.get(mint) ?? out.get(mint)?.priceUsd ?? 0;
        const qPx = await quoteHotMintPrice(mint, snapPx, solUsd);
        if (qPx != null && qPx > 0) {
          out.set(mint, { priceUsd: qPx, source: 'jupiter_quote' });
        }
      }
    }
  }

  if (dexFallbackEnabled()) {
    const missing = args.mints.filter((m) => !out.has(m));
    if (missing.length > 0) {
      const dex = await fetchDexScreenerSpotFallbackBatch(missing, dexFallbackMaxPerTick());
      for (const [mint, row] of dex) {
        if (row.priceUsd > 0) {
          out.set(mint, {
            priceUsd: row.priceUsd,
            source: 'dexscreener',
            pairAddress: row.pairAddress,
            liquidityUsd: row.liquidityUsd,
            marketCapUsd: row.marketCapUsd,
          });
        }
      }
    }
  }

  return out;
}
