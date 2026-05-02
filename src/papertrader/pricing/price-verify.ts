/**
 * W7.4 — Pre-entry price verification via Jupiter quote API.
 * W7.4.1 — optional retries + circuit breaker (`jupiter-quote-resilience.ts`).
 */
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import { quoteResilienceFromPaperCfg } from '../config.js';
import type { PriceVerifyVerdict } from '../types.js';
import { WRAPPED_SOL_MINT } from '../types.js';
import {
  gateCircuit,
  isRetryableQuoteReason,
  recordTransportResult,
  resetQuoteResilienceForTests,
  sleepBackoff,
  type QuoteResilience,
} from './jupiter-quote-resilience.js';

const log = child('price-verify');

/**
 * Default Jupiter quote endpoint. Old `quote-api.jup.ag/v6/quote` was DNS-decommissioned
 * in 2025 — see Jupiter Developer Platform migration guide. We use the public lite-api
 * (no API key, ~60 req/min/IP, response shape backwards-compatible with v6: outAmount,
 * priceImpactPct, routePlan are the same field names). Override via PAPER_PRICE_VERIFY_QUOTE_URL.
 */
const QUOTE_API_BASE_DEFAULT = 'https://lite-api.jup.ag/swap/v1/quote';

export function quoteApiBase(): string {
  const v = process.env.PAPER_PRICE_VERIFY_QUOTE_URL?.trim();
  return v && v.length > 0 ? v : QUOTE_API_BASE_DEFAULT;
}

/**
 * W7.8 / W7.4 — raw GET `/swap/v1/quote` JSON (for Jupiter `/swap` body `quoteResponse`).
 * Same params as jupiterQuoteBuyPriceUsd/verifyEntryPrice.
 */
export async function fetchJupiterBuyQuoteResponse(args: {
  mint: string;
  sizeUsd: number;
  solUsd: number;
  slippageBps: number;
  timeoutMs: number;
  /** W7.4.1 — when set, retries + circuit (same as verify paths). */
  resilience?: QuoteResilience | null;
}): Promise<Record<string, unknown> | null> {
  const { mint, sizeUsd, solUsd, slippageBps, timeoutMs, resilience } = args;
  if (!(solUsd > 0) || !(sizeUsd > 0)) return null;

  const gated = gateCircuit(resilience ?? undefined);
  if (gated) return null;

  const maxAttempts = resilience?.maxAttempts ?? 1;
  const lamports = Math.max(1, Math.floor((sizeUsd / solUsd) * 1e9));
  const url = new URL(quoteApiBase());
  url.searchParams.set('inputMint', WRAPPED_SOL_MINT);
  url.searchParams.set('outputMint', mint);
  url.searchParams.set('amount', String(lamports));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');
  const urlStr = url.toString();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ac = new AbortController();
    const tt = setTimeout(() => ac.abort(), Math.max(500, timeoutMs));
    let okJson: Record<string, unknown> | null = null;
    try {
      const resp = await fetch(urlStr, {
        method: 'GET',
        signal: ac.signal,
        headers: { accept: 'application/json' },
      });
      if (!resp.ok) {
        okJson = null;
      } else {
        const j = (await resp.json()) as unknown;
        okJson =
          typeof j === 'object' && j != null && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
      }
    } catch {
      okJson = null;
    } finally {
      clearTimeout(tt);
    }

    if (okJson) {
      recordTransportResult(true, resilience ?? undefined);
      return okJson;
    }

    const more = attempt + 1 < maxAttempts && (resilience?.retriesEnabled ?? false);
    if (!more) {
      recordTransportResult(false, resilience ?? undefined);
      return null;
    }
    await sleepBackoff(resilience?.retryBackoffMs ?? 0, attempt);
  }

  return null;
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
  /** When set (e.g. W7.6 impulse within TTL), skip duplicate Jupiter HTTP request. */
  reuseVerdict?: PriceVerifyVerdict | null;
}

type JupiterQuoteBuyOnceArgs = {
  mint: string;
  outMintDecimals: number;
  sizeUsd: number;
  solUsd: number;
  snapshotPriceUsd: number;
  slippageBps: number;
  timeoutMs: number;
};

async function jupiterQuoteBuyPriceUsdOnce(args: JupiterQuoteBuyOnceArgs): Promise<PriceVerifyVerdict> {
  const { mint, outMintDecimals, sizeUsd, solUsd, snapshotPriceUsd, slippageBps, timeoutMs } = args;
  const ts = Date.now();

  const lamports = Math.max(1, Math.floor((sizeUsd / solUsd) * 1e9));
  const url = new URL(quoteApiBase());
  url.searchParams.set('inputMint', WRAPPED_SOL_MINT);
  url.searchParams.set('outputMint', mint);
  url.searchParams.set('amount', String(lamports));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');

  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), Math.max(500, timeoutMs));
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
      log.debug({ status: resp.status, mint, elapsed }, 'jupiter quote http error (impulse)');
      return { kind: 'skipped', reason: 'http-error', ts };
    }
    txt = await resp.text();
  } catch (e) {
    elapsed = Date.now() - start;
    const aborted = (e as Error)?.name === 'AbortError';
    log.debug(
      { mint, elapsed, err: (e as Error)?.message },
      aborted ? 'jupiter quote timeout (impulse)' : 'jupiter quote fetch fail (impulse)',
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

/**
 * Jupiter SOL→mint quote for a USD notional (same math as verifyEntryPrice).
 * Used by W7.6 impulse path even when W7.4 price verify is disabled.
 */
export async function jupiterQuoteBuyPriceUsd(
  args: JupiterQuoteBuyOnceArgs & { resilience?: QuoteResilience | null },
): Promise<PriceVerifyVerdict> {
  const { resilience, ...onceArgs } = args;
  const ts = Date.now();
  if (!(onceArgs.solUsd > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };
  if (!(onceArgs.snapshotPriceUsd > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };
  if (!(onceArgs.sizeUsd > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };

  const gated = gateCircuit(resilience ?? undefined);
  if (gated) return gated;

  const maxAttempts = resilience?.maxAttempts ?? 1;
  let last!: PriceVerifyVerdict;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await jupiterQuoteBuyPriceUsdOnce(onceArgs);
    if (last.kind === 'ok' || last.kind === 'blocked') {
      recordTransportResult(true, resilience ?? undefined);
      return last;
    }
    if (last.kind === 'skipped' && !isRetryableQuoteReason(last.reason)) {
      return last;
    }
    const more = attempt + 1 < maxAttempts && (resilience?.retriesEnabled ?? false);
    if (!more) {
      recordTransportResult(false, resilience ?? undefined);
      return last;
    }
    await sleepBackoff(resilience?.retryBackoffMs ?? 0, attempt);
  }
  return last;
}

type JupiterQuoteSellOnceArgs = {
  mint: string;
  tokenDecimals: number;
  usdNotional: number;
  solUsd: number;
  snapshotPriceUsd: number;
  slippageBps: number;
  timeoutMs: number;
};

async function jupiterQuoteSellPriceUsdOnce(args: JupiterQuoteSellOnceArgs): Promise<PriceVerifyVerdict> {
  const { mint, tokenDecimals, usdNotional, solUsd, snapshotPriceUsd, slippageBps, timeoutMs } = args;
  const ts = Date.now();
  const dec = Math.max(0, Math.min(24, Math.floor(tokenDecimals)));

  const tokenHuman = usdNotional / snapshotPriceUsd;
  const rawFloat = tokenHuman * Math.pow(10, dec);
  const rawAmount = Math.max(1, Math.floor(Number.isFinite(rawFloat) ? rawFloat : 0));
  const url = new URL(quoteApiBase());
  url.searchParams.set('inputMint', mint);
  url.searchParams.set('outputMint', WRAPPED_SOL_MINT);
  url.searchParams.set('amount', String(rawAmount));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');

  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), Math.max(500, timeoutMs));
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
      log.debug({ status: resp.status, mint, elapsed }, 'jupiter sell quote http error');
      return { kind: 'skipped', reason: 'http-error', ts };
    }
    txt = await resp.text();
  } catch (e) {
    elapsed = Date.now() - start;
    const aborted = (e as Error)?.name === 'AbortError';
    log.debug(
      { mint, elapsed, err: (e as Error)?.message },
      aborted ? 'jupiter sell quote timeout' : 'jupiter sell quote fetch fail',
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
  const lamportsOut = Number(outAmountStr);
  if (!(lamportsOut > 0)) {
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
  const tokensSold = rawAmount / Math.pow(10, dec);
  if (!(tokensSold > 0)) return { kind: 'skipped', reason: 'parse-error', ts };
  const usdOut = (lamportsOut / 1e9) * solUsd;
  const jupiterPriceUsd = usdOut / tokensSold;
  if (!(jupiterPriceUsd > 0) || !Number.isFinite(jupiterPriceUsd)) {
    return { kind: 'skipped', reason: 'parse-error', ts };
  }
  const priceImpactPct = +Number(body?.priceImpactPct ?? 0).toFixed(4) * 100;
  const routeHops = Array.isArray(body?.routePlan) ? body.routePlan.length : 1;
  const slipPct = +(((snapshotPriceUsd - jupiterPriceUsd) / snapshotPriceUsd) * 100).toFixed(4);

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

export async function jupiterQuoteSellPriceUsd(
  args: JupiterQuoteSellOnceArgs & { resilience?: QuoteResilience | null },
): Promise<PriceVerifyVerdict> {
  const { resilience, ...onceArgs } = args;
  const ts = Date.now();
  if (!(onceArgs.solUsd > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };
  if (!(onceArgs.snapshotPriceUsd > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };
  if (!(onceArgs.usdNotional > 0)) return { kind: 'skipped', reason: 'sol-px-missing', ts };

  const gated = gateCircuit(resilience ?? undefined);
  if (gated) return gated;

  const maxAttempts = resilience?.maxAttempts ?? 1;
  let last!: PriceVerifyVerdict;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await jupiterQuoteSellPriceUsdOnce(onceArgs);
    if (last.kind === 'ok' || last.kind === 'blocked') {
      recordTransportResult(true, resilience ?? undefined);
      return last;
    }
    if (last.kind === 'skipped' && !isRetryableQuoteReason(last.reason)) {
      return last;
    }
    const more = attempt + 1 < maxAttempts && (resilience?.retriesEnabled ?? false);
    if (!more) {
      recordTransportResult(false, resilience ?? undefined);
      return last;
    }
    await sleepBackoff(resilience?.retryBackoffMs ?? 0, attempt);
  }
  return last;
}

export interface VerifyExitPriceArgs {
  cfg: PaperTraderConfig;
  mint: string;
  tokenDecimals: number;
  usdNotional: number;
  solUsd: number;
  snapshotPriceUsd: number;
}

/** W7.4.2 — Jupiter token→SOL quote vs snapshot exit price (same slip/impact gates as entry). */
export async function verifyExitPrice(args: VerifyExitPriceArgs): Promise<PriceVerifyVerdict> {
  const { cfg, mint, tokenDecimals, usdNotional, solUsd, snapshotPriceUsd } = args;
  const ts = Date.now();
  if (!cfg.priceVerifyExitEnabled) return { kind: 'skipped', reason: 'feature-disabled', ts };

  const q = await jupiterQuoteSellPriceUsd({
    mint,
    tokenDecimals,
    usdNotional,
    solUsd,
    snapshotPriceUsd,
    slippageBps: cfg.priceVerifyMaxSlipBps,
    timeoutMs: cfg.priceVerifyTimeoutMs,
    resilience: quoteResilienceFromPaperCfg(cfg),
  });

  if (q.kind !== 'ok') return q;

  if (q.slipPct > cfg.priceVerifyMaxSlipPct) {
    return {
      kind: 'blocked',
      jupiterPriceUsd: q.jupiterPriceUsd,
      snapshotPriceUsd,
      slipPct: q.slipPct,
      priceImpactPct: q.priceImpactPct,
      routeHops: q.routeHops,
      reason: 'slip-too-high',
      source: 'jupiter',
      ageMs: q.ageMs,
      ts,
    };
  }
  if (q.priceImpactPct > cfg.priceVerifyMaxPriceImpactPct) {
    return {
      kind: 'blocked',
      jupiterPriceUsd: q.jupiterPriceUsd,
      snapshotPriceUsd,
      slipPct: q.slipPct,
      priceImpactPct: q.priceImpactPct,
      routeHops: q.routeHops,
      reason: 'impact-too-high',
      source: 'jupiter',
      ageMs: q.ageMs,
      ts,
    };
  }
  return q;
}

export async function verifyEntryPrice(args: VerifyEntryPriceArgs): Promise<PriceVerifyVerdict> {
  const { cfg, mint, outMintDecimals, sizeUsd, solUsd, snapshotPriceUsd, reuseVerdict } = args;
  const ts = Date.now();
  if (!cfg.priceVerifyEnabled) return { kind: 'skipped', reason: 'feature-disabled', ts };

  if (reuseVerdict?.kind === 'ok') {
    const q = reuseVerdict;
    const slipPct = +(((snapshotPriceUsd - q.jupiterPriceUsd) / snapshotPriceUsd) * 100).toFixed(4);
    if (slipPct > cfg.priceVerifyMaxSlipPct) {
      return {
        kind: 'blocked',
        jupiterPriceUsd: q.jupiterPriceUsd,
        snapshotPriceUsd,
        slipPct,
        priceImpactPct: q.priceImpactPct,
        routeHops: q.routeHops,
        reason: 'slip-too-high',
        source: 'jupiter',
        ageMs: q.ageMs,
        ts,
      };
    }
    if (q.priceImpactPct > cfg.priceVerifyMaxPriceImpactPct) {
      return {
        kind: 'blocked',
        jupiterPriceUsd: q.jupiterPriceUsd,
        snapshotPriceUsd,
        slipPct,
        priceImpactPct: q.priceImpactPct,
        routeHops: q.routeHops,
        reason: 'impact-too-high',
        source: 'jupiter',
        ageMs: q.ageMs,
        ts,
      };
    }
    return {
      kind: 'ok',
      jupiterPriceUsd: q.jupiterPriceUsd,
      snapshotPriceUsd,
      slipPct,
      priceImpactPct: q.priceImpactPct,
      routeHops: q.routeHops,
      source: 'jupiter',
      ageMs: q.ageMs,
      ts,
    };
  }

  const q = await jupiterQuoteBuyPriceUsd({
    mint,
    outMintDecimals,
    sizeUsd,
    solUsd,
    snapshotPriceUsd,
    slippageBps: cfg.priceVerifyMaxSlipBps,
    timeoutMs: cfg.priceVerifyTimeoutMs,
    resilience: quoteResilienceFromPaperCfg(cfg),
  });

  if (q.kind !== 'ok') return q;

  if (q.slipPct > cfg.priceVerifyMaxSlipPct) {
    return {
      kind: 'blocked',
      jupiterPriceUsd: q.jupiterPriceUsd,
      snapshotPriceUsd,
      slipPct: q.slipPct,
      priceImpactPct: q.priceImpactPct,
      routeHops: q.routeHops,
      reason: 'slip-too-high',
      source: 'jupiter',
      ageMs: q.ageMs,
      ts,
    };
  }
  if (q.priceImpactPct > cfg.priceVerifyMaxPriceImpactPct) {
    return {
      kind: 'blocked',
      jupiterPriceUsd: q.jupiterPriceUsd,
      snapshotPriceUsd,
      slipPct: q.slipPct,
      priceImpactPct: q.priceImpactPct,
      routeHops: q.routeHops,
      reason: 'impact-too-high',
      source: 'jupiter',
      ageMs: q.ageMs,
      ts,
    };
  }
  return q;
}

/** Test seam — vitest only. */
export function _priceVerifyInternalForTests(): void {
  resetQuoteResilienceForTests();
}
