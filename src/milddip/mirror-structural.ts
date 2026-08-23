import { rpcCall } from '../copytrader/rpc.js';
import {
  fetchMildDipStructuralFallback,
  type StructuralFallbackSnapshot,
} from './structural-fallback.js';

type RpcCall = typeof rpcCall;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type MintSupply = {
  supply: number;
  decimals: number;
};

type SupplyCacheEntry = {
  fetchedAtMs: number;
  value: MintSupply | null;
};

export type MirrorStructuralDexMetrics = {
  priceUsd: number | null;
  volume5mUsd: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pairAgeHours: number | null;
  dexId: string | null;
};

export type MirrorStructuralSources = {
  liquidity: 'gecko' | 'dex' | 'missing';
  marketCap: 'rpc' | 'dex' | 'missing';
  pairAge: 'registry' | 'gecko' | 'dex' | 'missing';
};

export type MirrorStructuralResolution = {
  metrics: MirrorStructuralDexMetrics;
  sources: MirrorStructuralSources;
};

export function mirrorOwnStructuralCanApply(
  metrics: MirrorStructuralDexMetrics,
  existingPc5m: number | null | undefined,
): boolean {
  const pc5m = metrics.priceChange5mPct ?? existingPc5m;
  return pc5m != null && Number.isFinite(pc5m);
}

const SUPPLY_CACHE_TTL_MS = 30 * 60_000;
const SUPPLY_NEGATIVE_CACHE_TTL_MS = 60_000;
const supplyCache = new Map<string, SupplyCacheEntry>();

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchMintSupply(
  rpcUrl: string,
  mint: string,
  nowMs: number,
  rpcImpl: RpcCall,
): Promise<MintSupply | null> {
  const cached = supplyCache.get(mint);
  const ttl = cached?.value
    ? SUPPLY_CACHE_TTL_MS
    : SUPPLY_NEGATIVE_CACHE_TTL_MS;
  if (
    cached &&
    nowMs - cached.fetchedAtMs >= 0 &&
    nowMs - cached.fetchedAtMs <= ttl
  ) {
    return cached.value;
  }
  const raw = await rpcImpl<{
    value?: {
      data?: {
        parsed?: {
          info?: {
            decimals?: number;
            supply?: string | number;
          };
        };
      };
    } | null;
  }>(rpcUrl, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }], 3);
  const info = raw?.value?.data?.parsed?.info;
  const supply = finitePositive(info?.supply);
  const decimals = Number(info?.decimals);
  const value =
    supply != null &&
    Number.isInteger(decimals) &&
    decimals >= 0 &&
    decimals <= 18
      ? { supply, decimals }
      : null;
  supplyCache.set(mint, { fetchedAtMs: nowMs, value });
  return value;
}

function mcapFromSupply(
  supply: MintSupply | null,
  quotePriceUsd: number | null,
): number | null {
  if (
    !supply ||
    quotePriceUsd == null ||
    !Number.isFinite(quotePriceUsd) ||
    quotePriceUsd <= 0
  ) {
    return null;
  }
  const mcap = (supply.supply / 10 ** supply.decimals) * quotePriceUsd;
  return Number.isFinite(mcap) && mcap > 0 ? mcap : null;
}

export async function resolveMirrorStructuralMetrics(args: {
  mint: string;
  nowMs: number;
  rpcUrl: string;
  quotePriceUsd: number | null;
  registryAgeHours: number | null;
  dex: MirrorStructuralDexMetrics;
  fallbackConfig: Parameters<typeof fetchMildDipStructuralFallback>[1];
  fetchImpl?: FetchLike;
  rpcImpl?: RpcCall;
}): Promise<MirrorStructuralResolution> {
  const { dex } = args;
  let liquidityUsd = dex.liquidityUsd;
  let pairAgeHours = args.registryAgeHours ?? dex.pairAgeHours;
  let marketCapUsd = dex.marketCapUsd;
  const sources: MirrorStructuralSources = {
    liquidity: liquidityUsd != null ? 'dex' : 'missing',
    marketCap: marketCapUsd != null ? 'dex' : 'missing',
    pairAge:
      args.registryAgeHours != null
        ? 'registry'
        : pairAgeHours != null
          ? 'dex'
          : 'missing',
  };

  const supply = await fetchMintSupply(
    args.rpcUrl,
    args.mint,
    args.nowMs,
    args.rpcImpl ?? rpcCall,
  );
  const rpcMcap = mcapFromSupply(supply, args.quotePriceUsd);
  if (rpcMcap != null) {
    marketCapUsd = rpcMcap;
    sources.marketCap = 'rpc';
  }

  let fallback: StructuralFallbackSnapshot | null = null;
  if (liquidityUsd == null || pairAgeHours == null) {
    fallback = await fetchMildDipStructuralFallback(
      args.mint,
      args.fallbackConfig,
      args.nowMs,
      args.fetchImpl ? { fetchImpl: args.fetchImpl } : undefined,
    );
  }
  if (liquidityUsd == null && fallback?.liquidityUsd != null) {
    liquidityUsd = fallback.liquidityUsd;
    sources.liquidity = 'gecko';
  }
  if (pairAgeHours == null && fallback?.pairAgeHours != null) {
    pairAgeHours = fallback.pairAgeHours;
    sources.pairAge = 'gecko';
  }

  return {
    metrics: {
      priceUsd: fallback?.priceUsd ?? dex.priceUsd,
      volume5mUsd: fallback?.volume5mUsd ?? dex.volume5mUsd,
      priceChange5mPct: fallback?.priceChange5mPct ?? dex.priceChange5mPct,
      priceChange1hPct: fallback?.priceChange1hPct ?? dex.priceChange1hPct,
      liquidityUsd,
      marketCapUsd,
      pairAgeHours,
      dexId: dex.dexId ?? fallback?.dexId ?? null,
    },
    sources: {
      ...sources,
      liquidity: liquidityUsd == null ? 'missing' : sources.liquidity,
      marketCap: marketCapUsd == null ? 'missing' : sources.marketCap,
      pairAge: pairAgeHours == null ? 'missing' : sources.pairAge,
    },
  };
}

export function resetMirrorStructuralStateForTests(): void {
  supplyCache.clear();
}
