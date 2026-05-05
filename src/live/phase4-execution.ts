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
import { notifyLiveExecutionSimErr, notifyLiveExecutionSimOk } from './phase5-state.js';
import { liveSendSignedSwapPipeline, type LiveSendPipelineOutcome } from './phase6-send.js';
import { fetchConfirmedSwapSolProceedsLamports } from './swap-tx-sol-proceeds.js';
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';
import {
  clearLiveBuyCooldown,
  isMintBlockedForAmbiguousLiveBuy,
  registerAmbiguousLiveBuyCooldown,
} from './pending-buy-cooldown.js';

let cachedSigner: Keypair | null = null;

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
  notifyLiveExecutionSimErr();
  return false;
}

function pipelineAnchorMode(liveCfg: LiveOscarConfig): LiveBuyPipelineResult['anchorMode'] {
  return liveCfg.executionMode === 'simulate' ? 'simulate' : 'chain';
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

  const solUsd = getSolUsd() ?? 0;
  const intentId = newLiveIntentId();
  const kp = signer(liveCfg);
  const pk = kp.publicKey.toBase58();

  const prep = await liveBuyQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    outputMint: args.mint,
    sizeUsd: args.usdNotional,
    solUsd,
    userPublicKey: pk,
  });

  const quoteSnapshot = prep?.quoteSnapshot ?? { provider: 'jupiter', empty: true };

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
    notifyLiveExecutionSimErr();
    return { ok: false, anchorMode: mode };
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
    notifyLiveExecutionSimErr();
    return { ok: false, anchorMode: mode };
  }

  const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);

  if (liveCfg.executionMode === 'simulate') {
    const sim = await liveSimulateSignedTransaction({
      cfg: liveCfg,
      signedTxSerializedBase64: signedB64,
    });

    if (!sim.ok) {
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        unitsConsumed: sim.unitsConsumed ?? null,
        error: { message: sim.kind + (sim.message ? `:${sim.message.slice(0, 400)}` : '') },
      });
      notifyLiveExecutionSimErr();
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
  return { ok: false, anchorMode: 'chain' };
}

export type LiveTokenToSolPipelineResult = {
  ok: boolean;
  wsolOutLamports?: bigint;
  /** Откуда взяты lamports для учёта partial/full sell. */
  solProceedsSource?: 'confirmed_meta' | 'jupiter_quote';
  txSignature?: string | null;
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

  const solUsd = getSolUsd() ?? 0;
  const intentId = newLiveIntentId();
  const kp = signer(liveCfg);
  const pk = kp.publicKey.toBase58();

  const prep = await liveSellQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    inputMint: args.mint,
    tokenAmountRaw: raw,
    solUsd,
    userPublicKey: pk,
  });

  const quoteSnapshot = prep?.quoteSnapshot ?? { provider: 'jupiter', empty: true };

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
    notifyLiveExecutionSimErr();
    return { ok: false };
  }

  const snapForAgeSell = (prep.quoteSnapshot ?? {}) as Record<string, unknown>;
  if (liveQuoteExceedsMaxAge(snapForAgeSell, liveCfg.liveQuoteMaxAgeMs)) {
    const age = snapForAgeSell.quoteAgeMs;
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
    notifyLiveExecutionSimErr();
    return { ok: false };
  }

  const wsolOut = wsolOutLamportsFromSellQuote(prep.quoteResponse);

  const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);

  if (liveCfg.executionMode === 'simulate') {
    const sim = await liveSimulateSignedTransaction({
      cfg: liveCfg,
      signedTxSerializedBase64: signedB64,
    });

    if (!sim.ok) {
      appendLiveJsonlEvent({
        kind: 'execution_result',
        intentId,
        status: 'sim_err',
        simulated: true,
        unitsConsumed: sim.unitsConsumed ?? null,
        error: { message: sim.kind + (sim.message ? `:${sim.message.slice(0, 400)}` : '') },
      });
      notifyLiveExecutionSimErr();
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
