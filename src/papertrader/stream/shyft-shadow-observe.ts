/**
 * Shyft shadow observability helpers — stream health + Shyft vs Dex quote deltas.
 * **Observability only.** Never feeds trading gates / eval / execution.
 */
import { fetchDexScreenerMarketSnapshot } from '../pricing/discovery-market-quote.js';
import { resolveShyftDefiMcap } from './shyft-defi-mcap.js';
import type { ShadowStreamPrice } from './shadow-state.js';

export type ShyftObserveSurface = 'entry' | 'mtm';

/** Signed % delta `(a - b) / b * 100`; `null` when either side missing/non-positive. */
export function quotePctDelta(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return +(((a - b) / b) * 100).toFixed(4);
}

export interface ShyftStreamHealthInput {
  status: string;
  detail?: string | null;
  watchedMintCount: number;
  reconnectCount: number;
  lastObservationMs: number | null;
  connectedSinceMs: number | null;
  observationsTotal: number;
}

export interface ShyftStreamHealthEvent {
  [key: string]: unknown;
  kind: 'live_shyft_stream_health';
  status: string;
  watchedMintCount: number;
  reconnectCount: number;
  lastObservationMs: number | null;
  connectedUptimeMs: number | null;
  lastObservationAgeMs: number | null;
  observationsTotal: number;
  detail?: string;
}

export function buildShyftStreamHealthEvent(
  input: ShyftStreamHealthInput,
  nowMs: number = Date.now(),
): ShyftStreamHealthEvent {
  const connectedUptimeMs =
    input.connectedSinceMs != null && input.status === 'connected'
      ? nowMs - input.connectedSinceMs
      : null;
  const lastObservationAgeMs =
    input.lastObservationMs != null ? nowMs - input.lastObservationMs : null;
  return {
    kind: 'live_shyft_stream_health',
    status: input.status,
    watchedMintCount: input.watchedMintCount,
    reconnectCount: input.reconnectCount,
    lastObservationMs: input.lastObservationMs,
    connectedUptimeMs,
    lastObservationAgeMs,
    observationsTotal: input.observationsTotal,
    ...(input.detail ? { detail: input.detail.slice(0, 400) } : {}),
  };
}

export interface ShyftVsDexQuoteInput {
  mint: string;
  lane: string;
  surface: ShyftObserveSurface;
  stream: ShadowStreamPrice;
  dexPriceUsd: number | null;
  dexMcapUsd: number | null;
  dexLiqUsd: number | null;
  dexFetchedAtMs: number | null;
  shyftDefiMcapUsd: number | null;
  shyftDefiLiqUsd: number | null;
  prodPriceUsd: number | null;
  prodMcapUsd: number | null;
  prodLiqUsd: number | null;
}

export interface ShyftVsDexQuoteEvent {
  [key: string]: unknown;
  kind: 'live_shyft_vs_dex_quote';
  mint: string;
  lane: string;
  surface: ShyftObserveSurface;
  streamPriceUsd: number;
  streamTsMs: number;
  streamAgeMs: number;
  dexPriceUsd: number | null;
  dexMcapUsd: number | null;
  dexLiqUsd: number | null;
  shyftDefiMcapUsd: number | null;
  shyftDefiLiqUsd: number | null;
  prodPriceUsd: number | null;
  prodMcapUsd: number | null;
  prodLiqUsd: number | null;
  streamVsDexPricePct: number | null;
  streamVsProdPricePct: number | null;
  shyftDefiVsDexMcapPct: number | null;
  shyftDefiVsDexLiqPct: number | null;
  prodVsDexPricePct: number | null;
  prodVsDexMcapPct: number | null;
  prodVsDexLiqPct: number | null;
}

export function buildShyftVsDexQuoteEvent(
  input: ShyftVsDexQuoteInput,
  nowMs: number = Date.now(),
): ShyftVsDexQuoteEvent {
  return {
    kind: 'live_shyft_vs_dex_quote',
    mint: input.mint,
    lane: input.lane,
    surface: input.surface,
    streamPriceUsd: input.stream.priceUsd,
    streamTsMs: input.stream.streamTsMs,
    streamAgeMs: nowMs - input.stream.streamTsMs,
    dexPriceUsd: input.dexPriceUsd,
    dexMcapUsd: input.dexMcapUsd,
    dexLiqUsd: input.dexLiqUsd,
    shyftDefiMcapUsd: input.shyftDefiMcapUsd,
    shyftDefiLiqUsd: input.shyftDefiLiqUsd,
    prodPriceUsd: input.prodPriceUsd,
    prodMcapUsd: input.prodMcapUsd,
    prodLiqUsd: input.prodLiqUsd,
    streamVsDexPricePct: quotePctDelta(input.stream.priceUsd, input.dexPriceUsd),
    streamVsProdPricePct: quotePctDelta(input.stream.priceUsd, input.prodPriceUsd),
    shyftDefiVsDexMcapPct: quotePctDelta(input.shyftDefiMcapUsd, input.dexMcapUsd),
    shyftDefiVsDexLiqPct: quotePctDelta(input.shyftDefiLiqUsd, input.dexLiqUsd),
    prodVsDexPricePct: quotePctDelta(input.prodPriceUsd, input.dexPriceUsd),
    prodVsDexMcapPct: quotePctDelta(input.prodMcapUsd, input.dexMcapUsd),
    prodVsDexLiqPct: quotePctDelta(input.prodLiqUsd, input.dexLiqUsd),
  };
}

const vsDexThrottle = new Map<string, number>();
const VS_DEX_THROTTLE_MS = 30_000;

export function shouldEmitShyftVsDexQuote(
  mint: string,
  surface: ShyftObserveSurface,
  nowMs: number = Date.now(),
  throttleMs: number = VS_DEX_THROTTLE_MS,
): boolean {
  const key = `${mint}:${surface}`;
  const prev = vsDexThrottle.get(key);
  if (prev != null && nowMs - prev < throttleMs) return false;
  vsDexThrottle.set(key, nowMs);
  return true;
}

/** Test-only reset. */
export function __resetShyftVsDexThrottleForTests(): void {
  vsDexThrottle.clear();
}

export interface ObserveShyftVsDexOpts {
  mint: string;
  lane: string;
  surface: ShyftObserveSurface;
  stream: ShadowStreamPrice;
  prodPriceUsd: number | null;
  prodMcapUsd?: number | null;
  prodLiqUsd?: number | null;
  defiTtlMs?: number;
  dexCacheTtlMs?: number;
  throttleMs?: number;
  nowMs?: number;
  fetchImpl?: typeof import('undici').fetch;
}

/** Best-effort Shyft stream vs Dex (+ optional Shyft DeFi mcap) comparison; returns event or null. */
export async function buildShyftVsDexQuoteObservation(
  opts: ObserveShyftVsDexOpts,
): Promise<ShyftVsDexQuoteEvent | null> {
  const now = opts.nowMs ?? Date.now();
  if (!shouldEmitShyftVsDexQuote(opts.mint, opts.surface, now, opts.throttleMs)) return null;

  const [dex, defi] = await Promise.all([
    fetchDexScreenerMarketSnapshot(opts.mint, {
      cacheTtlMs: opts.dexCacheTtlMs ?? 15_000,
      nowMs: now,
      fetchImpl: opts.fetchImpl,
    }),
    resolveShyftDefiMcap(opts.mint, {
      ttlMs: opts.defiTtlMs ?? 12_000,
      nowMs: now,
      fetchImpl: opts.fetchImpl,
    }),
  ]);

  return buildShyftVsDexQuoteEvent({
    mint: opts.mint,
    lane: opts.lane,
    surface: opts.surface,
    stream: opts.stream,
    dexPriceUsd: dex?.priceUsd ?? null,
    dexMcapUsd: dex?.marketCapUsd ?? null,
    dexLiqUsd: dex?.liquidityUsd ?? null,
    dexFetchedAtMs: dex?.fetchedAtMs ?? null,
    shyftDefiMcapUsd: defi?.mcapUsd ?? null,
    shyftDefiLiqUsd: defi?.liqUsd ?? null,
    prodPriceUsd: opts.prodPriceUsd,
    prodMcapUsd: opts.prodMcapUsd ?? null,
    prodLiqUsd: opts.prodLiqUsd ?? null,
  }, now);
}
