import type { Keypair } from '@solana/web3.js';
import type { PumpswapComboConfig } from './config.js';
import { appendComboEvent } from './journal.js';
import { comboLiveBridge } from './live-bridge.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import { liveSendSignedSwapPipeline } from '../live/phase6-send.js';
import { fetchLiveWalletSplBalancesByMint } from '../live/reconcile-live.js';
import { fetchMintPoolAddress } from './watchlist.js';
import {
  buildPumpSwapBuyTx,
  buildPumpSwapSellTx,
  fillPriceUsdFromTokenDelta,
  quotePumpSwapExitPriceUsd,
} from './pumpswap-direct.js';

let cachedSigner: Keypair | null = null;

function liveRpcUrl(cfg: PumpswapComboConfig, liveCfg: ReturnType<typeof comboLiveBridge>): string {
  return liveCfg.liveRpcHttpUrl?.trim() || cfg.rpcUrl.trim();
}

function priorityLamports(liveCfg: ReturnType<typeof comboLiveBridge>): number {
  return liveCfg.liveJupiterPriorityMaxLamports ?? 100_000;
}

function signer(cfg: PumpswapComboConfig): Keypair {
  if (!cachedSigner) {
    const s = cfg.walletSecret?.trim();
    if (!s) throw new Error('wallet secret missing');
    cachedSigner = loadLiveKeypairFromSecretEnv(s);
  }
  return cachedSigner;
}

async function resolvePoolAddress(mint: string, poolAddress?: string): Promise<string | null> {
  const direct = poolAddress?.trim();
  if (direct) return direct;
  return fetchMintPoolAddress(mint);
}

export async function executeComboBuy(args: {
  cfg: PumpswapComboConfig;
  mint: string;
  symbol: string;
  poolAddress: string;
  signalPriceUsd: number;
  intent: 'probe' | 'add';
  dumpPct?: number;
  dipFromPeakPct?: number;
}): Promise<{ ok: boolean; fillPriceUsd?: number; txSignature?: string; reason?: string }> {
  const { cfg, mint, symbol, signalPriceUsd, intent } = args;
  const liveCfg = comboLiveBridge(cfg);
  const pk = signer(cfg);

  const pool = await resolvePoolAddress(mint, args.poolAddress);
  if (!pool) {
    appendComboEvent(cfg, { kind: 'buy_fail', mint, symbol, intent, reason: 'no_pool' });
    return { ok: false, reason: 'no_pool' };
  }

  const balancesBefore = await fetchLiveWalletSplBalancesByMint(liveCfg);
  const tokenBefore = balancesBefore?.get(mint) ?? 0n;

  let built: Awaited<ReturnType<typeof buildPumpSwapBuyTx>> = null;
  let slippageBps = cfg.slippageBps;
  const maxSlippage = Math.min(800, cfg.slippageBps + cfg.slippageBps);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      built = await buildPumpSwapBuyTx({
        rpcUrl: liveRpcUrl(cfg, liveCfg),
        poolAddress: pool,
        payer: pk,
        legUsd: cfg.legUsd,
        slippageBps,
        priorityMaxLamports: priorityLamports(liveCfg),
      });
      if (built) break;
    } catch (err) {
      if (attempt >= 2) {
        const reason = (err as Error).message?.slice(0, 200) ?? 'build_error';
        appendComboEvent(cfg, { kind: 'buy_fail', mint, symbol, intent, reason });
        return { ok: false, reason };
      }
    }
    slippageBps = Math.min(maxSlippage, slippageBps + 50);
  }

  if (!built) {
    appendComboEvent(cfg, { kind: 'buy_fail', mint, symbol, intent, reason: 'build_tx' });
    return { ok: false, reason: 'build_tx' };
  }

  const sent = await liveSendSignedSwapPipeline({
    cfg: liveCfg,
    signedTxSerializedBase64: built.signedB64,
  });

  let fillPriceUsd = signalPriceUsd;
  if (sent.ok) {
    const balancesAfter = await fetchLiveWalletSplBalancesByMint(liveCfg);
    const tokenAfter = balancesAfter?.get(mint) ?? 0n;
    fillPriceUsd = fillPriceUsdFromTokenDelta({
      legUsd: cfg.legUsd,
      tokenBefore,
      tokenAfter,
      decimals: built.decimals,
      fallbackPriceUsd: signalPriceUsd,
    });
  }

  appendComboEvent(cfg, {
    kind: sent.ok ? 'buy_ok' : 'buy_fail',
    mint,
    symbol,
    intent,
    usd: cfg.legUsd,
    fillPriceUsd,
    poolAddress: pool,
    execVenue: 'pumpswap_direct',
    dumpPct: args.dumpPct ?? null,
    dipFromPeakPct: args.dipFromPeakPct ?? null,
    txSignature: sent.ok ? sent.signature : null,
    error: sent.ok ? null : sent.message,
  });

  if (!sent.ok) return { ok: false, reason: sent.message, fillPriceUsd };
  return { ok: true, fillPriceUsd, txSignature: sent.signature };
}

export async function executeComboSell(args: {
  cfg: PumpswapComboConfig;
  mint: string;
  symbol: string;
  poolAddress?: string;
  markPriceUsd: number;
  investedUsd: number;
  pnlPctAtMark: number;
  exitReason: string;
  intent: 'tp1_partial' | 'tp2_full' | 'stop_loss' | 'portfolio_halt';
  sellFrac?: number;
}): Promise<{ ok: boolean; pnlUsd?: number; pnlPct?: number; reason?: string; txSignature?: string }> {
  const { cfg, mint, symbol, markPriceUsd, investedUsd, pnlPctAtMark, exitReason, intent } = args;
  const liveCfg = comboLiveBridge(cfg);
  const isFull = intent === 'tp2_full' || intent === 'stop_loss' || intent === 'portfolio_halt';
  const frac = isFull ? 1 : Math.min(1, Math.max(0.05, args.sellFrac ?? cfg.tp1SellFrac));

  const pool = await resolvePoolAddress(mint, args.poolAddress);
  if (!pool) {
    appendComboEvent(cfg, { kind: 'sell_fail', mint, symbol, exitReason, reason: 'no_pool' });
    return { ok: false, reason: 'no_pool' };
  }

  const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
  const raw = chainMap?.get(mint) ?? 0n;
  if (raw <= 0n) {
    appendComboEvent(cfg, { kind: 'sell_fail', mint, symbol, exitReason, reason: 'no_balance' });
    return { ok: false, reason: 'no_balance' };
  }

  const sellRaw = isFull ? raw : (raw * BigInt(Math.floor(frac * 10_000))) / 10_000n;
  if (sellRaw <= 0n) {
    appendComboEvent(cfg, { kind: 'sell_fail', mint, symbol, exitReason, reason: 'zero_sell_amount' });
    return { ok: false, reason: 'zero_sell_amount' };
  }

  const pnlUsd = investedUsd * frac * (pnlPctAtMark / 100);

  let built: Awaited<ReturnType<typeof buildPumpSwapSellTx>> = null;
  let slippageBps = cfg.slippageBps;
  const maxSlippage = Math.min(800, cfg.slippageBps + cfg.slippageBps);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      built = await buildPumpSwapSellTx({
        rpcUrl: liveRpcUrl(cfg, liveCfg),
        poolAddress: pool,
        payer: signer(cfg),
        baseAmountRaw: sellRaw,
        slippageBps,
        priorityMaxLamports: priorityLamports(liveCfg),
      });
      if (built) break;
    } catch (err) {
      if (attempt >= 2) {
        appendComboEvent(cfg, {
          kind: 'sell_fail',
          mint,
          symbol,
          exitReason,
          intent,
          reason: (err as Error).message?.slice(0, 200) ?? 'build_error',
        });
        return { ok: false, reason: 'build_error' };
      }
    }
    slippageBps = Math.min(maxSlippage, slippageBps + 50);
  }

  if (!built) {
    appendComboEvent(cfg, {
      kind: 'sell_fail',
      mint,
      symbol,
      exitReason,
      intent,
      reason: 'build_tx',
    });
    return { ok: false, reason: 'build_tx' };
  }

  const sent = await liveSendSignedSwapPipeline({
    cfg: liveCfg,
    signedTxSerializedBase64: built.signedB64,
  });

  if (!sent.ok) {
    appendComboEvent(cfg, {
      kind: 'sell_fail',
      mint,
      symbol,
      exitReason,
      intent,
      reason: sent.message,
      execVenue: 'pumpswap_direct',
    });
    return { ok: false, reason: sent.message };
  }

  appendComboEvent(cfg, {
    kind: isFull ? 'close' : 'partial_sell',
    mint,
    symbol,
    exitReason,
    intent,
    sellFrac: frac,
    markPriceUsd,
    investedUsd,
    pnlUsd,
    pnlPct: pnlPctAtMark,
    poolAddress: pool,
    execVenue: 'pumpswap_direct',
    txSignature: sent.signature,
  });

  return { ok: true, pnlUsd, pnlPct: pnlPctAtMark, txSignature: sent.signature };
}

/** PumpSwap pool sell quote — same venue as execution. */
export async function quoteSellProceedsUsd(
  cfg: PumpswapComboConfig,
  mint: string,
  poolAddress: string,
  tokenRaw: bigint,
): Promise<number | null> {
  if (tokenRaw <= 0n) return null;
  const liveCfg = comboLiveBridge(cfg);
  const pool = await resolvePoolAddress(mint, poolAddress);
  if (!pool) return null;
  const rpcUrl = liveRpcUrl(cfg, liveCfg);
  const pk = signer(cfg).publicKey;
  const q = await quotePumpSwapExitPriceUsd({
    rpcUrl,
    poolAddress: pool,
    tokenRaw,
    user: pk,
  });
  if (!(q.priceUsd != null && q.priceUsd > 0)) return null;
  const tokens = Number(tokenRaw) / 10 ** q.decimals;
  return tokens * q.priceUsd;
}
