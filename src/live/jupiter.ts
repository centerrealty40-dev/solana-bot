/**
 * W8.0 Phase 2 — Jupiter API: SOL→token quote + unsigned swap tx (live-oscar).
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { child } from '../core/logger.js';
import {
  JUPITER_QUOTE_URL_DEFAULT,
  JUPITER_SWAP_URL_DEFAULT,
  fetchJupiterSwapQuoteGetJson,
  jupiterJsonHeaders,
} from '../core/jupiter-http.js';
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';
import { adaptivePriorityMaxLamports } from './adaptive-priority-fee.js';
import type { LiveOscarConfig } from './config.js';

const log = child('live-jupiter');

export function resolveLiveJupiterQuoteUrl(cfg: LiveOscarConfig): string {
  const u = cfg.liveJupiterQuoteUrl?.trim();
  return u && u.length > 0 ? u : JUPITER_QUOTE_URL_DEFAULT;
}

export function resolveLiveJupiterSwapUrl(cfg: LiveOscarConfig): string {
  const u = cfg.liveJupiterSwapUrl?.trim();
  return u && u.length > 0 ? u : JUPITER_SWAP_URL_DEFAULT;
}

/** POST body for `/swap/v1/swap` (live-oscar). Adds Jupiter priority cap when configured. */
export function liveJupiterSwapPostBody(args: {
  cfg: LiveOscarConfig;
  quoteResponse: Record<string, unknown>;
  userPublicKey: string;
}): Record<string, unknown> {
  const { cfg, quoteResponse, userPublicKey } = args;
  const body: Record<string, unknown> = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: false,
    asLegacyTransaction: false,
  };
  const baseLp = cfg.liveJupiterPriorityMaxLamports;
  if (typeof baseLp === 'number' && baseLp >= 1) {
    /** 1.11.231 — при congestion boost'аем priority fee автоматически (см. `adaptive-priority-fee.ts`). */
    const maxLp = adaptivePriorityMaxLamports(baseLp);
    body.prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: {
        priorityLevel: cfg.liveJupiterSwapPriorityLevel,
        maxLamports: maxLp,
      },
    };
  }
  return body;
}

/** Deterministic user pubkey for Jupiter swap body when wallet not loaded (never live-send). */
export function liveJupiterPlaceholderPubkey(): string {
  const digest = createHash('sha256')
    .update('solana-alpha:live:jupiter:placeholder-v1', 'utf8')
    .digest();
  const seed = new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
  return Keypair.fromSeed(seed).publicKey.toBase58();
}

function routeHopsFromQuote(q: Record<string, unknown>): number {
  const rp = q.routePlan;
  return Array.isArray(rp) ? rp.length : 0;
}

/**
 * W8.0-p1 §5 quoteSnapshot (+ Phase 2 build flags).
 */
export function liveQuoteSnapshotFromResponse(
  quoteResponse: Record<string, unknown>,
  args: {
    slippageBps: number;
    quoteAgeMs: number;
    swapBuildOk?: boolean;
    swapTxBase64Len?: number;
    swapBuildReason?: string;
  },
): Record<string, unknown> {
  const pi = quoteResponse.priceImpactPct;
  const impact: number | string =
    typeof pi === 'number'
      ? pi
      : typeof pi === 'string'
        ? pi
        : quoteResponse.priceImpactPct != null
          ? String(quoteResponse.priceImpactPct)
          : '';

  const snap: Record<string, unknown> = {
    provider: 'jupiter',
    routeHops: routeHopsFromQuote(quoteResponse),
    priceImpactPct: impact,
    slippageBps: args.slippageBps,
    quoteAgeMs: args.quoteAgeMs,
    inputMint: typeof quoteResponse.inputMint === 'string' ? quoteResponse.inputMint : WRAPPED_SOL_MINT,
    outputMint: typeof quoteResponse.outputMint === 'string' ? quoteResponse.outputMint : '',
  };
  const inAmt = quoteResponse.inAmount;
  const outAmt = quoteResponse.outAmount;
  if (typeof inAmt === 'string' && /^\d+$/.test(inAmt)) snap.quoteInAmount = inAmt;
  else if (typeof inAmt === 'number' && Number.isFinite(inAmt) && inAmt >= 0)
    snap.quoteInAmount = String(Math.floor(inAmt));
  if (typeof outAmt === 'string' && /^\d+$/.test(outAmt)) snap.quoteOutAmount = outAmt;
  else if (typeof outAmt === 'number' && Number.isFinite(outAmt) && outAmt >= 0)
    snap.quoteOutAmount = String(Math.floor(outAmt));
  if (args.swapBuildOk !== undefined) snap.swapBuildOk = args.swapBuildOk;
  if (args.swapTxBase64Len !== undefined) snap.swapTxBase64Len = args.swapTxBase64Len;
  if (args.swapBuildReason !== undefined) snap.swapBuildReason = args.swapBuildReason;
  return snap;
}

/**
 * 1.11.231 — извлечь `priceImpactPct` из Jupiter quote как **process** (0..1+):
 *   `"priceImpactPct": "0.012"` → `0.012` (т.е. 1.2%)
 *   Возвращает `null`, если поле отсутствует или нечисловое.
 */
export function extractQuotePriceImpactPct(
  quoteResponse: Record<string, unknown> | undefined | null,
): number | null {
  if (!quoteResponse) return null;
  const raw = quoteResponse.priceImpactPct;
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * 1.11.231 — quote price-impact pre-check.
 *
 * `limitPct` — порог в %. Например `limitPct=0.5` означает «блочить при impact > 0.5%».
 * `priceImpactPct` от Jupiter — это процент в виде 0..1 (например `0.0123` = 1.23%).
 *
 * Сравниваем `pct = rawPriceImpact * 100`.
 * Возвращает `{ blocked: true, pct }` если выше порога.
 * Возвращает `{ blocked: false, pct }` если ниже / null / выкл (`limitPct<=0`).
 */
export function isQuotePriceImpactTooHigh(
  quoteResponse: Record<string, unknown> | undefined | null,
  limitPct: number,
): { blocked: boolean; pct: number | null } {
  if (!(limitPct > 0)) return { blocked: false, pct: extractQuotePriceImpactPct(quoteResponse) };
  const raw = extractQuotePriceImpactPct(quoteResponse);
  if (raw == null) return { blocked: false, pct: null };
  const pct = raw * 100;
  return { blocked: pct > limitPct, pct };
}

/**
 * W8.0 parent §10 — when `maxAgeMs` is set (>0), swap is blocked if `quoteAgeMs` is missing, invalid, or exceeds the limit.
 */
export function liveQuoteExceedsMaxAge(
  quoteSnapshot: Record<string, unknown>,
  maxAgeMs: number | undefined,
): boolean {
  if (maxAgeMs == null || maxAgeMs <= 0) return false;
  const raw = quoteSnapshot.quoteAgeMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return true;
  return raw > maxAgeMs;
}

async function httpGetQuote(
  quoteBaseUrl: string,
  args: {
    outputMint: string;
    sizeUsd: number;
    solUsd: number;
    slippageBps: number;
    timeoutMs: number;
  },
): Promise<Record<string, unknown> | null> {
  const { outputMint, sizeUsd, solUsd, slippageBps, timeoutMs } = args;
  if (!(solUsd > 0) || !(sizeUsd > 0)) return null;
  const lamports = Math.max(1, Math.floor((sizeUsd / solUsd) * 1e9));
  const url = new URL(quoteBaseUrl);
  url.searchParams.set('inputMint', WRAPPED_SOL_MINT);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(lamports));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');
  const j = await fetchJupiterSwapQuoteGetJson({
    url: url.toString(),
    timeoutMs,
  });
  return j;
}

/**
 * Fetch SOL→token quote from Jupiter; returns raw `quoteResponse` + normalized `quoteSnapshot` (§5).
 *
 * 1.11.230 — `slippageBpsOverride` (optional) позволяет адаптивно поднимать slippage на retry'ях
 * в phase4-execution, не меняя глобальный `cfg.liveDefaultSlippageBps`.
 */
export async function liveFetchBuyQuote(args: {
  cfg: LiveOscarConfig;
  outputMint: string;
  sizeUsd: number;
  solUsd: number;
  slippageBpsOverride?: number;
}): Promise<{ quoteResponse: Record<string, unknown>; quoteSnapshot: Record<string, unknown> } | null> {
  const { cfg, outputMint, sizeUsd, solUsd } = args;
  const slippageBps = args.slippageBpsOverride ?? cfg.liveDefaultSlippageBps;
  const t0 = Date.now();
  const quoteResponse = await httpGetQuote(resolveLiveJupiterQuoteUrl(cfg), {
    outputMint,
    sizeUsd,
    solUsd,
    slippageBps,
    timeoutMs: cfg.liveJupiterQuoteTimeoutMs,
  });
  const quoteAgeMs = Date.now() - t0;
  if (!quoteResponse) return null;
  const quoteSnapshot = liveQuoteSnapshotFromResponse(quoteResponse, {
    slippageBps,
    quoteAgeMs,
  });
  return { quoteResponse, quoteSnapshot };
}

/**
 * POST `/swap/v1/swap` → base64 unsigned tx (same policy as W7.8 sim-audit).
 */
export async function liveBuildUnsignedSwapTx(args: {
  cfg: LiveOscarConfig;
  quoteResponse: Record<string, unknown>;
  userPublicKey: string;
}): Promise<{ ok: true; b64: string } | { ok: false; reason: string }> {
  const { cfg, quoteResponse, userPublicKey } = args;
  const buildTimeoutMs = cfg.liveJupiterSwapTimeoutMs;
  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), Math.max(300, buildTimeoutMs));
  const headers = jupiterJsonHeaders({ 'content-type': 'application/json' });
  try {
    const body = liveJupiterSwapPostBody({ cfg, quoteResponse, userPublicKey });
    const res = await fetch(resolveLiveJupiterSwapUrl(cfg), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const txt = await res.text();
    if (!res.ok) {
      log.debug(
        { status: res.status, rateLimited: res.status === 429, snippet: txt.slice(0, 200) },
        res.status === 429 ? 'live jupiter swap rate limited' : 'live jupiter swap http',
      );
      return { ok: false, reason: `swap-http-${res.status}` };
    }
    let j: { swapTransaction?: string };
    try {
      j = JSON.parse(txt) as { swapTransaction?: string };
    } catch {
      return { ok: false, reason: 'swap-parse' };
    }
    if (!j.swapTransaction || typeof j.swapTransaction !== 'string') {
      return { ok: false, reason: 'no-swap-tx' };
    }
    return { ok: true, b64: j.swapTransaction };
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    return { ok: false, reason: aborted ? 'swap-timeout' : 'swap-fetch' };
  } finally {
    clearTimeout(tt);
  }
}

/**
 * Quote + optional unsigned swap build; merges build outcome into `quoteSnapshot` for JSONL.
 */
export async function liveBuyQuoteAndPrepareSnapshot(args: {
  cfg: LiveOscarConfig;
  outputMint: string;
  sizeUsd: number;
  solUsd: number;
  userPublicKey: string;
  /** 1.11.230 — адаптивный slippage для retry'ев под Jupiter Pro. */
  slippageBpsOverride?: number;
}): Promise<{
  quoteResponse: Record<string, unknown>;
  quoteSnapshot: Record<string, unknown>;
  swapBuild: { ok: true; b64: string } | { ok: false; reason: string };
} | null> {
  const fetched = await liveFetchBuyQuote(args);
  if (!fetched) return null;

  const swapBuild = await liveBuildUnsignedSwapTx({
    cfg: args.cfg,
    quoteResponse: fetched.quoteResponse,
    userPublicKey: args.userPublicKey,
  });

  const age =
    typeof fetched.quoteSnapshot.quoteAgeMs === 'number' ? fetched.quoteSnapshot.quoteAgeMs : 0;
  const slippageBps = args.slippageBpsOverride ?? args.cfg.liveDefaultSlippageBps;
  const quoteSnapshot = liveQuoteSnapshotFromResponse(fetched.quoteResponse, {
    slippageBps,
    quoteAgeMs: age,
    swapBuildOk: swapBuild.ok,
    swapTxBase64Len: swapBuild.ok ? swapBuild.b64.length : undefined,
    swapBuildReason: swapBuild.ok ? undefined : swapBuild.reason,
  });

  return { quoteResponse: fetched.quoteResponse, quoteSnapshot, swapBuild };
}

async function httpGetSellQuote(
  quoteBaseUrl: string,
  args: {
    inputMint: string;
    amountRaw: string;
    slippageBps: number;
    timeoutMs: number;
  },
): Promise<Record<string, unknown> | null> {
  const { inputMint, amountRaw, slippageBps, timeoutMs } = args;
  const url = new URL(quoteBaseUrl);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', WRAPPED_SOL_MINT);
  url.searchParams.set('amount', amountRaw);
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');
  return fetchJupiterSwapQuoteGetJson({
    url: url.toString(),
    timeoutMs,
  });
}

/**
 * Token → SOL quote + optional unsigned swap (W8.0-p4 sells / exits).
 * 1.11.230 — `slippageBpsOverride` для адаптивного bump'а в retry-цикле.
 */
export async function liveSellQuoteAndPrepareSnapshot(args: {
  cfg: LiveOscarConfig;
  inputMint: string;
  tokenAmountRaw: string;
  solUsd: number;
  userPublicKey: string;
  slippageBpsOverride?: number;
}): Promise<{
  quoteResponse: Record<string, unknown>;
  quoteSnapshot: Record<string, unknown>;
  swapBuild: { ok: true; b64: string } | { ok: false; reason: string };
} | null> {
  const { cfg, inputMint, tokenAmountRaw, solUsd, userPublicKey } = args;
  if (!(solUsd > 0) || !tokenAmountRaw || tokenAmountRaw === '0') return null;
  const slippageBps = args.slippageBpsOverride ?? cfg.liveDefaultSlippageBps;
  const t0 = Date.now();
  const quoteResponse = await httpGetSellQuote(resolveLiveJupiterQuoteUrl(cfg), {
    inputMint,
    amountRaw: tokenAmountRaw,
    slippageBps,
    timeoutMs: cfg.liveJupiterQuoteTimeoutMs,
  });
  const quoteAgeMs = Date.now() - t0;
  if (!quoteResponse) return null;

  const swapBuild = await liveBuildUnsignedSwapTx({
    cfg,
    quoteResponse,
    userPublicKey,
  });

  const quoteSnapshot = liveQuoteSnapshotFromResponse(quoteResponse, {
    slippageBps,
    quoteAgeMs,
    swapBuildOk: swapBuild.ok,
    swapTxBase64Len: swapBuild.ok ? swapBuild.b64.length : undefined,
    swapBuildReason: swapBuild.ok ? undefined : swapBuild.reason,
  });

  return { quoteResponse, quoteSnapshot, swapBuild };
}
