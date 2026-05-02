/**
 * W8.0 Phase 2 — Jupiter lite-api: SOL→token quote + unsigned swap tx (live-oscar).
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { child } from '../core/logger.js';
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';

const log = child('live-jupiter');

const QUOTE_URL_DEFAULT = 'https://lite-api.jup.ag/swap/v1/quote';
const SWAP_URL_DEFAULT = 'https://lite-api.jup.ag/swap/v1/swap';

export function resolveLiveJupiterQuoteUrl(cfg: LiveOscarConfig): string {
  const u = cfg.liveJupiterQuoteUrl?.trim();
  return u && u.length > 0 ? u : QUOTE_URL_DEFAULT;
}

export function resolveLiveJupiterSwapUrl(cfg: LiveOscarConfig): string {
  const u = cfg.liveJupiterSwapUrl?.trim();
  return u && u.length > 0 ? u : SWAP_URL_DEFAULT;
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
  if (args.swapBuildOk !== undefined) snap.swapBuildOk = args.swapBuildOk;
  if (args.swapTxBase64Len !== undefined) snap.swapTxBase64Len = args.swapTxBase64Len;
  if (args.swapBuildReason !== undefined) snap.swapBuildReason = args.swapBuildReason;
  return snap;
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
  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), Math.max(500, timeoutMs));
  try {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as unknown;
    return typeof j === 'object' && j != null && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(tt);
  }
}

/**
 * Fetch SOL→token quote from Jupiter; returns raw `quoteResponse` + normalized `quoteSnapshot` (§5).
 */
export async function liveFetchBuyQuote(args: {
  cfg: LiveOscarConfig;
  outputMint: string;
  sizeUsd: number;
  solUsd: number;
}): Promise<{ quoteResponse: Record<string, unknown>; quoteSnapshot: Record<string, unknown> } | null> {
  const { cfg, outputMint, sizeUsd, solUsd } = args;
  const t0 = Date.now();
  const quoteResponse = await httpGetQuote(resolveLiveJupiterQuoteUrl(cfg), {
    outputMint,
    sizeUsd,
    solUsd,
    slippageBps: cfg.liveDefaultSlippageBps,
    timeoutMs: cfg.liveJupiterQuoteTimeoutMs,
  });
  const quoteAgeMs = Date.now() - t0;
  if (!quoteResponse) return null;
  const quoteSnapshot = liveQuoteSnapshotFromResponse(quoteResponse, {
    slippageBps: cfg.liveDefaultSlippageBps,
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
  const key = process.env.JUPITER_API_KEY?.trim();
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (key) headers['x-api-key'] = key;
  try {
    const body = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: false,
      asLegacyTransaction: false,
    };
    const res = await fetch(resolveLiveJupiterSwapUrl(cfg), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const txt = await res.text();
    if (!res.ok) {
      log.debug({ status: res.status, snippet: txt.slice(0, 200) }, 'live jupiter swap http');
      return { ok: false, reason: 'swap-http' };
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
  const quoteSnapshot = liveQuoteSnapshotFromResponse(fetched.quoteResponse, {
    slippageBps: args.cfg.liveDefaultSlippageBps,
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
  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), Math.max(500, timeoutMs));
  try {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as unknown;
    return typeof j === 'object' && j != null && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(tt);
  }
}

/** Token → SOL quote + optional unsigned swap (W8.0-p4 sells / exits). */
export async function liveSellQuoteAndPrepareSnapshot(args: {
  cfg: LiveOscarConfig;
  inputMint: string;
  tokenAmountRaw: string;
  solUsd: number;
  userPublicKey: string;
}): Promise<{
  quoteResponse: Record<string, unknown>;
  quoteSnapshot: Record<string, unknown>;
  swapBuild: { ok: true; b64: string } | { ok: false; reason: string };
} | null> {
  const { cfg, inputMint, tokenAmountRaw, solUsd, userPublicKey } = args;
  if (!(solUsd > 0) || !tokenAmountRaw || tokenAmountRaw === '0') return null;
  const t0 = Date.now();
  const quoteResponse = await httpGetSellQuote(resolveLiveJupiterQuoteUrl(cfg), {
    inputMint,
    amountRaw: tokenAmountRaw,
    slippageBps: cfg.liveDefaultSlippageBps,
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
    slippageBps: cfg.liveDefaultSlippageBps,
    quoteAgeMs,
    swapBuildOk: swapBuild.ok,
    swapTxBase64Len: swapBuild.ok ? swapBuild.b64.length : undefined,
    swapBuildReason: swapBuild.ok ? undefined : swapBuild.reason,
  });

  return { quoteResponse, quoteSnapshot, swapBuild };
}
