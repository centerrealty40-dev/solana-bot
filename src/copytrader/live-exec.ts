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
import { fetchParsedTransaction, rpcCall, transactionUsdcDeltaUsd } from './rpc.js';
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
import { bumpSlippageBps, multiplySlippageBps } from './slippage-bump.js';
import { isQuoteOutRegressed, parseTokenRaw } from './quote-quality.js';

export type LiveCashFillFields = {
  quoteSpentUsd?: number;
  quoteReceivedUsd?: number;
  usdcBefore?: number;
  usdcAfter?: number;
  feeSolBefore?: number;
  feeSolAfter?: number;
  txMeta?: unknown;
  cashDeltaUsd?: number;
  slippageBps?: number;
  buySimRetryAttempt?: number;
  buySimRetryMaxAttempts?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Re-reads before trusting a zero token balance (node lag after a buy). */
const SELL_BALANCE_REREADS = 3;
const SELL_BALANCE_REREAD_GAP_MS = 350;
function parseRaw(raw: string | null | undefined): bigint {
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

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

export function resolveBuyMaxPriceImpactPct(
  override: number | undefined,
  globalCap: number,
): number {
  return override != null && Number.isFinite(override) && override > 0
    ? override
    : globalCap;
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

async function sendSwap(
  cfg: CopyTraderConfig,
  unsignedB64: string,
  meta: Record<string, unknown>,
): Promise<{
  ok: boolean;
  signature?: string;
  reason?: string;
  txMeta?: unknown;
  cashDeltaUsd?: number;
}> {
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
    const tx = outcome.signature
      ? await Promise.race([
          fetchParsedTransaction(cfg.rpcUrl, outcome.signature).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ])
      : null;
    const txMeta =
      tx && typeof tx === 'object' && tx !== null && 'meta' in tx
        ? (tx as { meta?: unknown }).meta
        : null;
    return {
      ok: true,
      signature: outcome.signature,
      txMeta,
      cashDeltaUsd: transactionUsdcDeltaUsd(txMeta, signer(cfg).publicKey.toBase58()) ?? undefined,
    };
  }
  appendCopyEvent(cfg, {
    kind: 'execution_result',
    status: outcome.kind,
    error: outcome.message,
    txSignature: outcome.signature ?? null,
    ...(outcome.kind === 'sim_err'
      ? {
          simulationProgramId: outcome.simulationProgramId ?? null,
          simulationLogs: outcome.simulationLogs ?? [],
          simulationSlippageBps: meta.slippageBps ?? null,
          simulationBuySimRetryAttempt:
            meta.quoteSnapshot &&
            typeof meta.quoteSnapshot === 'object' &&
            'buySimRetryAttempt' in meta.quoteSnapshot
              ? meta.quoteSnapshot.buySimRetryAttempt
              : null,
        }
      : {}),
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
  trigger?: 'stream' | 'leader' | 'scan';
  /** Leader fill price for the post-quote premium guard (0 = guard off). */
  leaderPriceUsd?: number;
  /** Leader buy timestamp — selects first-shot vs steady premium cap. */
  leaderBuyTs?: number;
  slippageBpsOverride?: number;
  slippageRetryMultiplier?: number;
  slippageRetryMaxBps?: number;
  maxPriceImpactPct?: number;
  beforeSend?: () => Promise<boolean>;
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
    trigger,
    leaderPriceUsd = 0,
    leaderBuyTs = 0,
  } = args;
  const liveCfg = copyTraderLiveOscarBridge(cfg);
  const maxPriceImpactPct = resolveBuyMaxPriceImpactPct(
    args.maxPriceImpactPct,
    liveCfg.liveBuyMaxPriceImpactPct,
  );
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
  let currentSlippageBps =
    args.slippageBpsOverride != null && Number.isFinite(args.slippageBpsOverride)
      ? Math.max(1, Math.min(5000, Math.floor(args.slippageBpsOverride)))
      : liveCfg.liveDefaultSlippageBps;
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
      return {
        ok: false,
        priceUsd: 0,
        reason: lastReason,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
      };
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
      maxPriceImpactPct,
    );
    if (impactCheck.blocked && impactCheck.pct != null) {
      lastReason = `route_too_impactful:buy:${impactCheck.pct.toFixed(2)}%>${maxPriceImpactPct}%`;
      appendCopyEvent(cfg, {
        kind: 'buy_quote_impact_blocked',
        mint,
        symbol,
        kindBuy: kind,
        leaderSignature,
        sizeUsd,
        priceImpactPct: impactCheck.pct,
        maxPriceImpactPct,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
      });
      if (attempt < maxAttempts - 1) {
        await sleep(liveCfg.liveBuySimRetryDelayMs);
        continue;
      }
      return {
        ok: false,
        priceUsd,
        reason: lastReason,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
      };
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
        return {
          ok: false,
          priceUsd,
          reason: lastReason,
          slippageBps: currentSlippageBps,
          buySimRetryAttempt: attempt,
          buySimRetryMaxAttempts: maxAttempts,
        };
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
      return {
        ok: false,
        priceUsd,
        reason: lastReason,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
      };
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
          return {
            ok: false,
            priceUsd,
            reason: verdict.reason,
            slippageBps: currentSlippageBps,
            buySimRetryAttempt: attempt,
            buySimRetryMaxAttempts: maxAttempts,
          };
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
      return {
        ok: false,
        priceUsd: lastPriceUsd,
        reason: lastReason,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
      };
    }

    if (args.beforeSend && !(await args.beforeSend())) {
      return {
        ok: false,
        priceUsd,
        reason: 'leader_balance_guard_blocked',
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
      };
    }

    const sent = await sendSwap(cfg, build.b64, {
      side: 'buy',
      mint,
      symbol,
      sizeUsd,
      kind,
      trigger,
      leaderSignature,
      quoteAsset: quoteSpec.asset,
      quoteSnapshot: {
        ...quote.quoteSnapshot,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
        slippageBps: currentSlippageBps,
      },
      slippageBps: currentSlippageBps,
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
        txMeta: sent.txMeta,
        cashDeltaUsd: sent.cashDeltaUsd,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
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
        txMeta: sent.txMeta,
        cashDeltaUsd: sent.cashDeltaUsd,
        slippageBps: currentSlippageBps,
        buySimRetryAttempt: attempt,
        buySimRetryMaxAttempts: maxAttempts,
      };
    }

    const isSlippage = isSlippageClassSimError(lastReason);
    if (isSlippage) {
      slippageClassAttempts += 1;
      if (args.slippageRetryMultiplier != null && args.slippageRetryMultiplier > 1) {
        currentSlippageBps = multiplySlippageBps({
          currentBps: currentSlippageBps,
          multiplier: args.slippageRetryMultiplier,
          maxBps: args.slippageRetryMaxBps ?? liveCfg.liveSimSlippageRetryMaxBps,
        });
      } else {
        currentSlippageBps = bumpSlippageBps({
          currentBps: currentSlippageBps,
          bumpBps: liveCfg.liveSimSlippageRetryBumpBps,
          maxBps: liveCfg.liveSimSlippageRetryMaxBps,
        });
      }
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
      slippageBps: currentSlippageBps,
      buySimRetryAttempt: attempt,
      buySimRetryMaxAttempts: maxAttempts,
    };
  }

  return {
    ok: false,
    priceUsd: lastPriceUsd,
    reason: lastReason,
    usdcBefore: beforeBal?.quoteUsd,
    feeSolBefore: beforeBal?.feeSol,
    slippageBps: currentSlippageBps,
    buySimRetryAttempt: maxAttempts - 1,
    buySimRetryMaxAttempts: maxAttempts,
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
  /**
   * 1.11.883 — refuse to sell below this price. Set only for money-motivated
   * exits, where realising under our cost defeats the exit's own purpose; risk
   * exits pass nothing and always execute.
   */
  minExitPriceUsd?: number;
  /** Which pre-send quote guard supplied `minExitPriceUsd`, for audit. */
  minExitPriceGuard?: 'cost_floor' | 'profit_fill_slippage' | 'loss_fill_slippage';
  fillGuardDecisionPriceUsd?: number;
  fillGuardMaxSlipPct?: number;
  slippageBpsOverride?: number;
  slippageRetryMultiplier?: number;
  slippageRetryMaxBps?: number;
}): Promise<
  {
    ok: boolean;
    priceUsd: number;
    signature?: string;
    tokenRawRemaining?: string;
    /** Balance this sell sized against — authoritative input for settlement. */
    tokenRawBefore?: string;
    /** Amount actually sent to Jupiter. */
    tokenRawSold?: string;
    reason?: string;
    minExitPriceGuard?: 'cost_floor' | 'profit_fill_slippage' | 'loss_fill_slippage';
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
  /**
   * A zero balance read is not proof of an empty wallet. Right after a buy the
   * node still answers the pre-buy state, and this early return turned that into
   * a refused exit: live `k6BE8rs` decided to bank at **+14.36% MFE** 25s after
   * entry, got `no_token_balance` four times over 11 seconds, and filled at
   * **−2.83%**. Re-read briefly before believing it — the cost lands only on the
   * failing path.
   */
  let onchainStr = await fetchMintBalanceRaw(cfg, mint);
  let onchainRaw = parseRaw(onchainStr);
  for (let i = 0; onchainRaw <= 0n && i < SELL_BALANCE_REREADS; i += 1) {
    await sleep(SELL_BALANCE_REREAD_GAP_MS);
    onchainStr = await fetchMintBalanceRaw(cfg, mint);
    onchainRaw = parseRaw(onchainStr);
  }

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
  /** Settlement truth: callers must not trust a post-sell RPC read above this. */
  const rawFields = { tokenRawBefore: totalRaw.toString(), tokenRawSold: sellRaw.toString() };

  const maxAttempts = 1 + liveCfg.liveSellSimRetryAttempts;
  const slippageCap = 1 + liveCfg.liveSellSimSlippageRetryAttempts;
  let slippageClassAttempts = 0;
  let currentSlippageBps =
    args.slippageBpsOverride != null && Number.isFinite(args.slippageBpsOverride)
      ? Math.max(1, Math.min(5000, Math.floor(args.slippageBpsOverride)))
      : liveCfg.liveDefaultSlippageBps;
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
      return { ok: false, priceUsd: 0, reason: lastReason, ...rawFields };
    }
    if (!prep.swapBuild.ok) {
      lastReason = prep.swapBuild.reason;
      if (attempt < maxAttempts - 1 && isRetryableSellPreSendError(lastReason)) {
        await sleep(liveCfg.liveSellSimRetryDelayMs);
        continue;
      }
      return { ok: false, priceUsd: 0, reason: lastReason, ...rawFields };
    }

    const { priceUsd: exitPriceUsd, proceedsUsd } = copySellQuotePriceUsd({
      spec: quoteSpec,
      outAmountRaw: prep.quoteResponse.outAmount,
      tokenAmountRaw: sellRaw,
      solUsd,
    });

    /**
     * 1.11.883 — the decision was made on a mark; this is the price we can
     * actually get. Over 2009 sells the two differed by a median 0.99% and p25
     * −3.59%, so a profit-motivated exit routinely realised below its own floor:
     * 8PecVcC took the bounce half at −3.26% with MFE 0.12%, twice. If the quote
     * cannot clear the floor, abandon the sell and let the next tick decide on
     * fresh data. Risk exits set no floor and are never blocked here.
     */
    if (
      args.minExitPriceUsd != null &&
      args.minExitPriceUsd > 0 &&
      exitPriceUsd > 0 &&
      exitPriceUsd < args.minExitPriceUsd
    ) {
      const shortfallPct = (exitPriceUsd / args.minExitPriceUsd - 1) * 100;
      appendCopyEvent(cfg, {
        kind:
            args.minExitPriceGuard === 'profit_fill_slippage'
              ? 'sell_quote_below_profit_slippage'
              : args.minExitPriceGuard === 'loss_fill_slippage'
                ? 'sell_quote_below_loss_slippage'
              : 'sell_quote_below_floor',
        mint,
        symbol,
        leaderSignature,
        sellFraction: fraction,
        quoteExitPriceUsd: exitPriceUsd,
        minExitPriceUsd: args.minExitPriceUsd,
        shortfallPct: Number(shortfallPct.toFixed(2)),
        slippageBps: currentSlippageBps,
        sellSimRetryAttempt: attempt,
        minExitPriceGuard: args.minExitPriceGuard ?? 'cost_floor',
        ...(args.fillGuardDecisionPriceUsd != null && args.fillGuardDecisionPriceUsd > 0
          ? {
              ...(args.minExitPriceGuard === 'loss_fill_slippage'
                ? {
                    lossFillShortfallPct: Number(
                      ((exitPriceUsd / args.fillGuardDecisionPriceUsd - 1) * 100).toFixed(2),
                    ),
                  }
                : {
                    profitFillShortfallPct: Number(
                      ((exitPriceUsd / args.fillGuardDecisionPriceUsd - 1) * 100).toFixed(2),
                    ),
                  }),
            }
          : {}),
        ...(args.fillGuardDecisionPriceUsd != null
          ? {
              [args.minExitPriceGuard === 'loss_fill_slippage'
                ? 'lossFillDecisionPriceUsd'
                : 'profitFillDecisionPriceUsd']: args.fillGuardDecisionPriceUsd,
            }
          : {}),
        ...(args.fillGuardMaxSlipPct != null
          ? {
              [args.minExitPriceGuard === 'loss_fill_slippage'
                ? 'lossFillMaxSlipPct'
                : 'profitFillMaxSlipPct']: args.fillGuardMaxSlipPct,
            }
          : {}),
      });
      return {
        ok: false,
        priceUsd: exitPriceUsd,
        reason: `sell_quote_below_floor:${shortfallPct.toFixed(2)}%`,
        minExitPriceGuard: args.minExitPriceGuard ?? 'cost_floor',
        ...rawFields,
      };
    }

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
        ...rawFields,
        quoteReceivedUsd: proceedsUsd > 0 ? proceedsUsd : undefined,
        usdcBefore: beforeBal?.quoteUsd,
        usdcAfter: afterBal?.quoteUsd,
        feeSolBefore: beforeBal?.feeSol,
        feeSolAfter: afterBal?.feeSol,
        txMeta: sent.txMeta,
        cashDeltaUsd: sent.cashDeltaUsd,
      };
    }

    lastReason = sent.reason ?? 'send_failed';
    if (lastReason.startsWith('confirm_timeout')) {
      return {
        ok: false,
        priceUsd: exitPriceUsd,
        signature: sent.signature,
        tokenRawRemaining: remaining,
        ...rawFields,
        reason: lastReason,
        quoteReceivedUsd: proceedsUsd > 0 ? proceedsUsd : undefined,
        usdcBefore: beforeBal?.quoteUsd,
        feeSolBefore: beforeBal?.feeSol,
        txMeta: sent.txMeta,
        cashDeltaUsd: sent.cashDeltaUsd,
      };
    }

    const isSlippage = isSlippageClassSimError(lastReason);
    if (isSlippage) {
      slippageClassAttempts += 1;
      if (args.slippageRetryMultiplier != null && args.slippageRetryMultiplier > 1) {
        currentSlippageBps = multiplySlippageBps({
          currentBps: currentSlippageBps,
          multiplier: args.slippageRetryMultiplier,
          maxBps: args.slippageRetryMaxBps ?? liveCfg.liveSimSlippageRetryMaxBps,
        });
      } else {
        currentSlippageBps = bumpSlippageBps({
          currentBps: currentSlippageBps,
          bumpBps: liveCfg.liveSimSlippageRetryBumpBps,
          maxBps: liveCfg.liveSimSlippageRetryMaxBps,
        });
      }
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
      ...rawFields,
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
