/**
 * W8.0 Phase 4 — Oscar parity: gates stay in papertrader; execution → Jupiter + simulate + live JSONL.
 */
import type { Keypair } from '@solana/web3.js';
import {
  fetchJupiterTokenUsdPrice,
  fetchLatestSnapshotPrice,
  getSolUsd,
} from '../papertrader/pricing.js';
import {
  isBuyQuoteChasingAnchor,
  isQuotePriceImpactTooHigh,
  liveBuyQuoteAndPrepareSnapshot,
  liveQuoteExceedsMaxAge,
  liveSellQuoteAndPrepareSnapshot,
  tokensPerInLamportFromQuote,
} from './jupiter.js';
import { oscarWalletMintUsdExcludingCopyLeader } from './copy-leader-attribution.js';
import {
  defaultBuyOpenLegUsd,
  evaluateCopyToOscarPromotionPlan,
  finalizeCopyToOscarHandoff,
} from './copy-to-oscar-promotion.js';
import { cancelLivePostCloseTailSweepForMint } from './post-close-tail-sweep.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { liveSimulateSignedTransaction, signLiveJupiterSwapBase64 } from './simulate.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';
import { newLiveIntentId } from './intent.js';
import { sellPipelineWalletDrained } from './wallet-zero-policy.js';
import type { LiveOscarConfig } from './config.js';
import type {
  LiveBuyPipelineResult,
  LiveExitSliceSuccessHook,
  LiveOscarPhase4Discovery,
  LiveOscarPhase4Tracker,
  LiveOscarRuntimeBundle,
  LivePhase4BuyOpenContext,
  LiveTokenToSolPipelineResult,
} from './phase4-types.js';
import type { DexSource } from '../papertrader/types.js';
import {
  notifyLiveExecutionSimErr,
  notifyLiveExecutionSimErrForTerminal,
  notifyLiveExecutionSimOk,
} from './phase5-state.js';
import { liveSendSignedSwapPipeline, type LiveSendPipelineOutcome } from './phase6-send.js';
import { fetchConfirmedSwapSolProceedsLamports } from './swap-tx-sol-proceeds.js';
import {
  fetchLiveWalletSplBalancesByMint,
  invalidateLiveWalletSplBalanceCache,
} from './reconcile-live.js';
import {
  isInsufficientFundsSimError,
  liveWalletCanAffordBuyUsd,
  liveWalletCanAffordLamports,
  freshSolUsdForBuyGate,
  resolveBuyAffordRequiredLamports,
  resolvePartialBuyNotional,
} from './wallet-buy-affordability.js';
import {
  clearLiveBuyCooldown,
  isMintBlockedForAmbiguousLiveBuy,
  registerAmbiguousLiveBuyCooldown,
} from './pending-buy-cooldown.js';
import { isMintPermanentlyDeniedLiveOscar } from './mint-permanent-denylist.js';
import {
  isMintTimedLossCooldownActive,
  mintTimedLossCooldownRemainingMs,
} from './mint-timed-loss-cooldown.js';
import {
  isMintScratchReentryBlocked,
  mintScratchReentryRefPrice,
  mintScratchReentryThresholdPrice,
} from './mint-scratch-reentry.js';
import {
  appendPostExitReentryGateReasons,
  postExitReentryGateReasonsForLiveBuy,
} from '../papertrader/discovery/dip-clones.js';
import { postHealChurnGateReason } from './policy-only-exits.js';
import { waveBPostTp1ScratchReentryBypassGate } from '../papertrader/executor/wave-b-post-tp1-scratch-reentry.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import {
  isStagedAddCooldownActive,
  recordStagedAddOutcome,
  stagedAddCooldownRemainingMs,
  type StagedAddIntentKind,
} from './staged-add-sim-cooldown.js';
import { recordSendOutcome as recordPriorityFeeOutcome } from './adaptive-priority-fee.js';
import { runSlicedTokenToSolPipeline } from './exit-slice.js';
import { runSlicedSolToTokenPipeline } from './entry-slice.js';
import {
  clearArmedSellQuote,
  consumeArmedSellQuote,
} from './sell-quote-prearm.js';
import type { LiveBuyTerminalKind } from './phase4-types.js';
import {
  isPreSendSimFailureMessage,
  isRetryableBuySimError,
  isRetryablePreBroadcastError,
  isRetryableSellSimError,
} from './execution-retry-errors.js';
import {
  capPartialSellTokenRaw,
  liveSellQuotePriceSanity,
} from './sell-price-sanity.js';

export { isRetryableSellSimError } from './execution-retry-errors.js';

let cachedSigner: Keypair | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function signer(liveCfg: LiveOscarConfig): Keypair {
  if (!cachedSigner) {
    const s = liveCfg.walletSecret?.trim();
    if (!s) throw new Error('LIVE_WALLET_SECRET missing for Phase 4 simulate');
    cachedSigner = loadLiveKeypairFromSecretEnv(s);
  }
  return cachedSigner;
}

export function tokenAmountRawFromUsd(
  usdNotional: number,
  priceUsdPerToken: number,
  decimals: number,
): string | null {
  if (!(usdNotional > 0) || !(priceUsdPerToken > 0)) return null;
  const dec = Math.min(24, Math.max(0, Math.floor(decimals)));
  const tokens = usdNotional / priceUsdPerToken;
  const factor = 10 ** dec;
  const raw = BigInt(Math.max(1, Math.floor(tokens * factor)));
  return raw.toString();
}

function normalizeLiveSendOutcome(outcome: LiveSendPipelineOutcome): LiveSendPipelineOutcome {
  if (outcome.ok || outcome.kind === 'sim_err') return outcome;
  if (isPreSendSimFailureMessage(outcome.message)) {
    return { ...outcome, kind: 'sim_err' };
  }
  return outcome;
}

function finalizeLiveSendJsonl(intentId: string, outcome: LiveSendPipelineOutcome): boolean {
  const o = normalizeLiveSendOutcome(outcome);
  if (o.ok) {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'confirmed',
      txSignature: o.signature,
      simulated: false,
      unitsConsumed: o.preSimUnits,
      slot: o.slot,
    });
    notifyLiveExecutionSimOk();
    recordPriorityFeeOutcome({ kind: 'success' });
    return true;
  }
  if (o.kind === 'sim_err') {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      unitsConsumed: o.preSimUnits ?? null,
      error: { message: o.message },
    });
    notifyLiveExecutionSimErr();
    recordPriorityFeeOutcome({ kind: 'sim_err' });
    return false;
  }
  appendLiveJsonlEvent({
    kind: 'execution_result',
    intentId,
    status: 'failed',
    simulated: false,
    txSignature: o.signature ?? null,
    unitsConsumed: o.preSimUnits ?? null,
    error: { message: o.message },
  });
  /** `confirm_timeout` / `send_failed` are operational; do not trip consec-sim global gate (see phase5-state). */
  if (o.kind !== 'confirm_timeout') {
    notifyLiveExecutionSimErrForTerminal(o.message);
  }
  /** 1.11.231 — adaptive priority fee: учитываем confirm_timeout + send_failed для congestion sense. */
  if (o.kind === 'confirm_timeout') {
    recordPriorityFeeOutcome({ kind: 'confirm_timeout' });
  } else if (o.kind === 'send_failed') {
    recordPriorityFeeOutcome({ kind: 'send_failed' });
  }
  return false;
}

function pipelineAnchorMode(liveCfg: LiveOscarConfig): LiveBuyPipelineResult['anchorMode'] {
  return liveCfg.executionMode === 'simulate' ? 'simulate' : 'chain';
}

/**
 * 1.11.230 — «slippage class» sim_err.
 *
 * Сюда попадают ошибки, которые повторами с тем же slippageBps НЕ исправить:
 *   - `"Custom":1` в `InstructionError` (Jupiter swap-инструкция: маршрут вернул slippage/cl-pool error);
 *   - `6001` = Jupiter v6 `SlippageToleranceExceeded` — и в hex (`0x1771`), и в decimal
 *     (`{"InstructionError":[3,{"Custom":6001}]}`, как отдаёт `simulateTransaction`);
 *   - явный текст `Slippage` / `Slippage tolerance exceeded` (на случай альтернативного формата).
 *
 * Когда ловим такую — поднимаем slippageBps на следующий retry (adaptive bump для Jupiter Pro)
 * и кэпим число попыток отдельным env, чтобы не сжигать кредиты на одинаковых маршрутах.
 */
export function isSlippageClassSimError(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  /**
   * `slippage` matches Jupiter v6 «Slippage tolerance exceeded», `slippage_pool_full`,
   * любые сообщения, где явно упомянут slippage. Все наблюдаемые не-slippage коды
   * Jupiter (`InsufficientFunds*`, `AccountNotFound`, `confirm_timeout`,
   * `send_failed:429`) этого слова не содержат.
   */
  if (m.includes('slippage')) return true;
  if (m.includes('0x1771')) return true;
  if (m.includes('"custom":1}') || m.includes('"custom": 1}')) return true;
  /** Decimal form of 6001 as emitted by `simulateTransaction` / `sendTransaction` errors. */
  if (/"custom"\s*:\s*6001\b/.test(m)) return true;
  return false;
}

/** Один общий helper bump'а под cap. */
function nextSlippageBps(args: {
  cfg: LiveOscarConfig;
  currentBps: number;
  bump: number;
  attempt: number;
  maxBps?: number;
}): number {
  const cap = args.maxBps ?? args.cfg.liveSimSlippageRetryMaxBps;
  const wanted = args.currentBps + args.bump;
  return Math.min(cap, Math.max(args.currentBps, wanted));
}

/** Mem-swan / KILLSTOP: wider slippage ladder and faster retries during volatile dumps. */
function resolveEmergencySellRetryProfile(liveCfg: LiveOscarConfig): {
  sellMaxAttempts: number;
  sellRetryDelayMs: number;
  sellSlippageBumpBps: number;
  sellSlippageCap: number;
  sellCurrentSlippageBps: number;
  sellSlippageMaxBps: number;
} {
  return {
    sellMaxAttempts: 1 + Math.max(liveCfg.liveSellSimRetryAttempts, 20),
    sellRetryDelayMs: Math.min(liveCfg.liveSellSimRetryDelayMs, 100),
    sellSlippageBumpBps: Math.max(liveCfg.liveSimSlippageRetryBumpBps, 25),
    sellSlippageCap: 1 + Math.max(liveCfg.liveSellSimSlippageRetryAttempts, 12),
    sellCurrentSlippageBps: Math.max(liveCfg.liveDefaultSlippageBps, 150),
    sellSlippageMaxBps: Math.max(liveCfg.liveSimSlippageRetryMaxBps, 800),
  };
}

/** Терминальная классификация ошибки pipeline для surface'а наружу (cooldown / metrics). */
function terminalKindFromMessage(message: string): LiveBuyTerminalKind {
  if (!message) return 'other';
  if (message.startsWith('confirm_timeout')) return 'confirm_timeout';
  if (message.startsWith('send_failed') || message === 'send_failed_no_signature') return 'send_failed';
  if (message.startsWith('chain_err')) return 'chain_err';
  if (message.startsWith('quote_stale')) return 'quote_stale';
  if (message === 'no_quote') return 'no_quote';
  if (message.startsWith('swap_')) return 'swap_build';
  if (isInsufficientFundsSimError(message)) return 'insufficient_funds';
  if (message.startsWith('sim_failed:') || message.includes('InstructionError')) return 'sim_err';
  return 'other';
}

function sellTerminalKindFromLiveOut(kind: string | undefined): LiveTokenToSolPipelineResult['terminalKind'] {
  if (kind === 'sim_err' || kind === 'send_failed' || kind === 'confirm_timeout') return kind;
  return 'other';
}

/** Estimates gross USD value of `mint` on the live wallet (before copy-leader subtraction). */
async function estimateLiveWalletMintHoldingGrossUsd(args: {
  liveCfg: LiveOscarConfig;
  mint: string;
  tokenDecimals: number;
  dexSource?: string;
}): Promise<number | null> {
  const chain = await fetchLiveWalletSplBalancesByMint(args.liveCfg);
  if (!chain) return null;
  const raw = chain.get(args.mint) ?? 0n;
  if (raw === 0n) return 0;

  const dec = Math.min(24, Math.max(0, Math.floor(args.tokenDecimals)));
  const tokens = Number(raw) / 10 ** dec;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;

  const src = args.dexSource as DexSource | undefined;
  let px = await fetchLatestSnapshotPrice(
    args.mint,
    src && ['raydium', 'meteora', 'orca', 'moonshot', 'pumpswap'].includes(src)
      ? (src as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap')
      : undefined,
  );
  if (px == null || !(px > 0)) {
    px = await fetchJupiterTokenUsdPrice(args.mint);
  }
  if (px == null || !(px > 0)) return null;
  return tokens * px;
}

/** Estimates USD value of `mint` already on the live wallet (null = could not estimate — caller should not block). */
async function estimateLiveWalletMintHoldingUsd(args: {
  liveCfg: LiveOscarConfig;
  mint: string;
  tokenDecimals: number;
  dexSource?: string;
}): Promise<number | null> {
  const gross = await estimateLiveWalletMintHoldingGrossUsd(args);
  if (gross == null) return null;
  return oscarWalletMintUsdExcludingCopyLeader({ walletMintUsd: gross, mint: args.mint });
}

export { estimateLiveWalletMintHoldingGrossUsd };

async function runSolToTokenPipeline(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    intentKind: 'buy_open' | 'dca_add' | 'buy_scale_in';
  },
): Promise<LiveBuyPipelineResult> {
  const mode = pipelineAnchorMode(liveCfg);
  const intentKindForCooldown: StagedAddIntentKind = args.intentKind;
  /** Локальный helper-обёртка: запись в cooldown + сборка стандартного `LiveBuyPipelineResult`. */
  const failure = (
    cooldownKind: 'sim_err' | 'other',
    terminalKind: LiveBuyTerminalKind,
    message: string,
  ): LiveBuyPipelineResult => {
    recordStagedAddOutcome({
      mint: args.mint,
      intentKind: intentKindForCooldown,
      kind: cooldownKind,
      terminalMessage: message,
    });
    return {
      ok: false,
      anchorMode: mode,
      terminalKind,
      terminalMessage: message.slice(0, 200),
    };
  };
  const success = (result: LiveBuyPipelineResult): LiveBuyPipelineResult => {
    recordStagedAddOutcome({
      mint: args.mint,
      intentKind: intentKindForCooldown,
      kind: 'success',
    });
    return result;
  };

  if (!liveCfg.strategyEnabled) return { ok: false, anchorMode: mode, terminalKind: 'gate' };
  if (liveCfg.executionMode === 'dry_run') {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `dry_run:${args.intentKind}`,
      detail: args.mint.slice(0, 8),
    });
    return { ok: false, anchorMode: mode, terminalKind: 'gate', terminalMessage: 'dry_run' };
  }
  if (liveCfg.executionMode !== 'simulate' && liveCfg.executionMode !== 'live') {
    return { ok: false, anchorMode: mode, terminalKind: 'gate' };
  }

  if (
    (liveCfg.executionMode === 'live' || liveCfg.executionMode === 'simulate') &&
    isMintPermanentlyDeniedLiveOscar(liveCfg, args.mint)
  ) {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `live_permanent_deny:${args.intentKind}`,
      detail: args.mint.slice(0, 12),
    });
    return {
      ok: false,
      anchorMode: mode,
      terminalKind: 'gate',
      terminalMessage: 'live_permanent_deny',
    };
  }

  if (
    (liveCfg.executionMode === 'live' || liveCfg.executionMode === 'simulate') &&
    (args.intentKind === 'buy_open' || args.intentKind === 'dca_add' || args.intentKind === 'buy_scale_in') &&
    isMintTimedLossCooldownActive(liveCfg, args.mint)
  ) {
    const remaining = mintTimedLossCooldownRemainingMs(args.mint);
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `live_mint_timed_loss_cooldown:${args.intentKind}`,
      detail: JSON.stringify({
        mint: args.mint.slice(0, 12),
        remainingMs: remaining,
      }).slice(0, 200),
    });
    return {
      ok: false,
      anchorMode: mode,
      terminalKind: 'gate',
      terminalMessage: `mint_timed_loss_cooldown:${Math.round(remaining / 1000)}s`,
    };
  }

  if (
    liveCfg.executionMode === 'live' &&
    (args.intentKind === 'buy_open' || args.intentKind === 'dca_add' || args.intentKind === 'buy_scale_in') &&
    isMintBlockedForAmbiguousLiveBuy(args.mint)
  ) {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `live_ambiguous_buy_cooldown:${args.intentKind}`,
      detail: args.mint.slice(0, 12),
    });
    return {
      ok: false,
      anchorMode: mode,
      terminalKind: 'gate',
      terminalMessage: 'live_ambiguous_buy_cooldown',
    };
  }

  /** 1.11.230 — Staged-add cooldown: блокируем повторный заход в pipeline, если для (mint,intentKind) накопилась серия sim_err. */
  if (isStagedAddCooldownActive({ mint: args.mint, intentKind: intentKindForCooldown })) {
    const remaining = stagedAddCooldownRemainingMs({
      mint: args.mint,
      intentKind: intentKindForCooldown,
    });
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `live_staged_add_cooldown:${args.intentKind}`,
      detail: JSON.stringify({
        mint: args.mint.slice(0, 12),
        remainingMs: remaining,
      }).slice(0, 200),
    });
    return {
      ok: false,
      anchorMode: mode,
      terminalKind: 'gate',
      terminalMessage: `staged_add_cooldown:${Math.round(remaining / 1000)}s`,
    };
  }

  if (
    liveCfg.executionMode === 'live' ||
    liveCfg.executionMode === 'simulate'
  ) {
    let gatePx = await fetchJupiterTokenUsdPrice(args.mint);
    if (gatePx == null || !(gatePx > 0)) {
      gatePx = await fetchLatestSnapshotPrice(args.mint);
    }
    if (gatePx != null && gatePx > 0 && !waveBPostTp1ScratchReentryBypassGate(args.mint)) {
      const reentryReasons = postExitReentryGateReasonsForLiveBuy(args.mint, gatePx);
      const healChurn = postHealChurnGateReason(args.mint, liveCfg);
      if (healChurn) reentryReasons.push(healChurn);
      if (reentryReasons.length > 0) {
        appendLiveJsonlEvent({
          kind: 'execution_skip',
          reason: 'post_exit_reentry_gate',
          detail: JSON.stringify({
            mint: args.mint.slice(0, 12),
            intentKind: args.intentKind,
            candidatePriceUsd: gatePx,
            reasons: reentryReasons.slice(0, 3),
          }).slice(0, 500),
        });
        return {
          ok: false,
          anchorMode: mode,
          terminalKind: 'gate',
          terminalMessage: reentryReasons[0]!.slice(0, 200),
        };
      }
    }
  }

  if (liveCfg.executionMode === 'live') {
    cancelLivePostCloseTailSweepForMint(args.mint);
  }

  const kp = signer(liveCfg);
  const pk = kp.publicKey.toBase58();
  const maxAttempts = 1 + liveCfg.liveBuySimRetryAttempts;
  const slippageBumpBps = liveCfg.liveSimSlippageRetryBumpBps;
  const slippageCap = 1 + liveCfg.liveBuySimSlippageRetryAttempts;
  let slippageClassAttempts = 0;
  let currentSlippageBps = liveCfg.liveDefaultSlippageBps;
  /**
   * 1.11.234 — Anti-chase anchor: фиксируем `tokensPerLamport` первого валидного
   * quote в этом pipeline-вызове. Если на последующих retry'ях quote ушёл по
   * цене вверх (tokensPerLamport упал) больше чем на `liveBuyMaxChasePct` % —
   * abort. Не догоняем уже разогнанную цену.
   */
  let anchorTokensPerLamport: number | null = null;
  /** May shrink below `args.usdNotional` when wallet SOL is short (1.11.506). */
  let effectiveNotional = args.usdNotional;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const freshSol = await freshSolUsdForBuyGate(liveCfg);
    if (freshSol.stale || !(freshSol.price > 0)) {
      appendLiveJsonlEvent({
        kind: 'execution_skip',
        reason: 'buy_sol_usd_stale',
        detail: JSON.stringify({
          mint: args.mint.slice(0, 12),
          solUsdAgeMs: freshSol.ageMs,
          maxAgeMs: liveCfg.liveSolUsdMaxAgeMs,
        }).slice(0, 500),
      });
      if (attempt < maxAttempts - 1) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
      return failure('other', 'other', 'buy_sol_usd_stale');
    }
    const solUsd = freshSol.price;

    /**
     * Pre-quote afford gate. The authoritative check below uses Jupiter `inAmount`, but running it
     * only after the quote means every unaffordable buy still pays for a quote plus a swap build.
     * A cheap `getBalance` against the SOL/USD estimate skips those before we spend the call.
     * Only a definitive `insufficient_wallet_sol` short-circuits — an RPC failure falls through
     * to the post-quote gate rather than blocking trading.
     */
    if (liveCfg.executionMode === 'live') {
      const preAfford = await liveWalletCanAffordBuyUsd(liveCfg, effectiveNotional, solUsd);
      if (!preAfford.ok && preAfford.reason === 'insufficient_wallet_sol' && preAfford.lamports != null) {
        const partial =
          liveCfg.livePartialBuyMinUsd > 0
            ? resolvePartialBuyNotional({
                plannedUsd: effectiveNotional,
                walletLamports: preAfford.lamports,
                bufferLamports: liveCfg.liveFreeSolBufferLamports,
                solUsd,
                minUsd: liveCfg.livePartialBuyMinUsd,
              })
            : null;
        if (partial?.ok) {
          appendLiveJsonlEvent({
            kind: 'partial_slice_due_to_wallet',
            mint: args.mint,
            intentKind: args.intentKind,
            plannedUsd: args.usdNotional,
            priorEffectiveUsd: effectiveNotional,
            partialUsd: partial.usdNotional,
            maxAffordableUsd: partial.maxAffordableUsd,
            walletLamports: String(preAfford.lamports),
            bufferLamports: liveCfg.liveFreeSolBufferLamports,
            solUsdUsed: solUsd,
            preQuote: true,
          });
          effectiveNotional = partial.usdNotional;
          continue;
        }
        appendLiveJsonlEvent({
          kind: 'execution_skip',
          reason: 'insufficient_wallet_sol_for_buy',
          detail: JSON.stringify({
            mint: args.mint.slice(0, 12),
            lamports: String(preAfford.lamports),
            requiredLamports:
              preAfford.requiredLamports != null ? String(preAfford.requiredLamports) : null,
            intendedUsd: effectiveNotional,
            plannedUsd: args.usdNotional,
            maxAffordableUsd: partial?.maxAffordableUsd ?? null,
            solUsdUsed: solUsd,
            affordSource: 'pre_quote_estimate',
          }).slice(0, 500),
        });
        return failure('other', 'insufficient_funds', 'insufficient_wallet_sol_for_buy');
      }
    }

    const intentId = newLiveIntentId();
    const prep = await liveBuyQuoteAndPrepareSnapshot({
      cfg: liveCfg,
      outputMint: args.mint,
      sizeUsd: effectiveNotional,
      solUsd,
      userPublicKey: pk,
      slippageBpsOverride: currentSlippageBps,
    });

    const quoteSnapshot = {
      ...(prep?.quoteSnapshot ?? { provider: 'jupiter', empty: true }),
      buySimRetryAttempt: attempt,
      buySimRetryMaxAttempts: maxAttempts,
    };

    appendLiveJsonlEvent({
      kind: 'execution_attempt',
      intentId,
      side: 'buy',
      mint: args.mint,
      intendedUsd: effectiveNotional,
      plannedUsd: args.usdNotional,
      executionMode: liveCfg.executionMode,
      quoteSnapshot,
      targetPriceUsd: null,
    });

    if (!prep || !prep.swapBuild.ok) {
      const reason =
        prep == null ? 'no_quote' : prep.swapBuild.ok === false ? prep.swapBuild.reason : 'swap_build';
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        error: { message: reason },
        slippageBps: currentSlippageBps,
      });
      notifyLiveExecutionSimErrForTerminal(reason);
      if (attempt < maxAttempts - 1 && isRetryablePreBroadcastError(reason)) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
      const tk = reason === 'no_quote' ? 'no_quote' : 'swap_build';
      return failure('other', tk, reason);
    }

    if (liveCfg.executionMode === 'live') {
      const quoteInRaw = (prep.quoteSnapshot as Record<string, unknown> | undefined)?.quoteInAmount;
      if (typeof quoteInRaw === 'string' && /^\d+$/.test(quoteInRaw)) {
        const quoteInLamports = BigInt(quoteInRaw);
        const resolved = resolveBuyAffordRequiredLamports({
          intendedUsd: effectiveNotional,
          solUsd,
          quoteInLamports,
          bufferLamports: liveCfg.liveFreeSolBufferLamports,
        });
        if (!resolved.sane) {
          appendLiveJsonlEvent({
            kind: 'execution_skip',
            reason: 'buy_quote_sol_usd_drift',
            detail: JSON.stringify({
              mint: args.mint.slice(0, 12),
              intendedUsd: effectiveNotional,
              solUsdUsed: solUsd,
              solUsdAgeMs: freshSol.ageMs,
              driftPct: resolved.driftPct,
              quoteInLamports: String(quoteInLamports),
              estimateLamports: String(resolved.estimateLamports),
              affordableBaseLamports: String(resolved.affordableBaseLamports),
            }).slice(0, 500),
          });
        }
        const afford = await liveWalletCanAffordLamports(liveCfg, resolved.requiredLamports);
        if (!afford.ok) {
          const partial =
            afford.lamports != null && liveCfg.livePartialBuyMinUsd > 0
              ? resolvePartialBuyNotional({
                  plannedUsd: effectiveNotional,
                  walletLamports: afford.lamports,
                  bufferLamports: liveCfg.liveFreeSolBufferLamports,
                  solUsd,
                  minUsd: liveCfg.livePartialBuyMinUsd,
                })
              : null;
          if (partial?.ok) {
            appendLiveJsonlEvent({
              kind: 'partial_slice_due_to_wallet',
              mint: args.mint,
              intentKind: args.intentKind,
              plannedUsd: args.usdNotional,
              priorEffectiveUsd: effectiveNotional,
              partialUsd: partial.usdNotional,
              maxAffordableUsd: partial.maxAffordableUsd,
              walletLamports: String(afford.lamports),
              bufferLamports: liveCfg.liveFreeSolBufferLamports,
              solUsdUsed: solUsd,
            });
            effectiveNotional = partial.usdNotional;
            continue;
          }
          appendLiveJsonlEvent({
            kind: 'execution_skip',
            reason: 'insufficient_wallet_sol_for_buy',
            detail: JSON.stringify({
              mint: args.mint.slice(0, 12),
              lamports: afford.lamports != null ? String(afford.lamports) : null,
              requiredLamports: String(resolved.requiredLamports),
              intendedUsd: effectiveNotional,
              plannedUsd: args.usdNotional,
              maxAffordableUsd: partial?.maxAffordableUsd ?? null,
              solUsdUsed: solUsd,
              affordSource: resolved.source,
              affordableBaseLamports: String(resolved.affordableBaseLamports),
              quoteInLamports: String(quoteInLamports),
              estimateLamports: String(resolved.estimateLamports),
              driftPct: resolved.driftPct,
            }).slice(0, 500),
          });
          return failure('other', 'insufficient_funds', 'insufficient_wallet_sol_for_buy');
        }
      }
    }

    const snapForAge = (prep.quoteSnapshot ?? {}) as Record<string, unknown>;
    if (liveQuoteExceedsMaxAge(snapForAge, liveCfg.liveQuoteMaxAgeMs)) {
      const age = snapForAge.quoteAgeMs;
      const max = liveCfg.liveQuoteMaxAgeMs;
      const staleMsg =
        typeof age === 'number' && Number.isFinite(age) && max != null
          ? `quote_stale:${Math.round(age)}ms>${max}ms`
          : 'quote_stale:bad_or_missing_quoteAgeMs';
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        error: { message: staleMsg },
      });
      notifyLiveExecutionSimErrForTerminal(staleMsg);
      if (attempt < maxAttempts - 1 && isRetryablePreBroadcastError(staleMsg)) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
      return failure('other', 'quote_stale', staleMsg);
    }

    /**
     * 1.11.231 — pre-check Jupiter `priceImpactPct` before simulate.
     * Если impact > порога, не идём в simulate (сэкономили QN credits + Jupiter sim time).
     * Terminal `route_too_impactful` — не retry'ится: на следующем tick'е quote свежий и его пере-проверим.
     */
    const impactCheck = isQuotePriceImpactTooHigh(prep.quoteResponse, liveCfg.liveBuyMaxPriceImpactPct);
    if (impactCheck.blocked && impactCheck.pct != null) {
      const message = `route_too_impactful:buy:${impactCheck.pct.toFixed(2)}%>${liveCfg.liveBuyMaxPriceImpactPct}%`;
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        error: { message },
        slippageBps: currentSlippageBps,
      });
      notifyLiveExecutionSimErrForTerminal(message);
      return failure('other', 'route_too_impactful', message);
    }

    /**
     * 1.11.234 — Anti-chase guard.
     * Считаем `tokensPerLamport` для текущего quote. Первый успешный quote этого
     * pipeline-вызова становится anchor'ом; на последующих retry'ях, если quote
     * ушёл по цене выше anchor больше чем на `liveBuyMaxChasePct` %, abort.
     * Это защита от ситуации «retry'или, пока цена ушла» (например, VIRL 22:23
     * 20-May-2026 — между signal'ами цена ушла на +7%; внутри pipeline догнать
     * её было нельзя без нарушения risk-budget).
     */
    const currentTokensPerLamport = tokensPerInLamportFromQuote(prep.quoteResponse);
    if (anchorTokensPerLamport == null && currentTokensPerLamport != null) {
      anchorTokensPerLamport = currentTokensPerLamport;
    } else if (
      anchorTokensPerLamport != null &&
      currentTokensPerLamport != null &&
      liveCfg.liveBuyMaxChasePct > 0
    ) {
      const chase = isBuyQuoteChasingAnchor({
        anchorTokensPerLamport,
        currentTokensPerLamport,
        maxChasePct: liveCfg.liveBuyMaxChasePct,
      });
      if (chase.chased && chase.chasePct != null) {
        const message = `chase_aborted:buy:${chase.chasePct.toFixed(2)}%>+${liveCfg.liveBuyMaxChasePct}%(attempt=${attempt})`;
        appendLiveJsonlEvent({
          kind: 'execution_result',
          intentId,
          status: 'sim_err',
          simulated: true,
          error: { message },
          slippageBps: currentSlippageBps,
        });
        notifyLiveExecutionSimErrForTerminal(message);
        return failure('other', 'chase_aborted', message);
      }
    }

    const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);

    if (liveCfg.executionMode === 'simulate') {
      let sim;
      try {
        sim = await liveSimulateSignedTransaction({
          cfg: liveCfg,
          signedTxSerializedBase64: signedB64,
        });
      } catch (err) {
        const message = `simulate_throw:${(err as Error).message}`.slice(0, 400);
        appendLiveJsonlEvent({
          kind: 'execution_result',
          intentId,
          status: 'sim_err',
          simulated: true,
          error: { message },
          slippageBps: currentSlippageBps,
        });
        notifyLiveExecutionSimErrForTerminal(message);
        if (attempt < maxAttempts - 1 && isRetryableBuySimError(message)) {
          await sleep(liveCfg.liveBuySimRetryDelayMs);
          continue;
        }
        return failure('sim_err', 'sim_err', message);
      }

      if (!sim.ok) {
        const message = sim.kind + (sim.message ? `:${sim.message.slice(0, 400)}` : '');
        appendLiveJsonlEvent({
          kind: 'execution_result',
          intentId,
          status: 'sim_err',
          simulated: true,
          unitsConsumed: sim.unitsConsumed ?? null,
          error: { message },
          slippageBps: currentSlippageBps,
        });
        notifyLiveExecutionSimErrForTerminal(message);
        const isSlippage = isSlippageClassSimError(message);
        if (isSlippage) {
          slippageClassAttempts += 1;
          currentSlippageBps = nextSlippageBps({
            cfg: liveCfg,
            currentBps: currentSlippageBps,
            bump: slippageBumpBps,
            attempt,
          });
        }
        const slippageBail = isSlippage && slippageClassAttempts >= slippageCap;
        if (
          !slippageBail &&
          attempt < maxAttempts - 1 &&
          isRetryableBuySimError(message)
        ) {
          await sleep(liveCfg.liveBuySimRetryDelayMs);
          continue;
        }
        return failure('sim_err', 'sim_err', message);
      }

      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_ok',
        simulated: true,
        unitsConsumed: sim.unitsConsumed ?? null,
      });
      notifyLiveExecutionSimOk();
      return success({ ok: true, anchorMode: 'simulate', executedUsdNotional: effectiveNotional });
    }

    const liveOut = await liveSendSignedSwapPipeline({
      cfg: liveCfg,
      signedTxSerializedBase64: signedB64,
    });
    const ok = finalizeLiveSendJsonl(intentId, liveOut);
    if (liveCfg.executionMode === 'live') {
      if (ok) {
        clearLiveBuyCooldown(args.mint);
        /** 1.11.231 — после успешного buy баланс кошелька изменился; инвалидируем cache. */
        invalidateLiveWalletSplBalanceCache();
      } else if (
        !liveOut.ok &&
        liveOut.signature &&
        liveOut.kind === 'confirm_timeout' &&
        (args.intentKind === 'buy_open' ||
          args.intentKind === 'dca_add' ||
          args.intentKind === 'buy_scale_in')
      ) {
        registerAmbiguousLiveBuyCooldown(args.mint);
      } else {
        clearLiveBuyCooldown(args.mint);
      }
    }
    if (ok && liveOut.signature) {
      return success({
        ok: true,
        anchorMode: 'chain',
        confirmedBuyTxSignature: liveOut.signature,
        executedUsdNotional: effectiveNotional,
      });
    }
    if (
      !ok &&
      !liveOut.ok &&
      (liveOut.kind === 'sim_err' || liveOut.kind === 'send_failed') &&
      isRetryableBuySimError(liveOut.message)
    ) {
      const isSlippage = isSlippageClassSimError(liveOut.message);
      if (isSlippage) {
        slippageClassAttempts += 1;
        currentSlippageBps = nextSlippageBps({
          cfg: liveCfg,
          currentBps: currentSlippageBps,
          bump: slippageBumpBps,
          attempt,
        });
      }
      const slippageBail = isSlippage && slippageClassAttempts >= slippageCap;
      if (!slippageBail && attempt < maxAttempts - 1) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
    }
    if (!liveOut.ok) {
      const tk = terminalKindFromMessage(liveOut.message);
      const cooldownKind = tk === 'sim_err' ? 'sim_err' : 'other';
      return failure(cooldownKind, tk, liveOut.message);
    }
    return failure('other', 'other', 'unknown_terminal');
  }

  return failure('other', 'other', 'retries_exhausted');
}

function resolveSellExecutionMode(liveCfg: LiveOscarConfig): LiveOscarConfig['executionMode'] {
  if (liveCfg.executionMode === 'simulate' && liveCfg.liveSimulateBuysOnly) return 'live';
  return liveCfg.executionMode;
}

function appendSellPreflightSkip(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    reason: string;
    detail: string;
    intentKind: 'sell_partial' | 'sell_full';
  },
): void {
  const intentId = newLiveIntentId();
  const executionMode = resolveSellExecutionMode(liveCfg);
  appendLiveJsonlEvent({
    kind: 'execution_attempt',
    intentId,
    side: 'sell',
    mint: args.mint,
    intendedUsd: 0,
    executionMode,
    quoteSnapshot: { preflight_skip: true, reason: args.reason, intentKind: args.intentKind },
    targetPriceUsd: null,
  });
  appendLiveJsonlEvent({
    kind: 'execution_skip',
    intentId,
    reason: args.reason,
    detail: args.detail,
  });
  appendLiveJsonlEvent({
    kind: 'execution_result',
    intentId,
    status: 'skipped',
    simulated: false,
    error: { message: args.reason },
  });
}

async function runTokenToSolPipeline(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    /** Prior observed / entry anchor — ghost-quote deviation gate (DdPrHY RCA). */
    referencePriceUsd?: number | null;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
    emergencyExit?: boolean;
  },
): Promise<LiveTokenToSolPipelineResult> {
  const executionMode = resolveSellExecutionMode(liveCfg);
  if (!liveCfg.strategyEnabled) return { ok: false };
  if (executionMode === 'dry_run') {
    appendSellPreflightSkip(liveCfg, {
      mint: args.mint,
      reason: `dry_run:${args.intentKind}`,
      detail: args.mint.slice(0, 8),
      intentKind: args.intentKind,
    });
    return { ok: false, preflightSkipReason: `dry_run:${args.intentKind}` };
  }
  if (executionMode !== 'simulate' && executionMode !== 'live') return { ok: false };

  if (!args.emergencyExit) {
    const quoteSanity = liveSellQuotePriceSanity({
      quotePriceUsd: args.priceUsdPerToken,
      referencePriceUsd: args.referencePriceUsd,
    });
    if (!quoteSanity.ok) {
      const reason =
        quoteSanity.reason === 'ghost_price_quote_rejected' &&
        Number.isFinite(quoteSanity.referencePriceUsd) &&
        quoteSanity.referencePriceUsd > 0
          ? 'ghost_price_quote_rejected'
          : 'sell_price_usd_insane';
      appendSellPreflightSkip(liveCfg, {
        mint: args.mint,
        reason,
        detail: JSON.stringify({
          mint: args.mint,
          intentKind: args.intentKind,
          priceUsdPerToken: args.priceUsdPerToken,
          referencePriceUsd: args.referencePriceUsd ?? null,
          deviationFrac: quoteSanity.deviationFrac,
        }).slice(0, 400),
        intentKind: args.intentKind,
      });
      return { ok: false, preflightSkipReason: reason };
    }
  }

  let raw = tokenAmountRawFromUsd(args.usdNotional, args.priceUsdPerToken, args.decimals);
  if (raw == null) {
    appendSellPreflightSkip(liveCfg, {
      mint: args.mint,
      reason: 'token_amount_raw',
      detail: args.mint.slice(0, 8),
      intentKind: args.intentKind,
    });
    return { ok: false, preflightSkipReason: 'token_amount_raw' };
  }

  let sellAmountSource: 'usd_math' | 'chain_full_balance' | 'usd_capped_by_chain' = 'usd_math';
  let chainAmtBeforeSell = 0n;
  if (executionMode === 'live') {
    const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
    if (chainMap == null) {
      appendSellPreflightSkip(liveCfg, {
        mint: args.mint,
        reason: 'spl_balance_rpc_null',
        detail: args.mint.slice(0, 8),
        intentKind: args.intentKind,
      });
      return { ok: false, preflightSkipReason: 'spl_balance_rpc_null' };
    }
    const chainAmt = chainMap.get(args.mint) ?? 0n;
    chainAmtBeforeSell = chainAmt;
    if (chainAmt === 0n) {
      appendSellPreflightSkip(liveCfg, {
        mint: args.mint,
        reason: 'wallet_spl_balance_zero',
        detail: JSON.stringify({ mint: args.mint, intentKind: args.intentKind }).slice(0, 400),
        intentKind: args.intentKind,
      });
      return { ok: false, preflightSkipReason: 'wallet_spl_balance_zero' };
    }
    const computedBn = BigInt(raw);
    if (computedBn === 0n) {
      appendSellPreflightSkip(liveCfg, {
        mint: args.mint,
        reason: 'sell_amount_zero',
        detail: args.mint.slice(0, 8),
        intentKind: args.intentKind,
      });
      return { ok: false, preflightSkipReason: 'sell_amount_zero' };
    }
    if (args.intentKind === 'sell_full') {
      raw = chainAmt.toString();
      sellAmountSource = 'chain_full_balance';
    } else {
      const partialCap = capPartialSellTokenRaw({
        intentKind: args.intentKind,
        computedRaw: computedBn,
        chainAmt,
      });
      const chainCapped = partialCap.raw < chainAmt ? partialCap.raw : chainAmt;
      raw = chainCapped.toString();
      if (partialCap.cappedByPartialMax) {
        sellAmountSource = 'usd_capped_by_chain';
      } else {
        sellAmountSource = computedBn > chainAmt ? 'usd_capped_by_chain' : 'usd_math';
      }
    }
  }

  const kp = signer(liveCfg);
  const pk = kp.publicKey.toBase58();
  const emergency = args.emergencyExit === true;
  const emergencyProfile = emergency ? resolveEmergencySellRetryProfile(liveCfg) : null;
  const sellMaxAttempts = emergencyProfile?.sellMaxAttempts ?? 1 + liveCfg.liveSellSimRetryAttempts;
  const sellRetryDelayMs = emergencyProfile?.sellRetryDelayMs ?? liveCfg.liveSellSimRetryDelayMs;
  const sellSlippageBumpBps = emergencyProfile?.sellSlippageBumpBps ?? liveCfg.liveSimSlippageRetryBumpBps;
  const sellSlippageCap = emergencyProfile?.sellSlippageCap ?? 1 + liveCfg.liveSellSimSlippageRetryAttempts;
  const sellSlippageMaxBps = emergencyProfile?.sellSlippageMaxBps ?? liveCfg.liveSimSlippageRetryMaxBps;
  let sellSlippageClassAttempts = 0;
  let sellCurrentSlippageBps = emergencyProfile?.sellCurrentSlippageBps ?? liveCfg.liveDefaultSlippageBps;

  /**
   * Persistent retry envelope for sell pipeline (1.11.167):
   * Wraps fresh Jupiter quote + swap build + simulate + send for each attempt.
   * Retries on transient pre-broadcast failures only — never on `confirm_timeout`
   * (already-broadcast tx; retry would risk double-sell). Each attempt emits its
   * own `execution_attempt`/`execution_result` pair so the JSONL keeps full audit
   * of how many tries it took to push through tightened slippage (`isRetryableSellSimError`).
   *
   * 1.11.230 — на slippage-class sim_err bump'аем slippageBps на следующий retry
   * (под Jupiter Pro) и кэпим число slippage-ретраев отдельно от общих.
   */
  let lastResult: LiveTokenToSolPipelineResult = { ok: false };
  for (let attempt = 0; attempt < sellMaxAttempts; attempt++) {
    const solUsd = getSolUsd() ?? 0;
    const intentId = newLiveIntentId();
    /**
     * 1.11.231 — попытка использовать pre-armed sell quote (TP-ladder accelerator).
     * Только на первом attempt (на retry'ях fresh quote всегда нужен).
     */
    let prep: Awaited<ReturnType<typeof liveSellQuoteAndPrepareSnapshot>> | null = null;
    let usedPrearmed = false;
    if (attempt === 0) {
      const armed = consumeArmedSellQuote({
        mint: args.mint,
        intentKind: args.intentKind,
        tokenAmountRaw: raw,
      });
      if (armed) {
        prep = {
          quoteResponse: armed.quoteResponse,
          quoteSnapshot: { ...armed.quoteSnapshot, prearmed: true },
          swapBuild: { ok: true, b64: armed.swapBuildB64 },
        };
        usedPrearmed = true;
      }
    }
    if (!prep) {
      prep = await liveSellQuoteAndPrepareSnapshot({
        cfg: liveCfg,
        inputMint: args.mint,
        tokenAmountRaw: raw,
        solUsd,
        userPublicKey: pk,
        slippageBpsOverride: sellCurrentSlippageBps,
      });
    }
    void usedPrearmed; /** 1.11.231 — для diagnostic only, лог уже в `consumeArmedSellQuote`. */

    const quoteSnapshot = {
      ...(prep?.quoteSnapshot ?? { provider: 'jupiter', empty: true }),
      sellSimRetryAttempt: attempt,
      sellSimRetryMaxAttempts: sellMaxAttempts,
      ...(emergency ? { emergencyExit: true, slippageBps: sellCurrentSlippageBps } : {}),
    };

    appendLiveJsonlEvent({
      kind: 'execution_attempt',
      intentId,
      side: 'sell',
      mint: args.mint,
      intendedUsd: args.usdNotional,
      intendedAmountAtomic: raw,
      sellAmountSource,
      executionMode: executionMode,
      quoteSnapshot,
      targetPriceUsd: args.priceUsdPerToken,
    });

    if (!prep || !prep.swapBuild.ok) {
      const reason =
        prep == null ? 'no_quote' : prep.swapBuild.ok === false ? prep.swapBuild.reason : 'swap_build';
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        error: { message: reason },
      });
      notifyLiveExecutionSimErrForTerminal(reason);
      if (attempt < sellMaxAttempts - 1 && isRetryablePreBroadcastError(reason)) {
        await sleep(sellRetryDelayMs);
        continue;
      }
      return { ok: false, terminalKind: 'sim_err', terminalMessage: reason };
    }

    const snapForAgeSell = (prep.quoteSnapshot ?? {}) as Record<string, unknown>;
    if (liveQuoteExceedsMaxAge(snapForAgeSell, liveCfg.liveQuoteMaxAgeMs)) {
      const age = snapForAgeSell.quoteAgeMs;
      const max = liveCfg.liveQuoteMaxAgeMs;
      const staleMsg =
        typeof age === 'number' && Number.isFinite(age) && max != null
          ? `quote_stale:${Math.round(age)}ms>${max}ms`
          : 'quote_stale:bad_or_missing_quoteAgeMs';
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        error: { message: staleMsg },
      });
      notifyLiveExecutionSimErrForTerminal(staleMsg);
      if (attempt < sellMaxAttempts - 1) {
        await sleep(sellRetryDelayMs);
        continue;
      }
      return { ok: false, terminalKind: 'sim_err', terminalMessage: staleMsg };
    }

    /**
     * 1.11.231 — sell-side price-impact pre-check. По дефолту off (0%), для exits важнее
     * протолкнуть сделку даже при глубоком impact. Включать осторожно и со sigma >2%.
     */
    const sellImpactCheck = isQuotePriceImpactTooHigh(
      prep.quoteResponse,
      liveCfg.liveSellMaxPriceImpactPct,
    );
    if (sellImpactCheck.blocked && sellImpactCheck.pct != null) {
      const message = `route_too_impactful:sell:${sellImpactCheck.pct.toFixed(2)}%>${liveCfg.liveSellMaxPriceImpactPct}%`;
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        error: { message },
        slippageBps: sellCurrentSlippageBps,
      });
      notifyLiveExecutionSimErrForTerminal(message);
      if (attempt < sellMaxAttempts - 1) {
        await sleep(sellRetryDelayMs);
        continue;
      }
      return { ok: false, terminalKind: 'sim_err', terminalMessage: message };
    }

    const wsolOut = wsolOutLamportsFromSellQuote(prep.quoteResponse);
    /**
     * 1.11.168: pull priceImpactPct from Jupiter quote response — Jupiter returns
     * it as a string fraction (e.g. "0.029" = 2.9% pool depth eaten), independent
     * of `slippageBps`. Surfaced through pipeline so tracker can attach it to
     * `partialSells[].priceImpactPct` for retro leakage analytics.
     */
    const qResp = prep.quoteResponse as Record<string, unknown> | undefined;
    const priceImpactPctRaw = qResp?.priceImpactPct;
    const priceImpactPct =
      priceImpactPctRaw == null
        ? undefined
        : (() => {
            const n = Number(priceImpactPctRaw);
            return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
          })();
    const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);

    if (executionMode === 'simulate') {
      const sim = await liveSimulateSignedTransaction({
        cfg: liveCfg,
        signedTxSerializedBase64: signedB64,
      });

      if (!sim.ok) {
        const message = sim.kind + (sim.message ? `:${sim.message.slice(0, 400)}` : '');
        appendLiveJsonlEvent({
          kind: 'execution_result',
          intentId,
          status: 'sim_err',
          simulated: true,
          unitsConsumed: sim.unitsConsumed ?? null,
          error: { message },
          slippageBps: sellCurrentSlippageBps,
        });
        notifyLiveExecutionSimErrForTerminal(message);
        const isSlippage = isSlippageClassSimError(message);
        if (isSlippage) {
          sellSlippageClassAttempts += 1;
          sellCurrentSlippageBps = nextSlippageBps({
            cfg: liveCfg,
            currentBps: sellCurrentSlippageBps,
            bump: sellSlippageBumpBps,
            attempt,
            maxBps: sellSlippageMaxBps,
          });
        }
        const slippageBail = isSlippage && sellSlippageClassAttempts >= sellSlippageCap;
        if (
          !slippageBail &&
          attempt < sellMaxAttempts - 1 &&
          isRetryableSellSimError(message)
        ) {
          await sleep(sellRetryDelayMs);
          continue;
        }
        return { ok: false, terminalKind: 'sim_err', terminalMessage: message };
      }

      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_ok',
        simulated: true,
        unitsConsumed: sim.unitsConsumed ?? null,
      });
      notifyLiveExecutionSimOk();
      return {
        ok: true,
        wsolOutLamports: wsolOut ?? undefined,
        solProceedsSource: wsolOut != null && wsolOut > 0n ? 'jupiter_quote' : undefined,
        priceImpactPct,
        retryAttempts: attempt,
        sellAmountSource,
        walletDrained: sellPipelineWalletDrained(args.intentKind, BigInt(raw), chainAmtBeforeSell),
        tokenAmountRawSold: raw,
      };
    }

    const liveOut = await liveSendSignedSwapPipeline({
      cfg: liveCfg,
      signedTxSerializedBase64: signedB64,
    });
    const ok = finalizeLiveSendJsonl(intentId, liveOut);
    if (executionMode === 'live' && ok) {
      clearLiveBuyCooldown(args.mint);
    }

    /**
     * Sell broadcast outcome:
     *  - `ok=true` → confirmed swap, return; do not retry.
     *  - `ok=false && sim_err && retryable` → retry with fresh quote (с bump'ом slippage для slippage-class).
     *  - `confirm_timeout` (broadcast already in-flight) → never retry; stop loop.
     *  - other terminal failures → stop loop.
     */
    if (ok && liveOut.ok && liveOut.signature) {
      /** 1.11.231 — sell успешен → инвалидируем кэш SPL-балансов + чистим armed quote. */
      invalidateLiveWalletSplBalanceCache();
      clearArmedSellQuote(args.mint);
      lastResult = await finalizeSellOutcome(liveCfg, args, pk, wsolOut, liveOut);
      lastResult.priceImpactPct = priceImpactPct;
      lastResult.retryAttempts = attempt;
      lastResult.sellAmountSource = sellAmountSource;
      lastResult.walletDrained = sellPipelineWalletDrained(args.intentKind, BigInt(raw), chainAmtBeforeSell);
      lastResult.tokenAmountRawSold = raw;
      return lastResult;
    }
    if (
      !ok &&
      !liveOut.ok &&
      (liveOut.kind === 'sim_err' || liveOut.kind === 'send_failed') &&
      isRetryableSellSimError(liveOut.message)
    ) {
      const isSlippage = isSlippageClassSimError(liveOut.message);
      if (isSlippage) {
        sellSlippageClassAttempts += 1;
        sellCurrentSlippageBps = nextSlippageBps({
          cfg: liveCfg,
          currentBps: sellCurrentSlippageBps,
          bump: sellSlippageBumpBps,
          attempt,
          maxBps: sellSlippageMaxBps,
        });
      }
      const slippageBail = isSlippage && sellSlippageClassAttempts >= sellSlippageCap;
      if (!slippageBail && attempt < sellMaxAttempts - 1) {
        await sleep(sellRetryDelayMs);
        continue;
      }
    }
    return {
      ok,
      wsolOutLamports: undefined,
      solProceedsSource: undefined,
      txSignature: liveOut.ok ? liveOut.signature : liveOut.signature ?? undefined,
      priceImpactPct,
      retryAttempts: attempt,
      ...(!liveOut.ok
        ? {
            terminalKind: sellTerminalKindFromLiveOut(liveOut.kind),
            terminalMessage: liveOut.message,
          }
        : {}),
    };
  }

  return lastResult;
}

/**
 * Extracted confirmed-sell post-processing (was inlined in runTokenToSolPipeline before
 * the retry-loop refactor). Resolves SOL proceeds with the chain-vs-quote heuristic.
 */
async function finalizeSellOutcome(
  liveCfg: LiveOscarConfig,
  args: { mint: string; intentKind: 'sell_partial' | 'sell_full' },
  pk: string,
  wsolOut: bigint | null,
  liveOut: { ok: true; signature: string } | { ok: false; signature?: string | null; kind: string; message: string },
): Promise<LiveTokenToSolPipelineResult> {
  const ok = liveOut.ok;

  let outLamports: bigint | undefined;
  let solProceedsSource: LiveTokenToSolPipelineResult['solProceedsSource'];
  if (ok && liveCfg.executionMode === 'live' && liveOut.ok && liveOut.signature) {
    const chain = await fetchConfirmedSwapSolProceedsLamports(liveCfg, liveOut.signature, pk);
    const quoteOk = wsolOut != null && wsolOut > 0n ? wsolOut : null;
    /**
     * Partial (and occasionally full) sells: meta-based SOL credit can be a tiny false positive
     * (unwrap / WSOL bookkeeping) while Jupiter `outAmount` matches the real swap — using chain alone
     * makes partial `proceedsUsd` ~dust and full-trade `netPnlUsd` falsely negative.
     */
    const QUOTE_FLOOR_LAMPORTS = 500_000n;
    if (chain != null && chain > 0n) {
      if (
        quoteOk != null &&
        quoteOk >= QUOTE_FLOOR_LAMPORTS &&
        chain < quoteOk / 5n
      ) {
        appendLiveJsonlEvent({
          kind: 'risk_note',
          reason: 'sell_sol_proceeds_chain_below_quote',
          detail: {
            mint: args.mint.slice(0, 12),
            intentKind: args.intentKind,
            chainLamports: chain.toString(),
            quoteLamports: quoteOk.toString(),
          },
        });
        outLamports = quoteOk;
        solProceedsSource = 'jupiter_quote';
      } else {
        outLamports = chain;
        solProceedsSource = 'confirmed_meta';
      }
    }
  }
  if (outLamports == null && ok) {
    const q = wsolOut ?? undefined;
    if (q != null && q > 0n) {
      outLamports = q;
      solProceedsSource = 'jupiter_quote';
    }
  }

  return {
    ok,
    wsolOutLamports: ok ? outLamports : undefined,
    solProceedsSource: ok ? solProceedsSource : undefined,
    txSignature: liveOut.ok ? liveOut.signature : liveOut.signature ?? undefined,
  };
}

function wsolOutLamportsFromSellQuote(q: Record<string, unknown>): bigint | null {
  const out = q.outAmount;
  if (typeof out === 'string' && /^\d+$/.test(out)) return BigInt(out);
  return null;
}

/** Execution-layer post-exit re-entry gate (parity with discovery `appendPostExitReentryGateReasons`). */
export function executionPostExitReentryGateReasons(
  paperCfg: PaperTraderConfig,
  mint: string,
  snapshotEntryPriceUsd: number,
): string[] {
  const reasons: string[] = [];
  appendPostExitReentryGateReasons(paperCfg, mint, snapshotEntryPriceUsd, reasons);
  return reasons;
}

/** Phase 5 capital rotation — same JSONL + consec hooks as tracker sells. */
export async function executeLiveTokenToSolPipeline(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    referencePriceUsd?: number | null;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
    onSliceSuccess?: LiveExitSliceSuccessHook;
  },
): Promise<LiveTokenToSolPipelineResult> {
  const { onSliceSuccess, ...pipeArgs } = args;
  return runSlicedTokenToSolPipeline(liveCfg, pipeArgs, runTokenToSolPipeline, { onSliceSuccess });
}

function createDiscovery(liveCfg: LiveOscarConfig): LiveOscarPhase4Discovery {
  return {
    async tryExecuteBuyOpen(ctx: LivePhase4BuyOpenContext): Promise<LiveBuyPipelineResult> {
      const mode = pipelineAnchorMode(ctx.liveCfg);
      const minUsd = ctx.liveCfg.liveSkipBuyOpenIfWalletMintMinUsd;
      const dec = ctx.tokenDecimals ?? ctx.ot.tokenDecimals ?? 6;
      const walletGrossUsd = await estimateLiveWalletMintHoldingGrossUsd({
        liveCfg: ctx.liveCfg,
        mint: ctx.ot.mint,
        tokenDecimals: dec,
        dexSource: ctx.ot.source,
      });
      const promotion =
        walletGrossUsd != null
          ? evaluateCopyToOscarPromotionPlan({ ctx, walletGrossUsd })
          : null;

      if (
        minUsd > 0 &&
        ctx.liveCfg.strategyEnabled &&
        ctx.liveCfg.executionMode === 'live' &&
        !promotion
      ) {
        const est = await estimateLiveWalletMintHoldingUsd({
          liveCfg: ctx.liveCfg,
          mint: ctx.ot.mint,
          tokenDecimals: dec,
          dexSource: ctx.ot.source,
        });
        if (est != null && est >= minUsd) {
          appendLiveJsonlEvent({
            kind: 'execution_skip',
            reason: 'wallet_holds_mint_over_usd_cap',
            detail: JSON.stringify({
              mint: ctx.ot.mint,
              estUsd: +est.toFixed(6),
              minUsd,
            }).slice(0, 500),
          });
          return { ok: false, anchorMode: mode };
        }
      }

      if (promotion) {
        appendLiveJsonlEvent({
          kind: 'copy_to_oscar_promotion',
          mint: ctx.ot.mint,
          symbol: ctx.ot.symbol,
          copyCostBasisUsd: +promotion.copyCostBasisUsd.toFixed(2),
          walletGrossUsd: +promotion.walletGrossUsd.toFixed(2),
          targetUsd: +promotion.targetUsd.toFixed(2),
          topUpUsd: +promotion.topUpUsd.toFixed(2),
          tier: promotion.tier,
        });
      }

      const signalPx = ctx.snapshotEntryPriceUsd;
      if (
        ctx.liveCfg.liveMintScratchReentryEnabled &&
        (ctx.liveCfg.executionMode === 'live' || ctx.liveCfg.executionMode === 'simulate') &&
        isMintScratchReentryBlocked(ctx.liveCfg, ctx.ot.mint, signalPx)
      ) {
        const ref = mintScratchReentryRefPrice(ctx.ot.mint);
        const threshold = mintScratchReentryThresholdPrice(
          ctx.ot.mint,
          ctx.liveCfg.liveMintScratchReentryDropPct,
        );
        appendLiveJsonlEvent({
          kind: 'execution_skip',
          reason: 'live_mint_scratch_reentry_price',
          detail: JSON.stringify({
            mint: ctx.ot.mint.slice(0, 12),
            candidatePriceUsd: signalPx,
            lastExitRefPriceUsd: ref,
            reentryThresholdUsd: threshold,
            dropPct: ctx.liveCfg.liveMintScratchReentryDropPct,
          }).slice(0, 400),
        });
        return {
          ok: false,
          anchorMode: mode,
          terminalKind: 'gate',
          terminalMessage: 'mint_scratch_reentry_price',
        };
      }

      const reentryReasons = waveBPostTp1ScratchReentryBypassGate(ctx.ot.mint)
        ? []
        : executionPostExitReentryGateReasons(
            ctx.paperCfg,
            ctx.ot.mint,
            ctx.snapshotEntryPriceUsd,
          );
      if (reentryReasons.length > 0) {
        appendLiveJsonlEvent({
          kind: 'execution_skip',
          reason: 'post_exit_reentry_gate',
          detail: JSON.stringify({
            mint: ctx.ot.mint.slice(0, 12),
            candidatePriceUsd: ctx.snapshotEntryPriceUsd,
            reasons: reentryReasons.slice(0, 3),
          }).slice(0, 500),
        });
        return {
          ok: false,
          anchorMode: mode,
          terminalKind: 'gate',
          terminalMessage: reentryReasons[0]!.slice(0, 200),
        };
      }

      const firstUsd = promotion
        ? promotion.topUpUsd
        : defaultBuyOpenLegUsd(ctx);

      if (promotion && !(firstUsd > 0)) {
        finalizeCopyToOscarHandoff(ctx.ot.mint);
        return {
          ok: true,
          anchorMode: mode,
          executedUsdNotional: 0,
          copyToOscarPromotion: promotion,
        };
      }

      const buyResult = await runSolToTokenPipeline(liveCfg, {
        mint: ctx.ot.mint,
        symbol: ctx.ot.symbol,
        usdNotional: firstUsd,
        intentKind: 'buy_open',
      });

      if (buyResult.ok && promotion) {
        finalizeCopyToOscarHandoff(ctx.ot.mint);
        return { ...buyResult, copyToOscarPromotion: promotion };
      }

      return buyResult;
    },
  };
}

function createTracker(liveCfg: LiveOscarConfig): LiveOscarPhase4Tracker {
  return {
    async trySolToTokenBuy(args) {
      const intentKind = args.intentKind === 'buy_scale_in' ? 'buy_scale_in' : 'dca_add';
      let usdNotional = args.usdNotional;

      /**
       * Hard per-position ceiling by REAL wallet holding (wallet is the source of truth).
       * Prevents the cumulative-buy runaway seen when sliced adds re-fired and orphaned
       * confirmed buys past the tier plan cap. Live mode only (simulate/paper have no wallet).
       */
      if (
        liveCfg.executionMode === 'live' &&
        (args.positionCeilingUsd ?? 0) > 0 &&
        (args.tokenDecimals ?? 0) > 0
      ) {
        const ceiling = args.positionCeilingUsd!;
        const heldUsd = await estimateLiveWalletMintHoldingGrossUsd({
          liveCfg,
          mint: args.mint,
          tokenDecimals: args.tokenDecimals!,
          dexSource: args.dexSource,
        });
        if (heldUsd != null) {
          const room = ceiling - heldUsd;
          if (room <= 1e-6) {
            appendLiveJsonlEvent({
              kind: 'execution_skip',
              reason: 'position_ceiling_reached',
              detail: JSON.stringify({
                mint: args.mint.slice(0, 12),
                intentKind,
                heldUsd: +heldUsd.toFixed(2),
                ceilingUsd: +ceiling.toFixed(2),
                plannedUsd: +usdNotional.toFixed(2),
              }).slice(0, 500),
            });
            return { ok: false, anchorMode: pipelineAnchorMode(liveCfg), terminalKind: 'gate', terminalMessage: 'position_ceiling_reached' };
          }
          if (usdNotional > room + 1e-6) {
            appendLiveJsonlEvent({
              kind: 'execution_skip',
              reason: 'position_ceiling_clamp',
              detail: JSON.stringify({
                mint: args.mint.slice(0, 12),
                intentKind,
                heldUsd: +heldUsd.toFixed(2),
                ceilingUsd: +ceiling.toFixed(2),
                plannedUsd: +usdNotional.toFixed(2),
                clampedUsd: +room.toFixed(2),
              }).slice(0, 500),
            });
            usdNotional = room;
          }
        }
      }

      return runSlicedSolToTokenPipeline(
        liveCfg,
        {
          mint: args.mint,
          symbol: args.symbol,
          usdNotional,
          intentKind,
          entryBuySliceEligible: args.entryBuySliceEligible,
        },
        runSolToTokenPipeline,
      );
    },
    tryTokenToSolSell(args) {
      const { onSliceSuccess, ...pipeArgs } = args;
      return runSlicedTokenToSolPipeline(liveCfg, pipeArgs, runTokenToSolPipeline, {
        onSliceSuccess,
      }).then((r) => ({
        ok: r.ok,
        preflightSkipReason: r.preflightSkipReason,
        solProceedsLamports: r.wsolOutLamports,
        solProceedsSource: r.solProceedsSource,
        txSignature: r.txSignature,
        priceImpactPct: r.priceImpactPct,
        retryAttempts: r.retryAttempts,
        sellAmountSource: r.sellAmountSource,
        walletDrained: r.walletDrained,
        tokenAmountRawSold: r.tokenAmountRawSold,
      }));
    },
  };
}

export function createLiveOscarPhase4Bundle(liveCfg: LiveOscarConfig): LiveOscarRuntimeBundle {
  return {
    liveCfg,
    discovery: createDiscovery(liveCfg),
    tracker: createTracker(liveCfg),
  };
}
