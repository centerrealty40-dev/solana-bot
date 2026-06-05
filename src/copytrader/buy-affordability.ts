import type { CopyTraderConfig } from './config.js';
import { copyTraderLiveOscarBridge } from './live-bridge.js';
import {
  liveWalletCanAffordBuyUsd,
  liveWalletCanAffordLamports,
  requiredLamportsForBuyQuote,
  type LiveWalletAffordability,
} from '../live/wallet-buy-affordability.js';
import { getSolUsd } from '../papertrader/pricing.js';

export type BuySolScaleResult =
  | { ok: true; sizeUsd: number; scaled: boolean; lamports?: bigint; requiredLamports?: bigint }
  | { ok: false; reason: 'insufficient_wallet_sol' | 'wallet_balance_rpc'; lamports?: bigint; requiredLamports?: bigint };

/** Shrink buy notional when wallet SOL is below quote + fee buffer (linear estimate). */
export function scaleBuyUsdToWalletSol(args: {
  sizeUsd: number;
  lamports: bigint;
  requiredLamports: bigint;
  minUsd: number;
}): BuySolScaleResult {
  const { sizeUsd, lamports, requiredLamports, minUsd } = args;
  if (!(sizeUsd > 0)) return { ok: false, reason: 'insufficient_wallet_sol', lamports, requiredLamports };
  if (requiredLamports <= 0n) return { ok: true, sizeUsd, scaled: false, lamports, requiredLamports };
  if (lamports >= requiredLamports) {
    return { ok: true, sizeUsd, scaled: false, lamports, requiredLamports };
  }
  const ratio = Number(lamports) / Number(requiredLamports);
  const scaledUsd = Math.floor(sizeUsd * ratio * 0.98 * 100) / 100;
  if (!(scaledUsd >= minUsd)) {
    return { ok: false, reason: 'insufficient_wallet_sol', lamports, requiredLamports };
  }
  return { ok: true, sizeUsd: scaledUsd, scaled: true, lamports, requiredLamports };
}

function minExecutableBuyUsd(cfg: CopyTraderConfig, kind: 'entry' | 'add', requestedUsd: number): number {
  if (kind === 'add') return cfg.minProportionalAddUsd;
  return Math.min(requestedUsd, Math.max(cfg.minLeaderBuyUsd, 10));
}

export async function resolveCopyBuySizeUsd(args: {
  cfg: CopyTraderConfig;
  kind: 'entry' | 'add';
  sizeUsd: number;
}): Promise<BuySolScaleResult> {
  const { cfg, kind, sizeUsd } = args;
  if (cfg.executionMode !== 'live') return { ok: true, sizeUsd, scaled: false };

  const liveCfg = copyTraderLiveOscarBridge(cfg);
  const afford = await liveWalletCanAffordBuyUsd(liveCfg, sizeUsd, getSolUsd());
  if (afford.ok) return { ok: true, sizeUsd, scaled: false, lamports: afford.lamports, requiredLamports: afford.requiredLamports };

  if (afford.reason !== 'insufficient_wallet_sol' || afford.lamports == null || afford.requiredLamports == null) {
    return { ok: false, reason: afford.reason ?? 'wallet_balance_rpc', lamports: afford.lamports, requiredLamports: afford.requiredLamports };
  }

  return scaleBuyUsdToWalletSol({
    sizeUsd,
    lamports: afford.lamports,
    requiredLamports: afford.requiredLamports,
    minUsd: minExecutableBuyUsd(cfg, kind, sizeUsd),
  });
}

export async function quoteAffordabilityForBuy(args: {
  cfg: CopyTraderConfig;
  quoteInLamports: bigint;
}): Promise<LiveWalletAffordability> {
  const liveCfg = copyTraderLiveOscarBridge(args.cfg);
  const required = requiredLamportsForBuyQuote(args.quoteInLamports, liveCfg.liveFreeSolBufferLamports);
  return liveWalletCanAffordLamports(liveCfg, required);
}
