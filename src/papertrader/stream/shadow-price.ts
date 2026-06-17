/**
 * Shyft shadow-price pure helpers (Stage 1.1, 1.11.467).
 *
 * Side-effect-free utilities used by the Yellowstone gRPC shadow consumer to:
 *  - derive a USD price for a watched mint from a swap transaction's post token balances
 *    (DEX-agnostic: the pool base/quote vault reserves are read straight from `postTokenBalances`),
 *  - compute how far the polled PG snapshot lags behind the live stream observation,
 *  - build the `live_shyft_shadow_price` journal record.
 *
 * **Observability only.** Nothing here feeds a trading gate / eval / execution decision — Stage 1.1 is
 * pure shadow measurement of "how stale PG is vs the stream" before the Shyft+PG hybrid (Stage 1.2).
 */
import { snapshotPriceAgeMs } from '../stale-price.js';

/** Wrapped SOL — quote asset priced via `solUsd`. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** USDC — quote asset priced at $1. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** USDT — quote asset priced at $1. */
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** Minimal post-token-balance shape (subset of `@triton-one` / RPC `TokenBalance`). */
export interface ShadowTokenBalance {
  mint?: string | null;
  owner?: string | null;
  uiTokenAmount?: {
    decimals?: number | null;
    amount?: string | null;
    uiAmount?: number | null;
  } | null;
}

/** USD value of 1 unit of a quote mint; `null` when the mint is not a recognised quote asset. */
export function quoteAssetUsd(mint: string | null | undefined, solUsd: number): number | null {
  if (!mint) return null;
  if (mint === WSOL_MINT) return Number.isFinite(solUsd) && solUsd > 0 ? solUsd : null;
  if (mint === USDC_MINT || mint === USDT_MINT) return 1;
  return null;
}

/** True when the mint is one of the recognised quote assets (WSOL/USDC/USDT). */
export function isQuoteMint(mint: string | null | undefined): boolean {
  return mint === WSOL_MINT || mint === USDC_MINT || mint === USDT_MINT;
}

/** UI (human) token amount from a balance row; prefers `uiAmount`, falls back to `amount`/10^decimals. */
export function uiAmountOf(b: ShadowTokenBalance | null | undefined): number {
  const t = b?.uiTokenAmount;
  if (!t) return 0;
  if (t.uiAmount != null && Number.isFinite(t.uiAmount)) return Number(t.uiAmount);
  const raw = t.amount;
  const dec = t.decimals;
  if (raw == null || dec == null || !Number.isFinite(dec)) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / Math.pow(10, dec);
}

export interface StreamPoolPrice {
  priceUsd: number;
  quoteMint: string;
  baseUiAmount: number;
  quoteUiAmount: number;
}

/**
 * Derive USD price for `baseMint` from a swap tx's post token balances.
 *
 * Heuristic (DEX-agnostic): the pool's base vault is the largest post-balance whose mint == baseMint;
 * the pool's quote vault is the largest WSOL/USDC/USDT post-balance owned by the same account (the pool
 * authority), falling back to the largest quote balance overall. price = quoteUi * quoteUsd / baseUi.
 * Returns `null` when the tx does not expose a usable base+quote pool pair.
 */
export function extractStreamPoolPriceUsd(
  postTokenBalances: readonly ShadowTokenBalance[] | null | undefined,
  baseMint: string,
  solUsd: number,
): StreamPoolPrice | null {
  if (!postTokenBalances || postTokenBalances.length === 0) return null;

  let baseVault: ShadowTokenBalance | null = null;
  let baseUi = 0;
  for (const b of postTokenBalances) {
    if (b?.mint !== baseMint) continue;
    const ui = uiAmountOf(b);
    if (ui > baseUi) {
      baseUi = ui;
      baseVault = b;
    }
  }
  if (!baseVault || !(baseUi > 0)) return null;

  const quoteCands = postTokenBalances.filter((b) => isQuoteMint(b?.mint) && uiAmountOf(b) > 0);
  if (quoteCands.length === 0) return null;

  const baseOwner = baseVault.owner ?? null;
  const sameOwner = baseOwner ? quoteCands.filter((q) => q.owner && q.owner === baseOwner) : [];
  const pool = sameOwner.length > 0 ? sameOwner : quoteCands;

  let quoteVault: ShadowTokenBalance | null = null;
  let quoteUi = 0;
  for (const q of pool) {
    const ui = uiAmountOf(q);
    if (ui > quoteUi) {
      quoteUi = ui;
      quoteVault = q;
    }
  }
  if (!quoteVault || !(quoteUi > 0)) return null;

  const qUsd = quoteAssetUsd(quoteVault.mint, solUsd);
  if (qUsd == null) return null;

  const priceUsd = (quoteUi * qUsd) / baseUi;
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return null;

  return {
    priceUsd,
    quoteMint: quoteVault.mint as string,
    baseUiAmount: baseUi,
    quoteUiAmount: quoteUi,
  };
}

/**
 * How far the PG snapshot lags **behind** the stream observation, in ms.
 * Positive => PG snapshot is older than the stream tick (the normal "PG is behind" case).
 * `null` when either timestamp is unknown/unparseable.
 */
export function computeStreamVsPgLagMs(
  streamTsMs: number | null | undefined,
  pgSnapshotTsMs: number | null | undefined,
): number | null {
  if (streamTsMs == null || !Number.isFinite(streamTsMs)) return null;
  if (pgSnapshotTsMs == null || !Number.isFinite(pgSnapshotTsMs)) return null;
  return streamTsMs - pgSnapshotTsMs;
}

/** Signed % difference of the stream price vs the PG price (`null` when PG price is non-positive). */
export function streamVsPgPriceDiffPct(
  streamPriceUsd: number | null | undefined,
  pgPriceUsd: number | null | undefined,
): number | null {
  if (streamPriceUsd == null || !Number.isFinite(streamPriceUsd)) return null;
  if (pgPriceUsd == null || !Number.isFinite(pgPriceUsd) || pgPriceUsd <= 0) return null;
  return ((streamPriceUsd - pgPriceUsd) / pgPriceUsd) * 100;
}

export interface ShadowPriceEventInput {
  mint: string;
  lane: string;
  /** Optional comparison surface — `entry` (discovery decision) or `mtm` (open-position tracker). */
  surface?: 'entry' | 'mtm';
  streamPriceUsd: number;
  pgPriceUsd: number | null;
  streamTsMs: number;
  pgSnapshotTsMs: number | null;
  /** Stream slot, when available. */
  streamSlot?: number | null;
  /** `now` for PG-age computation; defaults to `Date.now()`. */
  nowMs?: number;
}

export interface ShadowPriceEvent {
  /** Index signature so the record is directly assignable to journal sinks (`Record<string, unknown>`). */
  [key: string]: unknown;
  kind: 'live_shyft_shadow_price';
  mint: string;
  lane: string;
  surface?: 'entry' | 'mtm';
  streamPriceUsd: number;
  pgPriceUsd: number | null;
  streamTsMs: number;
  pgSnapshotTsMs: number | null;
  /** Age (ms) of the PG snapshot price relative to `now`. */
  pgPriceAgeMs: number | null;
  /** How far PG lags behind the stream observation (streamTs − pgSnapshotTs). */
  streamVsPgLagMs: number | null;
  /** Signed % difference of stream vs PG price. */
  streamVsPgPriceDiffPct: number | null;
  streamSlot?: number | null;
}

/** Build the observability-only `live_shyft_shadow_price` journal record. */
export function buildShadowPriceEvent(input: ShadowPriceEventInput): ShadowPriceEvent {
  const now = input.nowMs ?? Date.now();
  return {
    kind: 'live_shyft_shadow_price',
    mint: input.mint,
    lane: input.lane,
    ...(input.surface ? { surface: input.surface } : {}),
    streamPriceUsd: input.streamPriceUsd,
    pgPriceUsd: input.pgPriceUsd,
    streamTsMs: input.streamTsMs,
    pgSnapshotTsMs: input.pgSnapshotTsMs,
    pgPriceAgeMs: snapshotPriceAgeMs(input.pgSnapshotTsMs, now),
    streamVsPgLagMs: computeStreamVsPgLagMs(input.streamTsMs, input.pgSnapshotTsMs),
    streamVsPgPriceDiffPct: streamVsPgPriceDiffPct(input.streamPriceUsd, input.pgPriceUsd),
    ...(input.streamSlot != null ? { streamSlot: input.streamSlot } : {}),
  };
}
