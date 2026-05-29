import type { CopyTraderConfig } from './config.js';
import type { LiveOscarConfig } from '../live/config.js';
import { liveOscarRpcHttpUrlFromEnv } from '../core/rpc/resolve-solana-rpc-url.js';

/** Minimal LiveOscarConfig surface for Jupiter + send pipeline (copy-trader only). */
export function copyTraderLiveOscarBridge(cfg: CopyTraderConfig): LiveOscarConfig {
  const rpc = cfg.rpcUrl.trim() || liveOscarRpcHttpUrlFromEnv() || '';
  return {
    strategyEnabled: true,
    executionMode: 'live',
    profile: 'oscar',
    liveTradesPath: cfg.journalPath,
    strategyId: 'copy-trader',
    heartbeatIntervalMs: 1_800_000,
    walletSecret: cfg.walletSecret,
    liveWalletPubkeyExpected: cfg.walletPubkeyExpected,
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
    liveJupiterSwapPriorityLevel: 'medium',
  } as LiveOscarConfig;
}
