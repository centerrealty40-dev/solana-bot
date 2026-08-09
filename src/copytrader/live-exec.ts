import type { Keypair } from '@solana/web3.js';
import type { CopyTraderConfig } from './config.js';
import { copyTraderLiveOscarBridge } from './live-bridge.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import {
  isBuyQuoteChasingAnchor,
  isQuotePriceImpactTooHigh,
  liveBuildUnsignedSwapTx,
  liveFetchBuyQuote,
  liveSellQuoteAndPrepareSnapshot,
  tokensPerInLamportFromQuote,
} from '../live/jupiter.js';
import { signLiveJupiterSwapBase64 } from '../live/simulate.js';
import { isRetryableSellSimError, isSlippageClassSimError } from '../live/phase4-execution.js';
import { isRetryableBuySimError } from '../live/execution-retry-errors.js';
import { liveSendSignedSwapPipeline } from '../live/phase6-send.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { rpcCall } from './rpc.js';
import { appendCopyEvent } from './executor.js';
import { checkQuotePremium, effectiveQuotePremiumCap } from './evaluate.js';
import { isFullCloseFraction, scaleTokenRaw } from './proportional.js';
import {
  copyBuyInputAmountRaw,
  copyBuyQuotePriceUsd,
  copyQuoteRawToUsd,
  copyQuoteSpec,
  copySellQuotePriceUsd,
} from './quote-mint.js';
import { peekCopyQuoteBalances } from './funding-gate.js';
import { bumpSlippageBps } from './slippage-bump.js';
import { isQuoteOutRegressed, parseTokenRaw } from './quote-quality.js';

export type LiveCashFillFields = {
  quoteSpentUsd?: number;
  quoteReceivedUsd?: number;
  usdcBefore?: number;
  usdcAfter?: number;
  feeSolBefore?: number;
  feeSolAfter?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableSellPreSendError(reason: string): boolean {
  if (!reason) return false;
  if (reason.startsWith('confirm_timeout')) return false;
  if (reason.includes('swap-http-429')) return true;
  if (reason === 'jupiter_sell_quote_failed') return true;
  return isRetryableSellSimError(reason);
}

function isRetryableBuyPreSendError(reason: string): boolean {
  if (!reason) return false;
  if (reason.startsWith('confirm_timeout')) return false;
  if (reason === 'buy_quote_premium_blocked') return false;
  if (reason.startsWith('chase_aborted')) return false;
  if (reason === 'jupiter_buy_quote_failed') return true;
  if (reason.startsWith('quote_quality_regressed')) return true;
  if (reason.startsWith('route_too_impactful')) return true;
  if (reason.includes('swap-http-429')) return true;
  return isRetryableBuySimError(reason);
}

let cachedSigner: Keypair | null = null;

function signer(cfg: CopyTraderConfig): Keypair {
  if (!cachedSigner) {
    const s = cfg.walletSecret?.trim();
    if (!s) throw new Error('COPY_TRADER_WALLET_SECRET missing');
    cachedSigner = loadLiveKeypairFromSecretEnv(s);
  }
  return cachedSigner;
}

export async function fetchMintBalanceRaw(
  cfg: CopyTraderConfig,
  mint: string,
): Promise<string | null> {
  const owner = signer(cfg).publicKey.toBase58();
  const rows = await rpcCall<unknown>(
    cfg.rpcUrl,
    'getTokenAccountsByOwner',
    [owner, { mint }, { encoding: 'jsonParsed' }],
    5,
  );
  const value = (rows as { value?: unknown[] } | null)?.value ?? [];
  let total = 0n;
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const account = (row as { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }).account;
    const amt = account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amt === 'string' && /^\d+$/.test(amt)) total += BigInt(amt);
  }
  return total > 0n ? total.toString() : null;
}

async function sendSwap(cfg: CopyTraderConfig, unsignedB64: string, meta: Record<string, unknown>): Promise<{ ok: boolean; signature?: string; reason?: string }> {
  const liveCfg = copyTraderLiveOscarBridge(cfg);
  const signed = signLiveJupiterSwapBase64(unsignedB64, signer(cfg));
  const outcome = await liveSendSignedSwapPipeline({ cfg: liveCfg, signedTxSerializedBase64: signed });
  if (outcome.ok) {
    appendCopyEvent(cfg, {
      kind: 'execution_result',
      status: 'confirmed',
      txSignature: outcome.signature,
      ...meta,
    });
    return { ok: true, signature: outcome.signature };
  }
  appendCopyEvent(cfg, {
    kind: 'execution_result',
    status: outcome.kind,
    error: outcome.message,
    txSignature: outcome.signature ?? null,
    ...meta,
  });
  return { ok: false, reason: outcome.message };
}

export async function executeLiveCopyBuy(args: {
  cfg: CopyTraderConfig;
  mint: string;
  symbol: string;
  sizeUsd: number;
  kind: 'entry' | 'add';
  leaderSignature: string;
  /** Leader fill price for the post-quote premium guard (0 = guard off). */
  leaderPriceUsd?: number;
  /** Leader buy timestamp — selects first-shot vs steady premium cap. */
  leaderBuyTs?: number;
}): Promise<
  {
    ok: boolean;
    priceUsd: number;
    signature?: string;
    tokenRaw?: string;
    reason?: string;
  } & LiveCashFillFields
> {
  const {
    cfg,
    mint,
    symbol,
    sizeUsd,
    kind,
    leaderSignature,
    leaderPriceUsd = 0,
    leaderBuyTs = 0,
  } = args;
  const liveCfg = copyTraderLiveOscarBridge(cfg);
  const solUsd = getSolUsd();
  const userPk = signer(cfg).publicKey.toBase58();
  const quoteSpec = copyQuoteSpec(cfg);
  const beforeBal = await peekCopyQuoteBalances(cfg);

  const inputAmountRaw = copyBuyInputAmountRaw(quoteSpec, sizeUsd, solUsd);
  if (inputAmountRaw == null) {
    return { ok: false, priceUsd: 0, reason: 'buy_size_unresolvable' };
  }

  const maxAttempts = 1 + liveCfg.liveBuySimRetryAttempts;
  const slippageCap = 1 + liveCfg.liveBuySimSlippageRetryAttempts;
  let slippageClassAttempts = 0;
  let currentSlippageBps = liveCfg.liveDefaultSlippageBps;
  let lastReason = 'jupiter_buy_quote_failed';
  let lastPriceUsd = 0;
  let bestOutRaw = 0n;
  let anchorTokensPerLamport: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const quote = await liveFetchBuyQuote({
      cfg: liveCfg,
      outputMint: mint,
      sizeUsd,
      solUsd,
      slippageBpsOverride: currentSlippageBps,
      inputMintOverride: quoteSpec.mint,
      inputAmountRawOverride: inputAmountRaw,
    });
    if (!quote) {
      lastReason = 'jupiter_buy_quote_failed';
      if (attempt < maxAttempts - 1) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
      return { ok: false, priceUsd: 0, reason: lastReason };
    }

    const outRaw = quote.quoteResponse.outAmount;
    const outParsed = parseTokenRaw(outRaw);
    if (outParsed != null && outParsed > bestOutRaw) bestOutRaw = outParsed;

    const priceUsd = copyBuyQuotePriceUsd({
      spec: quoteSpec,
      inAmountRaw: quote.quoteResponse.inAmount,
      outAmountRaw: outRaw,
      solUsd,
    });
    lastPriceUsd = priceUsd;

    const impactCheck = isQuotePriceImpactTooHigh(
      quote.quoteResponse,
      liveCfg.liveBuyMaxPriceImpactPct,
    );
    if (impactCheck.blocked && impactCheck.pct != null) {
      lastReason = `route_too_impactful:buy:${impactCheck.pct.toFixed(2)}%>${liveCfg.liveBuyMaxPriceImpactPct}%`;
      appendCopyEvent(cfg, {
        kind: 'buy_quote_impact_blocked',
        mint,
        symbol,
        kindBuy: kind,
        leaderSignature,
        sizeUsd,
        priceImpactPct: impactCheck.pct,
        maxPriceImpactPct: liveCfg.liveBuyMaxPriceImpactPct,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
      });
      if (attempt < maxAttempts - 1) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
      return { ok: false, priceUsd, reason: lastReason };
    }

    const currentTpl = tokensPerInLamportFromQuote(quote.quoteResponse);
    if (anchorTokensPerLamport == null && currentTpl != null) {
      anchorTokensPerLamport = currentTpl;
    } else {
      const chase = isBuyQuoteChasingAnchor({
        anchorTokensPerLamport,
        currentTokensPerLamport: currentTpl,
        maxChasePct: liveCfg.liveBuyMaxChasePct,
      });
      if (chase.chased && chase.chasePct != null) {
        lastReason = `chase_aborted:buy:${chase.chasePct.toFixed(2)}%>+${liveCfg.liveBuyMaxChasePct}%`;
        appendCopyEvent(cfg, {
          kind: 'buy_quote_chase_aborted',
          mint,
          symbol,
          kindBuy: kind,
          leaderSignature,
          sizeUsd,
          chasePct: Number(chase.chasePct.toFixed(2)),
          maxChasePct: liveCfg.liveBuyMaxChasePct,
          slippageBps: currentSlippageBps,
          buySimRetryAttempt: attempt,
        });
        return { ok: false, priceUsd, reason: lastReason };
      }
    }

    if (
      outParsed != null &&
      isQuoteOutRegressed({
        outRaw: outParsed,
        bestOutRaw,
        maxRegressionPct: cfg.maxQuoteRegressionPct,
      })
    ) {
      lastReason = `quote_quality_regressed:out<best-${cfg.maxQuoteRegressionPct}%`;
      appendCopyEvent(cfg, {
        kind: 'buy_quote_quality_regressed',
        mint,
        symbol,
        kindBuy: kind,
        leaderSignature,
        sizeUsd,
        quoteOutAmount: outParsed.toString(),
        bestOutAmount: bestOutRaw.toString(),
        maxRegressionPct: cfg.maxQuoteRegressionPct,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
      });
      if (attempt < maxAttempts - 1) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
      return { ok: false, priceUsd, reason: lastReason };
    }

    if (cfg.quotePremiumGuardPct > 0 || cfg.quotePremiumFirstShotPct > 0) {
      const { maxPremiumPct, firstShot } = effectiveQuotePremiumCap({
        guardPct: cfg.quotePremiumGuardPct,
        firstShotPct: cfg.quotePremiumFirstShotPct,
        graceMs: cfg.quotePremiumGraceMs,
        leaderBuyTs,
        nowMs: Date.now(),
      });
      if (maxPremiumPct > 0) {
        const verdict = checkQuotePremium({
          quotePriceUsd: priceUsd,
          leaderPriceUsd,
          maxPremiumPct,
        });
        if (verdict.block) {
          appendCopyEvent(cfg, {
            kind: 'buy_quote_premium_blocked',
            mint,
            symbol,
            kindBuy: kind,
            leaderSignature,
            leaderPriceUsd,
            quotePriceUsd: priceUsd,
            maxAllowedPriceUsd: verdict.maxAllowedPriceUsd,
            premiumPct: Number(verdict.premiumPct.toFixed(2)),
            maxPremiumPct,
            firstShot,
            sizeUsd,
            slippageBps: currentSlippageBps,
            buySimRetryAttempt: attempt,
          });
          /** Premium is a pricing gate, not a slippage-class — surface immediately for outer retry. */
          return { ok: false, priceUsd, reason: verdict.reason };
        }
      }
    }

    const build = await liveBuildUnsignedSwapTx({
      cfg: liveCfg,
      quoteResponse: quote.quoteResponse,
      userPublicKey: userPk,
    });
    if (!build.ok) {
      lastReason = build.reason;
      if (attempt < maxAttempts - 1 && isRetryableBuyPreSendError(lastReason)) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
      return { ok: false, priceUsd: lastPriceUsd, reason: lastReason };
    }

    const sent = await sendSwap(cfg, build.b64, {
      side: 'buy',
      mint,
      symbol,
      sizeUsd,
      kind,
      leaderSignature,
      quoteAsset: quoteSpec.asset,
      quoteSnapshot: {
        ...quote.quoteSnapshot,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
        slippageBps: currentSlippageBps,
      },
    });

    if (sent.ok) {
      const quoteSpentUsd = copyQuoteRawToUsd(
        quoteSpec,
        Number(quote.quoteResponse.inAmount),
        solUsd,
      );
      await sleep(450);
      const afterBal = await peekCopyQuoteBalances(cfg);
      return {
        ok: true,
        priceUsd,
        signature: sent.signature,
        tokenRaw: outRaw != null ? String(outRaw) : undefined,
        quoteSpentUsd: quoteSpentUsd > 0 ? quoteSpentUsd : undefined,
        usdcBefore: beforeBal?.quoteUsd,
        usdcAfter: afterBal?.quoteUsd,
        feeSolBefore: beforeBal?.feeSol,
        feeSolAfter: afterBal?.feeSol,
      };
    }

    lastReason = sent.reason ?? 'send_failed';
    if (lastReason.startsWith('confirm_timeout')) {
      return {
        ok: false,
        priceUsd,
        signature: sent.signature,
        tokenRaw: outRaw != null ? String(outRaw) : undefined,
        reason: lastReason,
        usdcBefore: beforeBal?.quoteUsd,
        feeSolBefore: beforeBal?.feeSol,
      };
    }

    const isSlippage = isSlippageClassSimError(lastReason);
    if (isSlippage) {
      slippageClassAttempts += 1;
      currentSlippageBps = bumpSlippageBps({
        currentBps: currentSlippageBps,
        bumpBps: liveCfg.liveSimSlippageRetryBumpBps,
        maxBps: liveCfg.liveSimSlippageRetryMaxBps,
      });
    }
    const slippageBail = isSlippage && slippageClassAttempts >= slippageCap;
    if (!slippageBail && attempt < maxAttempts - 1 && isRetryableBuyPreSendError(lastReason)) {
      await sleep(liveCfg.liveBuySimRetryDelayMs);
      continue;
    }

    return {
      ok: false,
      priceUsd,
      signature: sent.signature,
      tokenRaw: outRaw != null ? String(outRaw) : undefined,
      reason: lastReason,
      usdcBefore: beforeBal?.quoteUsd,
      feeSolBefore: beforeBal?.feeSol,
    };
  }

  return {
    ok: false,
    priceUsd: lastPriceUsd,
    reason: lastReason,
    usdcBefore: beforeBal?.quoteUsd,
    feeSolBefore: beforeBal?.feeSol,
  };
}

export async function executeLiveCopySell(args: {
  cfg: CopyTraderConfig;
  mint: string;
  symbol: string;
  leaderSignature: string;
  fraction: number;
  /** Copy-attributed balance (required in shared-wallet mode). */
  tokenRawBase?: string;
}): Promise<
  {
    ok: boolean;
    priceUsd: number;
    signature?: string;
    tokenRawRemaining?: string;
    reason?: string;
  } & LiveCashFillFields
> {
  const { cfg, mint, symbol, leaderSignature, fraction, tokenRawBase } = args;
  const liveCfg = copyTraderLiveOscarBridge(cfg);
  const solUsd = getSolUsd();
  const userPk = signer(cfg).publicKey.toBase58();
  const quoteSpec = copyQuoteSpec(cfg);
  const beforeBal = await peekCopyQuoteBalances(cfg);

  /**
   * Prefer attributed `tokenRawBase` (shared-wallet lanes), but never sell more
   * than the on-chain ATA. Buy-side Jupiter `outAmount` is often a few % above
   * the confirmed fill — using it raw → sim Custom:6024 InsufficientFunds and
   * the position gets stuck through time-stop retries.
   */
  const onchainStr = await fetchMintBalanceRaw(cfg, mint);
  const onchainRaw = onchainStr && /^\d+$/.test(onchainStr) ? BigInt(onchainStr) : 0n;

  let totalRaw = 0n;
  if (tokenRawBase) {
    try {
      totalRaw = BigInt(tokenRawBase);
    } catch {
      totalRaw = 0n;
    }
  }
  if (totalRaw <= 0n) {
    if (onchainRaw <= 0n) {
      return { ok: false, priceUsd: 0, reason: 'no_token_balance' };
    }
    totalRaw = onchainRaw;
  } else if (onchainRaw <= 0n) {
    return { ok: false, priceUsd: 0, reason: 'no_token_balance' };
  } else if (totalRaw > onchainRaw) {
    totalRaw = onchainRaw;
  }
  const sellRaw = isFullCloseFraction(fraction) ? totalRaw : scaleTokenRaw(totalRaw, fraction);
  if (sellRaw <= 0n) {
    return { ok: false, priceUsd: 0, reason: 'sell_amount_zero' };
  }

  const maxAttempts = 1 + liveCfg.liveSellSimRetryAttempts;
  const slippageCap = 1 + liveCfg.liveSellSimSlippageRetryAttempts;
  let slippageClassAttempts = 0;
  let currentSlippageBps = liveCfg.liveDefaultSlippageBps;
  let lastReason = 'jupiter_sell_quote_failed';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const prep = await liveSellQuoteAndPrepareSnapshot({
      cfg: liveCfg,
      inputMint: mint,
      tokenAmountRaw: sellRaw.toString(),
      solUsd,
      userPublicKey: userPk,
      slippageBpsOverride: currentSlippageBps,
      outputMintOverride: quoteSpec.mint,
    });
    if (!prep) {
      lastReason = 'jupiter_sell_quote_failed';
      if (attempt < maxAttempts - 1) {
        await sleep(liveCfg.liveSellSimRetryDelayMs);
        continue;
      }
      return { ok: false, priceUsd: 0, reason: lastReason };
    }
    if (!prep.swapBuild.ok) {
      lastReason = prep.swapBuild.reason;
      if (attempt < maxAttempts - 1 && isRetryableSellPreSendError(lastReason)) {
        await sleep(liveCfg.liveSellSimRetryDelayMs);
        continue;
      }
      return { ok: false, priceUsd: 0, reason: lastReason };
    }

    const { priceUsd: exitPriceUsd, proceedsUsd } = copySellQuotePriceUsd({
      spec: quoteSpec,
      outAmountRaw: prep.quoteResponse.outAmount,
      tokenAmountRaw: sellRaw,
      solUsd,
    });

    const sent = await sendSwap(cfg, prep.swapBuild.b64, {
      side: 'sell',
      mint,
      symbol,
      leaderSignature,
      sellFraction: fraction,
      tokenAmountRaw: sellRaw.toString(),
      quoteAsset: quoteSpec.asset,
      quoteSnapshot: {
        ...prep.quoteSnapshot,
        sellSimRetryAttempt: attempt,
        sellSimRetryMaxAttempts: maxAttempts,
        slippageBps: currentSlippageBps,
      },
    });

    const remaining = totalRaw > sellRaw ? (totalRaw - sellRaw).toString() : '0';

    if (sent.ok) {
      await sleep(450);
      const afterBal = await peekCopyQuoteBalances(cfg);
      return {
        ok: true,
        priceUsd: exitPriceUsd,
        signature: sent.signature,
        tokenRawRemaining: remaining,
        quoteReceivedUsd: proceedsUsd > 0 ? proceedsUsd : undefined,
        usdcBefore: beforeBal?.quoteUsd,
        usdcAfter: afterBal?.quoteUsd,
        feeSolBefore: beforeBal?.feeSol,
        feeSolAfter: afterBal?.feeSol,
      };
    }

    lastReason = sent.reason ?? 'send_failed';
    if (lastReason.startsWith('confirm_timeout')) {
      return {
        ok: false,
        priceUsd: exitPriceUsd,
        signature: sent.signature,
        tokenRawRemaining: remaining,
        reason: lastReason,
        quoteReceivedUsd: proceedsUsd > 0 ? proceedsUsd : undefined,
        usdcBefore: beforeBal?.quoteUsd,
        feeSolBefore: beforeBal?.feeSol,
      };
    }

    const isSlippage = isSlippageClassSimError(lastReason);
    if (isSlippage) {
      slippageClassAttempts += 1;
      currentSlippageBps = bumpSlippageBps({
        currentBps: currentSlippageBps,
        bumpBps: liveCfg.liveSimSlippageRetryBumpBps,
        maxBps: liveCfg.liveSimSlippageRetryMaxBps,
      });
    }
    const slippageBail = isSlippage && slippageClassAttempts >= slippageCap;
    if (!slippageBail && attempt < maxAttempts - 1 && isRetryableSellPreSendError(lastReason)) {
      await sleep(liveCfg.liveSellSimRetryDelayMs);
      continue;
    }

    return {
      ok: false,
      priceUsd: exitPriceUsd,
      signature: sent.signature,
      tokenRawRemaining: remaining,
      reason: lastReason,
      usdcBefore: beforeBal?.quoteUsd,
      feeSolBefore: beforeBal?.feeSol,
    };
  }

  return {
    ok: false,
    priceUsd: 0,
    reason: lastReason,
    usdcBefore: beforeBal?.quoteUsd,
    feeSolBefore: beforeBal?.feeSol,
  };
}
