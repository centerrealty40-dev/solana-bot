import type { Keypair } from '@solana/web3.js';
import { QUOTE_MINTS } from '../core/constants.js';
import { getSolUsd } from '../papertrader/pricing.js';
import {
  liveBuildUnsignedSwapTx,
  liveFetchBuyQuote,
  liveSellQuoteAndPrepareSnapshot,
} from '../live/jupiter.js';
import { rpcWalletSolLamports } from '../live/wallet-buy-affordability.js';
import { fetchLiveWalletSplBalancesByMint } from '../live/reconcile-live.js';
import { signLiveJupiterSwapBase64 } from '../live/simulate.js';
import { liveSendSignedSwapPipeline } from '../live/phase6-send.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import type { LiveOscarConfig } from '../live/config.js';
import { toComboExecutorConfig } from './config.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { comboLiveBridge } from '../pumpswap-combo/live-bridge.js';
import { appendFollowEvent } from './journal.js';
import { planTreasuryRebalance } from './treasury.js';

let cachedSigner: Keypair | null = null;
let lastRebalanceAtMs = 0;

function signer(cfg: PumpswapComboFollowConfig): Keypair {
  if (!cachedSigner) {
    const s = cfg.walletSecret?.trim();
    if (!s) throw new Error('wallet secret missing');
    cachedSigner = loadLiveKeypairFromSecretEnv(s);
  }
  return cachedSigner;
}

function liveCfg(cfg: PumpswapComboFollowConfig): LiveOscarConfig {
  return comboLiveBridge(toComboExecutorConfig(cfg));
}

async function readBalances(cfg: PumpswapComboFollowConfig): Promise<{
  solLamports: bigint;
  usdcMicro: bigint;
} | null> {
  const live = liveCfg(cfg);
  const solLamports = await rpcWalletSolLamports(live);
  if (solLamports == null) return null;
  const spl = await fetchLiveWalletSplBalancesByMint(live);
  const usdcMicro = spl?.get(QUOTE_MINTS.USDC) ?? 0n;
  return { solLamports, usdcMicro };
}

async function sendJupiterSwap(
  cfg: PumpswapComboFollowConfig,
  unsignedB64: string,
  meta: Record<string, unknown>,
): Promise<{ ok: boolean; signature?: string; reason?: string }> {
  const live = liveCfg(cfg);
  const signed = signLiveJupiterSwapBase64(unsignedB64, signer(cfg));
  const outcome = await liveSendSignedSwapPipeline({
    cfg: live,
    signedTxSerializedBase64: signed,
  });
  if (outcome.ok) {
    appendFollowEvent(cfg, {
      kind: 'treasury_rebalance_ok',
      ...meta,
      txSignature: outcome.signature,
    });
    return { ok: true, signature: outcome.signature };
  }
  appendFollowEvent(cfg, {
    kind: 'treasury_rebalance_fail',
    ...meta,
    reason: outcome.message,
    txSignature: outcome.signature ?? null,
  });
  return { ok: false, reason: outcome.message };
}

async function swapSolToUsdc(
  cfg: PumpswapComboFollowConfig,
  swapUsd: number,
): Promise<{ ok: boolean; reason?: string }> {
  const live = liveCfg(cfg);
  const solUsd = getSolUsd();
  if (!(solUsd > 0)) return { ok: false, reason: 'no_sol_usd' };
  const userPk = signer(cfg).publicKey.toBase58();
  const quote = await liveFetchBuyQuote({
    cfg: live,
    outputMint: QUOTE_MINTS.USDC,
    sizeUsd: swapUsd,
    solUsd,
  });
  if (!quote) return { ok: false, reason: 'jupiter_quote_failed' };
  const build = await liveBuildUnsignedSwapTx({
    cfg: live,
    quoteResponse: quote.quoteResponse,
    userPublicKey: userPk,
  });
  if (!build.ok) return { ok: false, reason: build.reason };
  const sent = await sendJupiterSwap(cfg, build.b64, {
    direction: 'sol_to_usdc',
    swapUsd,
    quoteSnapshot: quote.quoteSnapshot,
  });
  return sent;
}

async function swapUsdcToSol(
  cfg: PumpswapComboFollowConfig,
  swapUsd: number,
): Promise<{ ok: boolean; reason?: string }> {
  const live = liveCfg(cfg);
  const solUsd = getSolUsd();
  if (!(solUsd > 0)) return { ok: false, reason: 'no_sol_usd' };
  const userPk = signer(cfg).publicKey.toBase58();
  const amountRaw = String(Math.max(1, Math.floor(swapUsd * 1e6)));
  const prep = await liveSellQuoteAndPrepareSnapshot({
    cfg: live,
    inputMint: QUOTE_MINTS.USDC,
    tokenAmountRaw: amountRaw,
    solUsd,
    userPublicKey: userPk,
  });
  if (!prep) return { ok: false, reason: 'jupiter_quote_failed' };
  if (!prep.swapBuild.ok) return { ok: false, reason: prep.swapBuild.reason };
  const sent = await sendJupiterSwap(cfg, prep.swapBuild.b64, {
    direction: 'usdc_to_sol',
    swapUsd,
    quoteSnapshot: prep.quoteSnapshot,
  });
  return sent;
}

export type TreasuryRebalanceResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  plan?: ReturnType<typeof planTreasuryRebalance>;
};

/** Keep ~targetUsdcPct of liquid SOL+USDC in USDC via Jupiter (live only). */
export async function rebalanceFollowTreasuryIfNeeded(
  cfg: PumpswapComboFollowConfig,
  opts?: { force?: boolean; urgentUsdcUsd?: number },
): Promise<TreasuryRebalanceResult> {
  if (cfg.executionMode !== 'live') return { ok: true, skipped: true, reason: 'paper_mode' };

  const now = Date.now();
  const urgent = (opts?.urgentUsdcUsd ?? 0) > 0;
  if (!opts?.force && !urgent && now - lastRebalanceAtMs < cfg.treasuryRebalanceCooldownMs) {
    return { ok: true, skipped: true, reason: 'cooldown' };
  }

  const bal = await readBalances(cfg);
  if (!bal) return { ok: false, reason: 'balance_rpc_failed' };

  const solUsd = getSolUsd();
  if (!(solUsd > 0)) return { ok: false, reason: 'no_sol_usd' };

  let plan = planTreasuryRebalance({
    solLamports: bal.solLamports,
    usdcMicro: bal.usdcMicro,
    solUsd,
    targetUsdcPct: cfg.treasuryUsdcTargetPct,
    minFreeSolLamports: cfg.treasuryMinFreeSolLamports,
    minSwapUsd: cfg.treasuryRebalanceMinUsd,
    bandPct: cfg.treasuryRebalanceBandPct,
  });

  if (urgent) {
    const need = Math.max(0, (opts!.urgentUsdcUsd ?? 0) - plan.usdcUsd);
    if (need >= cfg.treasuryRebalanceMinUsd && plan.tradableSolLamports > 0n) {
      plan = {
        ...plan,
        action: 'buy_usdc',
        swapUsd: Math.max(plan.swapUsd, need),
      };
    }
  }

  if (plan.action === 'none') {
    appendFollowEvent(cfg, {
      kind: 'treasury_rebalance_skip',
      usdcPct: plan.usdcPct,
      targetUsdcPct: cfg.treasuryUsdcTargetPct,
      liquidTotalUsd: plan.liquidTotalUsd,
      usdcUsd: plan.usdcUsd,
      usdcDeltaUsd: plan.usdcDeltaUsd,
    });
    return { ok: true, skipped: true, reason: 'within_band', plan };
  }

  appendFollowEvent(cfg, {
    kind: 'treasury_rebalance_start',
    direction: plan.action,
    swapUsd: plan.swapUsd,
    usdcPct: plan.usdcPct,
    targetUsdcPct: cfg.treasuryUsdcTargetPct,
    liquidTotalUsd: plan.liquidTotalUsd,
    urgent: urgent || false,
  });

  const exec =
    plan.action === 'buy_usdc'
      ? await swapSolToUsdc(cfg, plan.swapUsd)
      : await swapUsdcToSol(cfg, plan.swapUsd);

  if (exec.ok) lastRebalanceAtMs = now;
  return exec.ok ? { ok: true, plan } : { ok: false, reason: exec.reason, plan };
}

/** Before a USDC-quoted PumpSwap buy — ensure wallet has leg + buffer USDC. */
export async function ensureFollowUsdcForBuy(
  cfg: PumpswapComboFollowConfig,
  legUsd: number,
): Promise<void> {
  if (cfg.executionMode !== 'live') return;
  const need = legUsd * 1.05;
  const bal = await readBalances(cfg);
  if (!bal) return;
  const usdcUsd = Number(bal.usdcMicro) / 1e6;
  if (usdcUsd >= need) return;
  await rebalanceFollowTreasuryIfNeeded(cfg, { force: true, urgentUsdcUsd: need });
}

/** Test helper */
export function resetFollowTreasuryRebalanceCooldownForTests(): void {
  lastRebalanceAtMs = 0;
  cachedSigner = null;
}
