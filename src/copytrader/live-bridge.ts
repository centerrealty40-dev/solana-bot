import type { CopyTraderConfig } from './config.js';
import type { LiveOscarConfig } from '../live/config.js';
import { liveOscarRpcHttpUrlFromEnv } from '../core/rpc/resolve-solana-rpc-url.js';

function readBoundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const s = process.env[name]?.trim();
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readJupiterPriorityMaxLamports(): number | undefined {
  const sol = process.env.LIVE_JUPITER_PRIORITY_MAX_SOL?.trim();
  if (sol) {
    const n = Number(sol);
    if (Number.isFinite(n) && n > 0) {
      const lam = Math.round(n * 1e9);
      if (lam >= 1 && lam <= 50_000_000) return lam;
    }
  }
  const lamEnv = process.env.LIVE_JUPITER_PRIORITY_MAX_LAMPORTS?.trim();
  if (!lamEnv) return undefined;
  const n = Number.parseInt(lamEnv, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(n, 50_000_000);
}

function readJupiterSwapPriorityLevel(): 'medium' | 'high' | 'veryHigh' {
  const s = (process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL ?? 'veryHigh').trim().toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'veryhigh' || s === 'very_high') return 'veryHigh';
  return 'medium';
}

/** Minimal LiveOscarConfig surface for Jupiter + send pipeline (copy-trader only). */
export function copyTraderLiveOscarBridge(cfg: CopyTraderConfig): LiveOscarConfig {
  const rpc = cfg.rpcUrl.trim() || liveOscarRpcHttpUrlFromEnv() || '';
  const quoteUrl =
    process.env.LIVE_JUPITER_QUOTE_URL?.trim() ||
    process.env.JUPITER_QUOTE_API_URL?.trim() ||
    undefined;
  const swapUrl = process.env.LIVE_JUPITER_SWAP_URL?.trim() || undefined;
  return {
    strategyEnabled: true,
    executionMode: 'live',
    profile: 'oscar',
    liveTradesPath: cfg.journalPath,
    strategyId: 'copy-trader',
    heartbeatIntervalMs: 1_800_000,
    walletSecret: cfg.walletSecret,
    liveWalletPubkeyExpected: cfg.walletPubkeyExpected,
    liveJupiterQuoteUrl: quoteUrl,
    liveJupiterSwapUrl: swapUrl,
    liveJupiterQuoteTimeoutMs: 8000,
    liveJupiterSwapTimeoutMs: 12_000,
    liveDefaultSlippageBps: cfg.slippageBps,
    liveSimEnabled: true,
    liveSimTimeoutMs: 12_000,
    liveSimCreditsPerCall: 30,
    liveSimReplaceRecentBlockhash: true,
    liveSimSigVerify: false,
    liveSimBeforeSend: true,
    liveRpcHttpUrl: rpc,
    liveSendCreditsPerCall: 10,
    liveSendRpcTimeoutMs: 20_000,
    liveSendMaxRetries: 2,
    liveSendRetryBaseMs: 400,
    liveConfirmTimeoutMs: 45_000,
    liveConfirmCommitment: 'confirmed',
    liveJupiterPriorityMaxLamports: readJupiterPriorityMaxLamports(),
    liveJupiterSwapPriorityLevel: readJupiterSwapPriorityLevel(),
    liveSellSimRetryAttempts: readBoundedIntEnv('LIVE_SELL_SIM_RETRY_ATTEMPTS', 10, 0, 15),
    liveSellSimRetryDelayMs: readBoundedIntEnv('LIVE_SELL_SIM_RETRY_DELAY_MS', 3000, 250, 30_000),
    liveSellSimSlippageRetryAttempts: readBoundedIntEnv('LIVE_SELL_SIM_SLIPPAGE_RETRY_ATTEMPTS', 5, 0, 15),
    liveSimSlippageRetryBumpBps: readBoundedIntEnv('LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS', 50, 0, 500),
    liveSimSlippageRetryMaxBps: readBoundedIntEnv('LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS', 300, 10, 5000),
  } as LiveOscarConfig;
}
