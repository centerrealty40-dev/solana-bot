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
  liveBuyQuoteAndPrepareSnapshot,
  liveQuoteExceedsMaxAge,
  liveSellQuoteAndPrepareSnapshot,
} from './jupiter.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { liveSimulateSignedTransaction, signLiveJupiterSwapBase64 } from './simulate.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';
import { newLiveIntentId } from './intent.js';
import type { LiveOscarConfig } from './config.js';
import type {
  LiveBuyPipelineResult,
  LiveOscarPhase4Discovery,
  LiveOscarPhase4Tracker,
  LiveOscarRuntimeBundle,
  LivePhase4BuyOpenContext,
} from './phase4-types.js';
import type { DexSource } from '../papertrader/types.js';
import {
  notifyLiveExecutionSimErr,
  notifyLiveExecutionSimErrForTerminal,
  notifyLiveExecutionSimOk,
} from './phase5-state.js';
import { liveSendSignedSwapPipeline, type LiveSendPipelineOutcome } from './phase6-send.js';
import { fetchConfirmedSwapSolProceedsLamports } from './swap-tx-sol-proceeds.js';
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';
import {
  isInsufficientFundsSimError,
  liveWalletCanAffordLamports,
  requiredLamportsForBuyQuote,
} from './wallet-buy-affordability.js';
import {
  clearLiveBuyCooldown,
  isMintBlockedForAmbiguousLiveBuy,
  registerAmbiguousLiveBuyCooldown,
} from './pending-buy-cooldown.js';
import { isMintPermanentlyDeniedLiveOscar } from './mint-permanent-denylist.js';

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

function finalizeLiveSendJsonl(intentId: string, outcome: LiveSendPipelineOutcome): boolean {
  if (outcome.ok) {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'confirmed',
      txSignature: outcome.signature,
      simulated: false,
      unitsConsumed: outcome.preSimUnits,
      slot: outcome.slot,
    });
    notifyLiveExecutionSimOk();
    return true;
  }
  if (outcome.kind === 'sim_err') {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      unitsConsumed: outcome.preSimUnits ?? null,
      error: { message: outcome.message },
    });
    notifyLiveExecutionSimErr();
    return false;
  }
  appendLiveJsonlEvent({
    kind: 'execution_result',
    intentId,
    status: 'failed',
    simulated: false,
    txSignature: outcome.signature ?? null,
    unitsConsumed: outcome.preSimUnits ?? null,
    error: { message: outcome.message },
  });
  /** `confirm_timeout` / `send_failed` are operational; do not trip consec-sim global gate (see phase5-state). */
  if (outcome.kind !== 'confirm_timeout') {
    notifyLiveExecutionSimErrForTerminal(outcome.message);
  }
  return false;
}

function pipelineAnchorMode(liveCfg: LiveOscarConfig): LiveBuyPipelineResult['anchorMode'] {
  return liveCfg.executionMode === 'simulate' ? 'simulate' : 'chain';
}

function isRetryableBuySimError(message: string): boolean {
  if (isInsufficientFundsSimError(message)) return false;
  return message.startsWith('sim_failed:') || message.includes('InstructionError');
}

/**
 * Sell pipeline retry: similar to buy retry but never retries `confirm_timeout`
 * (we already broadcast the swap; a retry would risk double-sell). All transient
 * pre-broadcast failures (`no_quote`, `swap_build`, `quote_stale`, `sim_failed`)
 * are retryable. Tightened slippage (1.11.167) means Jupiter rejects more quotes;
 * persistent retry pushes the order through eventually.
 */
function isRetryableSellSimError(message: string): boolean {
  if (!message) return false;
  if (message.startsWith('confirm_timeout')) return false;
  return (
    message.startsWith('sim_failed:') ||
    message.includes('InstructionError') ||
    message.startsWith('quote_stale') ||
    message === 'no_quote' ||
    message === 'swap_build'
  );
}

/** Estimates USD value of `mint` already on the live wallet (null = could not estimate — caller should not block). */
async function estimateLiveWalletMintHoldingUsd(args: {
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
  if (!liveCfg.strategyEnabled) return { ok: false, anchorMode: mode };
  if (liveCfg.executionMode === 'dry_run') {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `dry_run:${args.intentKind}`,
      detail: args.mint.slice(0, 8),
    });
    return { ok: false, anchorMode: mode };
  }
  if (liveCfg.executionMode !== 'simulate' && liveCfg.executionMode !== 'live') {
    return { ok: false, anchorMode: mode };
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
    return { ok: false, anchorMode: mode };
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
    return { ok: false, anchorMode: mode };
  }

  const kp = signer(liveCfg);
  const pk = kp.publicKey.toBase58();
  const maxAttempts = 1 + liveCfg.liveBuySimRetryAttempts;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const solUsd = getSolUsd() ?? 0;
    const intentId = newLiveIntentId();
    const prep = await liveBuyQuoteAndPrepareSnapshot({
      cfg: liveCfg,
      outputMint: args.mint,
      sizeUsd: args.usdNotional,
      solUsd,
      userPublicKey: pk,
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
      intendedUsd: args.usdNotional,
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
      });
      notifyLiveExecutionSimErrForTerminal(reason);
      return { ok: false, anchorMode: mode };
    }

    if (liveCfg.executionMode === 'live' && attempt === 0) {
      const quoteInRaw = (prep.quoteSnapshot as Record<string, unknown> | undefined)?.quoteInAmount;
      if (typeof quoteInRaw === 'string' && /^\d+$/.test(quoteInRaw)) {
        const need = requiredLamportsForBuyQuote(
          BigInt(quoteInRaw),
          liveCfg.liveFreeSolBufferLamports,
        );
        const afford = await liveWalletCanAffordLamports(liveCfg, need);
        if (!afford.ok) {
          appendLiveJsonlEvent({
            kind: 'execution_skip',
            reason: 'insufficient_wallet_sol_for_buy',
            detail: JSON.stringify({
              mint: args.mint.slice(0, 12),
              lamports: afford.lamports != null ? String(afford.lamports) : null,
              requiredLamports: String(need),
            }).slice(0, 500),
          });
          return { ok: false, anchorMode: mode };
        }
      }
    }

    const snapForAge = (prep.quoteSnapshot ?? {}) as Record<string, unknown>;
    if (liveQuoteExceedsMaxAge(snapForAge, liveCfg.liveQuoteMaxAgeMs)) {
      const age = snapForAge.quoteAgeMs;
      const max = liveCfg.liveQuoteMaxAgeMs;
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        error: {
          message:
            typeof age === 'number' && Number.isFinite(age) && max != null
              ? `quote_stale:${Math.round(age)}ms>${max}ms`
              : 'quote_stale:bad_or_missing_quoteAgeMs',
        },
      });
      notifyLiveExecutionSimErrForTerminal(
        typeof age === 'number' && Number.isFinite(age) && max != null
          ? `quote_stale:${Math.round(age)}ms>${max}ms`
          : 'quote_stale:bad_or_missing_quoteAgeMs',
      );
      return { ok: false, anchorMode: mode };
    }

    const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);

    if (liveCfg.executionMode === 'simulate') {
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
        });
        notifyLiveExecutionSimErrForTerminal(message);
        if (attempt < maxAttempts - 1 && isRetryableBuySimError(message)) {
          await sleep(liveCfg.liveBuySimRetryDelayMs);
          continue;
        }
        return { ok: false, anchorMode: 'simulate' };
      }

      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_ok',
        simulated: true,
        unitsConsumed: sim.unitsConsumed ?? null,
      });
      notifyLiveExecutionSimOk();
      return { ok: true, anchorMode: 'simulate' };
    }

    const liveOut = await liveSendSignedSwapPipeline({
      cfg: liveCfg,
      signedTxSerializedBase64: signedB64,
    });
    const ok = finalizeLiveSendJsonl(intentId, liveOut);
    if (liveCfg.executionMode === 'live') {
      if (ok) {
        clearLiveBuyCooldown(args.mint);
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
      return { ok: true, anchorMode: 'chain', confirmedBuyTxSignature: liveOut.signature };
    }
    if (
      !ok &&
      !liveOut.ok &&
      liveOut.kind === 'sim_err' &&
      attempt < maxAttempts - 1 &&
      isRetryableBuySimError(liveOut.message)
    ) {
      await sleep(liveCfg.liveBuySimRetryDelayMs);
      continue;
    }
    return { ok: false, anchorMode: 'chain' };
  }

  return { ok: false, anchorMode: 'chain' };
}

export type LiveTokenToSolPipelineResult = {
  ok: boolean;
  wsolOutLamports?: bigint;
  /** Откуда взяты lamports для учёта partial/full sell. */
  solProceedsSource?: 'confirmed_meta' | 'jupiter_quote';
  txSignature?: string | null;
  /**
   * 1.11.168: priceImpactPct из последней Jupiter-котировки (которая прошла) — 0..1, не %.
   * Прокидывается до tracker.ts для записи в `partialSells[].priceImpactPct`.
   */
  priceImpactPct?: number;
  /** 1.11.168: фактическое количество retry-попыток до успеха (0 = с первого раза). */
  retryAttempts?: number;
};

async function runTokenToSolPipeline(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
  },
): Promise<LiveTokenToSolPipelineResult> {
  if (!liveCfg.strategyEnabled) return { ok: false };
  if (liveCfg.executionMode === 'dry_run') {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `dry_run:${args.intentKind}`,
      detail: args.mint.slice(0, 8),
    });
    return { ok: false };
  }
  if (liveCfg.executionMode !== 'simulate' && liveCfg.executionMode !== 'live') return { ok: false };

  let raw = tokenAmountRawFromUsd(args.usdNotional, args.priceUsdPerToken, args.decimals);
  if (raw == null) {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: 'token_amount_raw',
      detail: args.mint.slice(0, 8),
    });
    return { ok: false };
  }

  let sellAmountSource: 'usd_math' | 'chain_full_balance' | 'usd_capped_by_chain' = 'usd_math';
  if (liveCfg.executionMode === 'live') {
    const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
    if (chainMap == null) {
      appendLiveJsonlEvent({
        kind: 'execution_skip',
        reason: 'spl_balance_rpc_null',
        detail: args.mint.slice(0, 8),
      });
      return { ok: false };
    }
    const chainAmt = chainMap.get(args.mint) ?? 0n;
    if (chainAmt === 0n) {
      appendLiveJsonlEvent({
        kind: 'execution_skip',
        reason: 'wallet_spl_balance_zero',
        detail: JSON.stringify({ mint: args.mint, intentKind: args.intentKind }).slice(0, 400),
      });
      return { ok: false };
    }
    const computedBn = BigInt(raw);
    if (computedBn === 0n) {
      appendLiveJsonlEvent({
        kind: 'execution_skip',
        reason: 'sell_amount_zero',
        detail: args.mint.slice(0, 8),
      });
      return { ok: false };
    }
    if (args.intentKind === 'sell_full') {
      raw = chainAmt.toString();
      sellAmountSource = 'chain_full_balance';
    } else {
      const capped = computedBn < chainAmt ? computedBn : chainAmt;
      raw = capped.toString();
      sellAmountSource = computedBn > chainAmt ? 'usd_capped_by_chain' : 'usd_math';
    }
  }

  const kp = signer(liveCfg);
  const pk = kp.publicKey.toBase58();
  const sellMaxAttempts = 1 + liveCfg.liveSellSimRetryAttempts;

  /**
   * Persistent retry envelope for sell pipeline (1.11.167):
   * Wraps fresh Jupiter quote + swap build + simulate + send for each attempt.
   * Retries on transient pre-broadcast failures only — never on `confirm_timeout`
   * (already-broadcast tx; retry would risk double-sell). Each attempt emits its
   * own `execution_attempt`/`execution_result` pair so the JSONL keeps full audit
   * of how many tries it took to push through tightened slippage (`isRetryableSellSimError`).
   */
  let lastResult: LiveTokenToSolPipelineResult = { ok: false };
  for (let attempt = 0; attempt < sellMaxAttempts; attempt++) {
    const solUsd = getSolUsd() ?? 0;
    const intentId = newLiveIntentId();
    const prep = await liveSellQuoteAndPrepareSnapshot({
      cfg: liveCfg,
      inputMint: args.mint,
      tokenAmountRaw: raw,
      solUsd,
      userPublicKey: pk,
    });

    const quoteSnapshot = {
      ...(prep?.quoteSnapshot ?? { provider: 'jupiter', empty: true }),
      sellSimRetryAttempt: attempt,
      sellSimRetryMaxAttempts: sellMaxAttempts,
    };

    appendLiveJsonlEvent({
      kind: 'execution_attempt',
      intentId,
      side: 'sell',
      mint: args.mint,
      intendedUsd: args.usdNotional,
      intendedAmountAtomic: raw,
      sellAmountSource,
      executionMode: liveCfg.executionMode,
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
      if (attempt < sellMaxAttempts - 1 && isRetryableSellSimError(reason)) {
        await sleep(liveCfg.liveSellSimRetryDelayMs);
        continue;
      }
      return { ok: false };
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
        await sleep(liveCfg.liveSellSimRetryDelayMs);
        continue;
      }
      return { ok: false };
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

    if (liveCfg.executionMode === 'simulate') {
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
        });
        notifyLiveExecutionSimErrForTerminal(message);
        if (attempt < sellMaxAttempts - 1 && isRetryableSellSimError(message)) {
          await sleep(liveCfg.liveSellSimRetryDelayMs);
          continue;
        }
        return { ok: false };
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
      };
    }

    const liveOut = await liveSendSignedSwapPipeline({
      cfg: liveCfg,
      signedTxSerializedBase64: signedB64,
    });
    const ok = finalizeLiveSendJsonl(intentId, liveOut);
    if (liveCfg.executionMode === 'live' && ok) {
      clearLiveBuyCooldown(args.mint);
    }

    /**
     * Sell broadcast outcome:
     *  - `ok=true` → confirmed swap, return; do not retry.
     *  - `ok=false && sim_err && retryable` → retry with fresh quote.
     *  - `confirm_timeout` (broadcast already in-flight) → never retry; stop loop.
     *  - other terminal failures → stop loop.
     */
    if (ok && liveOut.ok && liveOut.signature) {
      lastResult = await finalizeSellOutcome(liveCfg, args, pk, wsolOut, liveOut);
      lastResult.priceImpactPct = priceImpactPct;
      lastResult.retryAttempts = attempt;
      return lastResult;
    }
    if (
      !ok &&
      !liveOut.ok &&
      liveOut.kind === 'sim_err' &&
      attempt < sellMaxAttempts - 1 &&
      isRetryableSellSimError(liveOut.message)
    ) {
      await sleep(liveCfg.liveSellSimRetryDelayMs);
      continue;
    }
    return {
      ok,
      wsolOutLamports: undefined,
      solProceedsSource: undefined,
      txSignature: liveOut.ok ? liveOut.signature : liveOut.signature ?? undefined,
      priceImpactPct,
      retryAttempts: attempt,
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
          detail: JSON.stringify({
            mint: args.mint.slice(0, 12),
            intentKind: args.intentKind,
            chainLamports: chain.toString(),
            quoteLamports: quoteOk.toString(),
          }).slice(0, 500),
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

/** Phase 5 capital rotation — same JSONL + consec hooks as tracker sells. */
export async function executeLiveTokenToSolPipeline(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
  },
): Promise<LiveTokenToSolPipelineResult> {
  return runTokenToSolPipeline(liveCfg, args);
}

function createDiscovery(liveCfg: LiveOscarConfig): LiveOscarPhase4Discovery {
  return {
    async tryExecuteBuyOpen(ctx: LivePhase4BuyOpenContext): Promise<LiveBuyPipelineResult> {
      const mode = pipelineAnchorMode(ctx.liveCfg);
      const minUsd = ctx.liveCfg.liveSkipBuyOpenIfWalletMintMinUsd;
      if (
        minUsd > 0 &&
        ctx.liveCfg.strategyEnabled &&
        ctx.liveCfg.executionMode === 'live'
      ) {
        const dec = ctx.tokenDecimals ?? ctx.ot.tokenDecimals ?? 6;
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

      const firstUsd =
        ctx.ot.legs[0]?.sizeUsd ??
        ctx.paperCfg.positionUsd * ctx.paperCfg.entryFirstLegFraction;
      return runSolToTokenPipeline(liveCfg, {
        mint: ctx.ot.mint,
        symbol: ctx.ot.symbol,
        usdNotional: firstUsd,
        intentKind: 'buy_open',
      });
    },
  };
}

function createTracker(liveCfg: LiveOscarConfig): LiveOscarPhase4Tracker {
  return {
    trySolToTokenBuy(args) {
      return runSolToTokenPipeline(liveCfg, {
        mint: args.mint,
        symbol: args.symbol,
        usdNotional: args.usdNotional,
        intentKind: args.intentKind === 'buy_scale_in' ? 'buy_scale_in' : 'dca_add',
      });
    },
    tryTokenToSolSell(args) {
      return runTokenToSolPipeline(liveCfg, args).then((r) => ({
        ok: r.ok,
        solProceedsLamports: r.wsolOutLamports,
        solProceedsSource: r.solProceedsSource,
        txSignature: r.txSignature,
        priceImpactPct: r.priceImpactPct,
        retryAttempts: r.retryAttempts,
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
