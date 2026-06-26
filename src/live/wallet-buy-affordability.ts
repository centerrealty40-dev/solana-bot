/**
 * Live wallet SOL affordability for buy_open — suppresses discovery Telegram noise and
 * avoids retry loops when the wallet cannot fund the Jupiter swap.
 */
import { lamportsFromGetBalanceResult, qnCall } from '../core/rpc/qn-client.js';
import { getSolUsd } from '../papertrader/pricing.js';
import type { LiveOscarConfig } from './config.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';

function walletPubkey58(cfg: LiveOscarConfig): string | null {
  const s = cfg.walletSecret?.trim();
  if (!s) return null;
  try {
    return loadLiveKeypairFromSecretEnv(s).publicKey.toBase58();
  } catch {
    return null;
  }
}

export async function rpcWalletSolLamports(cfg: LiveOscarConfig): Promise<bigint | null> {
  const pk = walletPubkey58(cfg);
  if (!pk) return null;
  const res = await qnCall<unknown>('getBalance', [pk, { commitment: 'processed' }], {
    feature: 'sim',
    creditsPerCall: cfg.liveSimCreditsPerCall,
    timeoutMs: cfg.liveSimTimeoutMs,
    httpUrl: cfg.liveRpcHttpUrl,
  });
  if (!res.ok) return null;
  return lamportsFromGetBalanceResult(res.value);
}

export function isInsufficientFundsSimError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('insufficientfunds') ||
    m.includes('custom":1') ||
    m.includes("custom':1") ||
    m.includes('custom program error: 0x1') ||
    /instructionerror.*custom.:1/i.test(message)
  );
}

export function requiredLamportsForBuyQuote(
  quoteInLamports: bigint,
  bufferLamports: number,
): bigint {
  const buf = BigInt(Math.max(0, bufferLamports));
  return quoteInLamports + buf;
}

/** Max |quote−estimate|/estimate before we distrust Jupiter inAmount for afford gate (1.11.459). */
export const BUY_QUOTE_VS_ESTIMATE_MAX_DRIFT_PCT = 15;

export function buyQuoteVsEstimateDriftPct(
  quoteInLamports: bigint,
  estimateLamports: bigint,
): number | null {
  if (estimateLamports <= 0n) return null;
  const diff = quoteInLamports - estimateLamports;
  const pct = (Number(diff) / Number(estimateLamports)) * 100;
  return Number.isFinite(pct) ? pct : null;
}

export function isBuyQuoteInAmountSane(args: {
  intendedUsd: number;
  solUsd: number;
  quoteInLamports: bigint;
  maxDriftPct?: number;
}): { sane: boolean; estimateLamports: bigint; driftPct: number | null } {
  const estimateLamports = estimateLamportsForBuyUsd(args.intendedUsd, args.solUsd);
  const driftPct = buyQuoteVsEstimateDriftPct(args.quoteInLamports, estimateLamports);
  const cap = args.maxDriftPct ?? BUY_QUOTE_VS_ESTIMATE_MAX_DRIFT_PCT;
  const sane =
    estimateLamports > 0n &&
    driftPct != null &&
    Math.abs(driftPct) <= cap;
  return { sane, estimateLamports, driftPct };
}

/**
 * Afford gate: trust Jupiter `inAmount` only when it matches fresh SOL/USD sizing.
 * Stale `getSolUsd()` can inflate quote ~2× and false-trigger insufficient_wallet_sol.
 */
export function resolveBuyAffordRequiredLamports(args: {
  intendedUsd: number;
  solUsd: number;
  quoteInLamports: bigint;
  bufferLamports: number;
  maxDriftPct?: number;
}): {
  requiredLamports: bigint;
  estimateLamports: bigint;
  quoteInLamports: bigint;
  source: 'quote' | 'estimate';
  driftPct: number | null;
  sane: boolean;
} {
  const { sane, estimateLamports, driftPct } = isBuyQuoteInAmountSane(args);
  const base = sane ? args.quoteInLamports : estimateLamports;
  return {
    requiredLamports: requiredLamportsForBuyQuote(base, args.bufferLamports),
    estimateLamports,
    quoteInLamports: args.quoteInLamports,
    source: sane ? 'quote' : 'estimate',
    driftPct,
    sane,
  };
}

export function estimateLamportsForBuyUsd(usdNotional: number, solUsd: number): bigint {
  if (!(usdNotional > 0) || !(solUsd > 0)) return 0n;
  return BigInt(Math.ceil((usdNotional / solUsd) * 1e9));
}

/** Native SOL left after fee/rent reserve — never negative. */
export function spendableLamportsForBuy(walletLamports: bigint, bufferLamports: number): bigint {
  const buf = BigInt(Math.max(0, bufferLamports));
  return walletLamports > buf ? walletLamports - buf : 0n;
}

/** Max USD notional fundable from wallet SOL minus reserve (estimate via SOL/USD). */
export function maxAffordableBuyUsd(
  walletLamports: bigint,
  bufferLamports: number,
  solUsd: number,
): number {
  if (!(solUsd > 0)) return 0;
  const spendable = spendableLamportsForBuy(walletLamports, bufferLamports);
  if (spendable <= 0n) return 0;
  return (Number(spendable) / 1e9) * solUsd;
}

export type PartialBuyNotionalResolution = {
  ok: boolean;
  usdNotional: number;
  maxAffordableUsd: number;
};

/**
 * When wallet cannot fund the full planned slice, shrink to what fits above `minUsd`.
 * Returns `ok: false` when partial is below minimum or equals the planned amount.
 */
export function resolvePartialBuyNotional(args: {
  plannedUsd: number;
  walletLamports: bigint;
  bufferLamports: number;
  solUsd: number;
  minUsd: number;
}): PartialBuyNotionalResolution {
  const maxUsd = maxAffordableBuyUsd(args.walletLamports, args.bufferLamports, args.solUsd);
  const capped = Math.min(args.plannedUsd, maxUsd);
  const partial = Math.floor(capped * 100) / 100;
  const min = Math.max(0, args.minUsd);
  if (partial >= min && partial + 1e-6 < args.plannedUsd) {
    return { ok: true, usdNotional: partial, maxAffordableUsd: maxUsd };
  }
  return { ok: false, usdNotional: args.plannedUsd, maxAffordableUsd: maxUsd };
}

export type LiveWalletAffordability = {
  ok: boolean;
  reason?: 'wallet_balance_rpc' | 'insufficient_wallet_sol';
  lamports?: bigint;
  requiredLamports?: bigint;
};

export async function liveWalletCanAffordLamports(
  cfg: LiveOscarConfig,
  requiredLamports: bigint,
): Promise<LiveWalletAffordability> {
  if (requiredLamports <= 0n) return { ok: true };
  const lamports = await rpcWalletSolLamports(cfg);
  if (lamports == null) {
    return { ok: false, reason: 'wallet_balance_rpc', requiredLamports };
  }
  if (lamports < requiredLamports) {
    return {
      ok: false,
      reason: 'insufficient_wallet_sol',
      lamports,
      requiredLamports,
    };
  }
  return { ok: true, lamports, requiredLamports };
}

export async function liveWalletCanAffordBuyUsd(
  cfg: LiveOscarConfig,
  usdNotional: number,
  solUsd?: number,
): Promise<LiveWalletAffordability> {
  const px = solUsd ?? getSolUsd() ?? 0;
  const swap = estimateLamportsForBuyUsd(usdNotional, px);
  const required = requiredLamportsForBuyQuote(swap, cfg.liveFreeSolBufferLamports);
  return liveWalletCanAffordLamports(cfg, required);
}

/** Per discovery/heartbeat tick only — no cooldown after a failed buy. */
let tickDiscoveryTelegramSuppressed = false;

export function resetLiveBuyTelegramSuppressTick(): void {
  tickDiscoveryTelegramSuppressed = false;
}

export function isLiveBuyDiscoveryTelegramSuppressed(): boolean {
  return tickDiscoveryTelegramSuppressed;
}

export function liveDiscoveryTgSuppressOnInsufficientSolEnabled(): boolean {
  const s = process.env.LIVE_DISCOVERY_TG_SUPPRESS_ON_INSUFFICIENT_SOL?.trim();
  if (s === '0' || s === 'false') return false;
  return true;
}

/** Fresh wallet check each tick; does not block later buy attempts when SOL frees up. */
export async function refreshLiveBuyTelegramSuppressForTick(
  cfg: LiveOscarConfig,
  buyLegUsd: number,
): Promise<void> {
  tickDiscoveryTelegramSuppressed = false;
  if (!liveDiscoveryTgSuppressOnInsufficientSolEnabled()) return;
  if (cfg.executionMode !== 'live') return;
  const r = await liveWalletCanAffordBuyUsd(cfg, buyLegUsd);
  if (!r.ok) tickDiscoveryTelegramSuppressed = true;
}
