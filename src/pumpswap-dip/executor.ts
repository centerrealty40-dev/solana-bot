import type { Keypair } from '@solana/web3.js';
import type { PumpswapDipConfig } from './config.js';
import { appendPumpswapDipEvent } from './journal.js';
import { pumpswapDipLiveBridge } from './live-bridge.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import {
  liveBuildUnsignedSwapTx,
  liveFetchBuyQuote,
  liveSellQuoteAndPrepareSnapshot,
} from '../live/jupiter.js';
import { signLiveJupiterSwapBase64 } from '../live/simulate.js';
import { liveSendSignedSwapPipeline } from '../live/phase6-send.js';
import { getSolUsd } from '../papertrader/pricing.js';

let cachedSigner: Keypair | null = null;

function signer(cfg: PumpswapDipConfig): Keypair {
  if (!cachedSigner) {
    const s = cfg.walletSecret?.trim();
    if (!s) throw new Error('PUMPSWAP_DIP_WALLET_SECRET missing');
    cachedSigner = loadLiveKeypairFromSecretEnv(s);
  }
  return cachedSigner;
}

async function sendSwap(
  cfg: PumpswapDipConfig,
  unsignedB64: string,
  meta: Record<string, unknown>,
): Promise<{ ok: boolean; signature?: string; reason?: string }> {
  const liveCfg = pumpswapDipLiveBridge(cfg);
  const signed = signLiveJupiterSwapBase64(unsignedB64, signer(cfg));
  const outcome = await liveSendSignedSwapPipeline({
    cfg: liveCfg,
    signedTxSerializedBase64: signed,
  });
  appendPumpswapDipEvent(cfg, {
    kind: 'execution_result',
    status: outcome.ok ? 'confirmed' : outcome.kind,
    txSignature: outcome.signature ?? null,
    error: outcome.ok ? null : outcome.message,
    ...meta,
  });
  if (outcome.ok) return { ok: true, signature: outcome.signature };
  return { ok: false, reason: outcome.message };
}

export async function executePumpswapDipBuy(args: {
  cfg: PumpswapDipConfig;
  mint: string;
  symbol: string;
  priceUsd: number;
  sizeUsd: number;
  dumpPct: number;
}): Promise<{
  ok: boolean;
  priceUsd: number;
  signature?: string;
  tokenRaw?: string;
  reason?: string;
}> {
  const { cfg, mint, symbol, priceUsd, sizeUsd, dumpPct } = args;

  if (cfg.executionMode === 'paper' || cfg.executionMode === 'dry_run') {
    const tokenRaw =
      priceUsd > 0 ? BigInt(Math.floor((sizeUsd / priceUsd) * 1_000_000)).toString() : undefined;
    appendPumpswapDipEvent(cfg, {
      kind: 'open',
      mode: cfg.executionMode,
      mint,
      symbol,
      sizeUsd,
      priceUsd,
      dumpPct,
      tokenRaw: tokenRaw ?? null,
      simulated: true,
    });
    return {
      ok: true,
      priceUsd,
      tokenRaw,
      signature: cfg.executionMode === 'paper' ? `paper_${Date.now()}` : undefined,
    };
  }

  const liveCfg = pumpswapDipLiveBridge(cfg);
  const solUsd = getSolUsd();
  const userPk = signer(cfg).publicKey.toBase58();
  const quote = await liveFetchBuyQuote({
    cfg: liveCfg,
    outputMint: mint,
    sizeUsd,
    solUsd,
  });
  if (!quote) {
    appendPumpswapDipEvent(cfg, { kind: 'buy_fail', mint, symbol, reason: 'jupiter_buy_quote_failed' });
    return { ok: false, priceUsd: 0, reason: 'jupiter_buy_quote_failed' };
  }

  const build = await liveBuildUnsignedSwapTx({
    cfg: liveCfg,
    quoteResponse: quote.quoteResponse,
    userPublicKey: userPk,
  });
  if (!build.ok) {
    appendPumpswapDipEvent(cfg, { kind: 'buy_fail', mint, symbol, reason: build.reason });
    return { ok: false, priceUsd: 0, reason: build.reason };
  }

  const outRaw = quote.quoteResponse.outAmount;
  const inRaw = quote.quoteResponse.inAmount;
  const outN = typeof outRaw === 'string' ? Number(outRaw) : Number(outRaw ?? 0);
  const inN = typeof inRaw === 'string' ? Number(inRaw) : Number(inRaw ?? 0);
  const fillPriceUsd = outN > 0 && inN > 0 ? (inN / 1e9) * solUsd / (outN / 1e6) : priceUsd;

  const sent = await sendSwap(cfg, build.b64, {
    side: 'buy',
    mint,
    symbol,
    sizeUsd,
    dumpPct,
    quoteSnapshot: quote.quoteSnapshot,
  });
  if (!sent.ok) {
    appendPumpswapDipEvent(cfg, { kind: 'buy_fail', mint, symbol, reason: sent.reason ?? 'send_failed' });
    return { ok: false, priceUsd: fillPriceUsd, reason: sent.reason };
  }

  appendPumpswapDipEvent(cfg, {
    kind: 'open',
    mode: 'live',
    mint,
    symbol,
    sizeUsd,
    priceUsd: fillPriceUsd,
    dumpPct,
    tokenRaw: outRaw != null ? String(outRaw) : null,
    txSignature: sent.signature ?? null,
  });

  return {
    ok: true,
    priceUsd: fillPriceUsd,
    signature: sent.signature,
    tokenRaw: outRaw != null ? String(outRaw) : undefined,
  };
}

export async function executePumpswapDipSell(args: {
  cfg: PumpswapDipConfig;
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  sizeUsd: number;
  exitReason: string;
  tokenRaw?: string;
}): Promise<{ ok: boolean; priceUsd: number; signature?: string; pnlPct?: number; reason?: string }> {
  const { cfg, mint, symbol, entryPriceUsd, exitPriceUsd, sizeUsd, exitReason, tokenRaw } = args;
  const pnlPct = entryPriceUsd > 0 ? ((exitPriceUsd / entryPriceUsd - 1) * 100) : 0;
  const pnlUsd = sizeUsd * (pnlPct / 100);

  if (cfg.executionMode === 'paper' || cfg.executionMode === 'dry_run') {
    appendPumpswapDipEvent(cfg, {
      kind: 'close',
      mode: cfg.executionMode,
      mint,
      symbol,
      entryPriceUsd,
      exitPriceUsd,
      sizeUsd,
      pnlPct,
      pnlUsd,
      exitReason,
      simulated: true,
    });
    return { ok: true, priceUsd: exitPriceUsd, pnlPct };
  }

  const liveCfg = pumpswapDipLiveBridge(cfg);
  const solUsd = getSolUsd();
  const userPk = signer(cfg).publicKey.toBase58();
  const raw = tokenRaw ? BigInt(tokenRaw) : 0n;
  if (raw <= 0n) {
    appendPumpswapDipEvent(cfg, { kind: 'sell_fail', mint, symbol, reason: 'no_token_balance' });
    return { ok: false, priceUsd: exitPriceUsd, reason: 'no_token_balance' };
  }

  const prep = await liveSellQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    inputMint: mint,
    tokenAmountRaw: raw.toString(),
    solUsd,
    userPublicKey: userPk,
  });
  if (!prep) {
    appendPumpswapDipEvent(cfg, { kind: 'sell_fail', mint, symbol, reason: 'jupiter_sell_quote_failed' });
    return { ok: false, priceUsd: exitPriceUsd, reason: 'jupiter_sell_quote_failed' };
  }
  if (!prep.swapBuild.ok) {
    appendPumpswapDipEvent(cfg, { kind: 'sell_fail', mint, symbol, reason: prep.swapBuild.reason });
    return { ok: false, priceUsd: exitPriceUsd, reason: prep.swapBuild.reason };
  }

  const outRaw = prep.quoteResponse.outAmount;
  const outLamports = typeof outRaw === 'string' ? Number(outRaw) : Number(outRaw ?? 0);
  const proceedsUsd = outLamports > 0 ? (outLamports / 1e9) * solUsd : 0;
  const tokensSold = Number(raw) / 1e6;
  const fillExitUsd = tokensSold > 0 && proceedsUsd > 0 ? proceedsUsd / tokensSold : exitPriceUsd;

  const sent = await sendSwap(cfg, prep.swapBuild.b64, {
    side: 'sell',
    mint,
    symbol,
    exitReason,
    quoteSnapshot: prep.quoteSnapshot,
  });
  if (!sent.ok) {
    appendPumpswapDipEvent(cfg, { kind: 'sell_fail', mint, symbol, reason: sent.reason ?? 'send_failed' });
    return { ok: false, priceUsd: fillExitUsd, reason: sent.reason };
  }

  appendPumpswapDipEvent(cfg, {
    kind: 'close',
    mode: 'live',
    mint,
    symbol,
    entryPriceUsd,
    exitPriceUsd: fillExitUsd,
    sizeUsd,
    pnlPct,
    pnlUsd,
    exitReason,
    txSignature: sent.signature ?? null,
  });

  return {
    ok: sent.ok,
    priceUsd: fillExitUsd,
    signature: sent.signature,
    pnlPct,
  };
}
