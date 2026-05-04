/**
 * W7.8 — `simulateTransaction` audit: Jupiter unsigned tx + QuickNode (feature `sim`).
 * Non-gating v1 — only stamps JSONL on `open`.
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { qnCall } from '../../core/rpc/qn-client.js';
import { child } from '../../core/logger.js';
import { quoteResilienceFromPaperCfg, type PaperTraderConfig } from '../config.js';
import type { SimAuditStamp } from '../types.js';
import { fetchJupiterBuyQuoteResponse } from './price-verify.js';

const log = child('sim-audit');

const JUPITER_SWAP_DEFAULT = 'https://lite-api.jup.ag/swap/v1/swap';

function swapApiUrl(): string {
  const v = process.env.PAPER_JUPITER_SWAP_URL?.trim();
  return v && v.length > 0 ? v : JUPITER_SWAP_DEFAULT;
}

/** Deterministic placeholder user for Jupiter (never used to sign `sendTransaction`). */
function paperSimUserPubkeyB58(): string {
  const digest = createHash('sha256')
    .update('solana-alpha:paper:sim-audit:placeholder-v1', 'utf8')
    .digest();
  const seed = new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
  return Keypair.fromSeed(seed).publicKey.toBase58();
}

function isSampled(cfg: PaperTraderConfig, mint: string, entryTs: number): boolean {
  if (cfg.simSamplePct <= 0) return false;
  if (cfg.simSamplePct >= 100) return true;
  const h = createHash('sha256').update(`${cfg.strategyId}:${mint}:${entryTs}`).digest();
  return h[0]! % 100 < cfg.simSamplePct;
}

type SimValue = {
  err?: unknown;
  logs?: string[];
  unitsConsumed?: number;
};

function parseSimulateResult(r: unknown): { err: unknown | null; units: number | null; log0: string | null } {
  if (r == null || typeof r !== 'object') return { err: 'no-result', units: null, log0: null };
  const root = r as Record<string, unknown>;
  const inner = root.value != null && typeof root.value === 'object' ? (root.value as SimValue) : (root as SimValue);
  const u = inner.unitsConsumed;
  const rawErr = inner.err !== undefined ? inner.err : root.err;
  const err = rawErr == null || rawErr === false ? null : rawErr;
  const logs = inner.logs;
  const log0 = Array.isArray(logs) && typeof logs[0] === 'string' ? logs[0] : null;
  return {
    err,
    units: Number.isFinite(u) ? (u as number) : null,
    log0,
  };
}

async function jupiterBuildSwapBase64(
  quoteResponse: Record<string, unknown>,
  userPublicKey: string,
  buildTimeoutMs: number,
): Promise<{ ok: true; b64: string } | { ok: false; reason: string }> {
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
    const res = await fetch(swapApiUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const txt = await res.text();
    if (!res.ok) {
      log.debug({ status: res.status, snippet: txt.slice(0, 200) }, 'jupiter swap build http');
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

export interface OpenSimAuditArgs {
  cfg: PaperTraderConfig;
  mint: string;
  entryTs: number;
  solUsd: number;
}

function wallLeftMs(startedAt: number, capMs: number): number {
  return Math.max(0, capMs - (Date.now() - startedAt));
}

function mapQnFailure(reason: 'budget' | 'rate' | 'http' | 'timeout' | 'rpc_error'): SimAuditStamp {
  switch (reason) {
    case 'budget':
      return { kind: 'skipped', reason: 'qn_budget', ts: Date.now() };
    case 'rate':
      return { kind: 'skipped', reason: 'qn_rate', ts: Date.now() };
    case 'timeout':
      return { kind: 'skipped', reason: 'qn_timeout', ts: Date.now() };
    case 'rpc_error':
      return { kind: 'skipped', reason: 'qn_rpc_error', ts: Date.now() };
    default:
      return { kind: 'skipped', reason: 'qn_http', ts: Date.now() };
  }
}

/**
 * After all entry gates, optionally attach `simAudit` on `open` (non-gating v1).
 * Returns `null` when the field should be omitted from JSONL (`disabled`, `not_sampled`, zero sample rate).
 */
export async function runOpenSimAudit(args: OpenSimAuditArgs): Promise<SimAuditStamp | null> {
  const { cfg, mint, entryTs, solUsd } = args;
  const t0 = Date.now();
  const wallCap = cfg.simMaxWallMs;

  if (!cfg.simAuditEnabled) {
    return null;
  }
  if (cfg.simSamplePct <= 0 || !isSampled(cfg, mint, entryTs)) {
    return null;
  }
  if (!cfg.simUseJupiterBuild) {
    return { kind: 'skipped', reason: 'no_build', ts: Date.now(), wallMs: Date.now() - t0 };
  }
  const openProbeUsd = cfg.positionUsd * cfg.entryFirstLegFraction;
  if (!(solUsd > 0) || !Number.isFinite(openProbeUsd) || openProbeUsd <= 0) {
    return { kind: 'skipped', reason: 'sol-px-missing', ts: Date.now(), wallMs: Date.now() - t0 };
  }

  const quoteTimeout = Math.min(cfg.simBuildTimeoutMs, Math.max(500, wallLeftMs(t0, wallCap)));
  if (quoteTimeout < 400) {
    return { kind: 'skipped', reason: 'timeout', ts: Date.now(), wallMs: Date.now() - t0 };
  }

  const quote = await fetchJupiterBuyQuoteResponse({
    mint,
    sizeUsd: openProbeUsd,
    solUsd,
    slippageBps: cfg.priceVerifyMaxSlipBps,
    timeoutMs: quoteTimeout,
    resilience: quoteResilienceFromPaperCfg(cfg),
  });
  if (!quote || typeof quote !== 'object') {
    return { kind: 'skipped', reason: 'no_build', ts: Date.now(), wallMs: Date.now() - t0 };
  }

  const buildBudget = Math.min(cfg.simBuildTimeoutMs, Math.max(300, wallLeftMs(t0, wallCap)));
  if (buildBudget < 300) {
    return { kind: 'skipped', reason: 'timeout', ts: Date.now(), wallMs: Date.now() - t0 };
  }

  const build = await jupiterBuildSwapBase64(quote, paperSimUserPubkeyB58(), buildBudget);
  if (!build.ok) {
    return { kind: 'skipped', reason: build.reason, ts: Date.now(), wallMs: Date.now() - t0 };
  }

  const rpcTimeout = Math.max(2000, Math.min(30_000, wallLeftMs(t0, wallCap)));
  if (rpcTimeout < 2000) {
    return { kind: 'skipped', reason: 'timeout', ts: Date.now(), wallMs: Date.now() - t0 };
  }

  const simRes = await qnCall<unknown>(
    'simulateTransaction',
    [
      build.b64,
      {
        encoding: 'base64',
        commitment: 'processed',
        replaceRecentBlockhash: true,
        sigVerify: false,
        innerInstructions: false,
      },
    ],
    {
      feature: 'sim',
      creditsPerCall: cfg.simCredsPerCall,
      timeoutMs: rpcTimeout,
    },
  );

  const wallMs = Date.now() - t0;
  if (!simRes.ok) {
    const stamp = mapQnFailure(simRes.reason);
    return { ...stamp, wallMs };
  }

  const { err, units, log0 } = parseSimulateResult(simRes.value);
  const qnC = cfg.simCredsPerCall;
  if (err != null) {
    return {
      kind: 'err',
      ts: Date.now(),
      wallMs,
      qnCredits: qnC,
      err: {
        code: -1,
        message: typeof err === 'string' ? err : JSON.stringify(err).slice(0, 500),
      },
      unitsConsumed: units,
      buildKind: 'jupiter',
      notes: log0 ? `log0:${log0.slice(0, 120)}` : undefined,
    };
  }
  return {
    kind: 'ok',
    ts: Date.now(),
    wallMs,
    qnCredits: qnC,
    err: null,
    unitsConsumed: units,
    buildKind: 'jupiter',
  };
}
