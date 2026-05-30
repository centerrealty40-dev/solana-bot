import type { Keypair } from '@solana/web3.js';
import type { CopyTraderConfig } from './config.js';
import { copyTraderLiveOscarBridge } from './live-bridge.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import {
  liveBuildUnsignedSwapTx,
  liveFetchBuyQuote,
  liveSellQuoteAndPrepareSnapshot,
} from '../live/jupiter.js';
import { signLiveJupiterSwapBase64 } from '../live/simulate.js';
import { liveSendSignedSwapPipeline } from '../live/phase6-send.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { rpcCall } from './rpc.js';
import { appendCopyEvent } from './executor.js';
import { isFullCloseFraction, scaleTokenRaw } from './proportional.js';

let cachedSigner: Keypair | null = null;

function signer(cfg: CopyTraderConfig): Keypair {
  if (!cachedSigner) {
    const s = cfg.walletSecret?.trim();
    if (!s) throw new Error('COPY_TRADER_WALLET_SECRET missing');
    cachedSigner = loadLiveKeypairFromSecretEnv(s);
  }
  return cachedSigner;
}

async function fetchMintBalanceRaw(cfg: CopyTraderConfig, mint: string): Promise<string | null> {
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
}): Promise<{ ok: boolean; priceUsd: number; signature?: string; tokenRaw?: string; reason?: string }> {
  const { cfg, mint, symbol, sizeUsd, kind, leaderSignature } = args;
  const liveCfg = copyTraderLiveOscarBridge(cfg);
  const solUsd = getSolUsd();
  const userPk = signer(cfg).publicKey.toBase58();

  const quote = await liveFetchBuyQuote({
    cfg: liveCfg,
    outputMint: mint,
    sizeUsd,
    solUsd,
  });
  if (!quote) {
    return { ok: false, priceUsd: 0, reason: 'jupiter_buy_quote_failed' };
  }

  const build = await liveBuildUnsignedSwapTx({
    cfg: liveCfg,
    quoteResponse: quote.quoteResponse,
    userPublicKey: userPk,
  });
  if (!build.ok) {
    return { ok: false, priceUsd: 0, reason: build.reason };
  }

  const outRaw = quote.quoteResponse.outAmount;
  const inRaw = quote.quoteResponse.inAmount;
  const outN = typeof outRaw === 'string' ? Number(outRaw) : Number(outRaw ?? 0);
  const inN = typeof inRaw === 'string' ? Number(inRaw) : Number(inRaw ?? 0);
  const priceUsd = outN > 0 && inN > 0 ? (inN / 1e9) * solUsd / (outN / 1e6) : 0;

  const sent = await sendSwap(cfg, build.b64, {
    side: 'buy',
    mint,
    symbol,
    sizeUsd,
    kind,
    leaderSignature,
    quoteSnapshot: quote.quoteSnapshot,
  });

  return { ok: sent.ok, priceUsd, signature: sent.signature, tokenRaw: outRaw != null ? String(outRaw) : undefined, reason: sent.reason };
}

export async function executeLiveCopySell(args: {
  cfg: CopyTraderConfig;
  mint: string;
  symbol: string;
  leaderSignature: string;
  fraction: number;
}): Promise<{ ok: boolean; priceUsd: number; signature?: string; tokenRawRemaining?: string; reason?: string }> {
  const { cfg, mint, symbol, leaderSignature, fraction } = args;
  const liveCfg = copyTraderLiveOscarBridge(cfg);
  const solUsd = getSolUsd();
  const userPk = signer(cfg).publicKey.toBase58();

  const tokenRaw = await fetchMintBalanceRaw(cfg, mint);
  if (!tokenRaw) {
    return { ok: false, priceUsd: 0, reason: 'no_token_balance' };
  }

  const totalRaw = BigInt(tokenRaw);
  const sellRaw = isFullCloseFraction(fraction) ? totalRaw : scaleTokenRaw(totalRaw, fraction);
  if (sellRaw <= 0n) {
    return { ok: false, priceUsd: 0, reason: 'sell_amount_zero' };
  }

  const prep = await liveSellQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    inputMint: mint,
    tokenAmountRaw: sellRaw.toString(),
    solUsd,
    userPublicKey: userPk,
  });
  if (!prep) {
    return { ok: false, priceUsd: 0, reason: 'jupiter_sell_quote_failed' };
  }
  if (!prep.swapBuild.ok) {
    return { ok: false, priceUsd: 0, reason: prep.swapBuild.reason };
  }

  const outRaw = prep.quoteResponse.outAmount;
  const outLamports = typeof outRaw === 'string' ? Number(outRaw) : Number(outRaw ?? 0);
  const proceedsUsd = outLamports > 0 ? (outLamports / 1e9) * solUsd : 0;
  // Per-token exit price (same 6-decimal assumption as executeLiveCopyBuy), not total proceeds.
  const tokensSold = Number(sellRaw) / 1e6;
  const exitPriceUsd = tokensSold > 0 && proceedsUsd > 0 ? proceedsUsd / tokensSold : 0;

  const sent = await sendSwap(cfg, prep.swapBuild.b64, {
    side: 'sell',
    mint,
    symbol,
    leaderSignature,
    sellFraction: fraction,
    tokenAmountRaw: sellRaw.toString(),
    quoteSnapshot: prep.quoteSnapshot,
  });

  const remaining = totalRaw > sellRaw ? (totalRaw - sellRaw).toString() : '0';

  return {
    ok: sent.ok,
    priceUsd: exitPriceUsd,
    signature: sent.signature,
    tokenRawRemaining: remaining,
    reason: sent.reason,
  };
}
