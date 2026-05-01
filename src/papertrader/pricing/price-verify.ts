/**
 * W7.4 — Pre-entry price verification via Jupiter quote API.
 * Public-free HTTP; single attempt, hard timeout.
 */
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import type { PriceVerifyVerdict } from '../types.js';
import { WRAPPED_SOL_MINT } from '../types.js';

const log = child('price-verify');

/**
 * Default Jupiter quote endpoint. Old `quote-api.jup.ag/v6/quote` was DNS-decommissioned
 * in 2025 — see Jupiter Developer Platform migration guide. We use the public lite-api
 * (no API key, ~60 req/min/IP, response shape backwards-compatible with v6: outAmount,
 * priceImpactPct, routePlan are the same field names). Override via PAPER_PRICE_VERIFY_QUOTE_URL.
 */
const QUOTE_API_BASE_DEFAULT = 'https://lite-api.jup.ag/swap/v1/quote';

function quoteApiBase(): string {
  const v = process.env.PAPER_PRICE_VERIFY_QUOTE_URL?.trim();
  return v && v.length > 0 ? v : QUOTE_API_BASE_DEFAULT;
}

interface JupiterQuoteResponse {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string;
  routePlan?: Array<unknown>;
  swapMode?: string;
  slippageBps?: number;
}

export interface VerifyEntryPriceArgs {
  cfg: PaperTraderConfig;
  mint: string;
  outMintDecimals: number;
  sizeUsd: number;
  solUsd: number;
  snapshotPriceUsd: number;
}

export async function verifyEntryPrice(args: VerifyEntryPriceArgs): Promise<PriceVerifyVerdict> {
  const { cfg, mint, outMintDecimals, sizeUsd, solUsd, snapshotPriceUsd } = args;
  const ts = Date.now();
  if (!cfg.priceVerifyEnabled) return { kind: 'skipped', reason: 'feature-disabled', ts };
  if (!(solUsd > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };
  if (!(snapshotPriceUsd > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };
  if (!(sizeUsd > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };

  const lamports = Math.max(1, Math.floor((sizeUsd / solUsd) * 1e9));
  const url = new URL(quoteApiBase());
  url.searchParams.set('inputMint', WRAPPED_SOL_MINT);
  url.searchParams.set('outputMint', mint);
  url.searchParams.set('amount', String(lamports));
  url.searchParams.set('slippageBps', String(cfg.priceVerifyMaxSlipBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');

  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), Math.max(500, cfg.priceVerifyTimeoutMs));
  let elapsed = 0;
  let resp: Response | null = null;
  let txt: string | null = null;
  const start = Date.now();
  try {
    resp = await fetch(url.toString(), {
      method: 'GET',
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    elapsed = Date.now() - start;
    if (!resp.ok) {
      log.debug({ status: resp.status, mint, elapsed }, 'jupiter quote http error');
      return { kind: 'skipped', reason: 'http-error', ts };
    }
    txt = await resp.text();
  } catch (e) {
    elapsed = Date.now() - start;
    const aborted = (e as Error)?.name === 'AbortError';
    log.debug(
      { mint, elapsed, err: (e as Error)?.message },
      aborted ? 'jupiter quote timeout' : 'jupiter quote fetch fail',
    );
    return { kind: 'skipped', reason: aborted ? 'timeout' : 'fetch-fail', ts };
  } finally {
    clearTimeout(tt);
  }

  let body: JupiterQuoteResponse | null = null;
  try {
    body = JSON.parse(txt!) as JupiterQuoteResponse;
  } catch {
    return { kind: 'skipped', reason: 'parse-error', ts };
  }

  const outAmountStr = body?.outAmount;
  if (!outAmountStr || !/^\d+$/.test(outAmountStr)) {
    return { kind: 'skipped', reason: 'parse-error', ts };
  }
  const outAmount = Number(outAmountStr);
  if (!(outAmount > 0)) {
    return {
      kind: 'blocked',
      jupiterPriceUsd: 0,
      snapshotPriceUsd,
      slipPct: 0,
      priceImpactPct: 0,
      routeHops: 0,
      reason: 'no-route',
      source: 'jupiter',
      ageMs: elapsed,
      ts,
    };
  }
  const tokenOut = outAmount / Math.pow(10, Math.max(0, outMintDecimals));
  if (!(tokenOut > 0)) return { kind: 'skipped', reason: 'parse-error', ts };
  const usdIn = (lamports / 1e9) * solUsd;
  const jupiterPriceUsd = usdIn / tokenOut;
  if (!(jupiterPriceUsd > 0) || !Number.isFinite(jupiterPriceUsd)) {
    return { kind: 'skipped', reason: 'parse-error', ts };
  }
  const priceImpactPct = +Number(body?.priceImpactPct ?? 0).toFixed(4) * 100;
  const routeHops = Array.isArray(body?.routePlan) ? body.routePlan.length : 1;
  const slipPct = +(((snapshotPriceUsd - jupiterPriceUsd) / snapshotPriceUsd) * 100).toFixed(4);

  if (slipPct > cfg.priceVerifyMaxSlipPct) {
    return {
      kind: 'blocked',
      jupiterPriceUsd,
      snapshotPriceUsd,
      slipPct,
      priceImpactPct,
      routeHops,
      reason: 'slip-too-high',
      source: 'jupiter',
      ageMs: elapsed,
      ts,
    };
  }
  if (priceImpactPct > cfg.priceVerifyMaxPriceImpactPct) {
    return {
      kind: 'blocked',
      jupiterPriceUsd,
      snapshotPriceUsd,
      slipPct,
      priceImpactPct,
      routeHops,
      reason: 'impact-too-high',
      source: 'jupiter',
      ageMs: elapsed,
      ts,
    };
  }
  return {
    kind: 'ok',
    jupiterPriceUsd,
    snapshotPriceUsd,
    slipPct,
    priceImpactPct,
    routeHops,
    source: 'jupiter',
    ageMs: elapsed,
    ts,
  };
}

/** Test seam — vitest only. */
export function _priceVerifyInternalForTests(): void {
  /* no-op */
}
