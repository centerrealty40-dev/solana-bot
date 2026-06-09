import type { Keypair } from '@solana/web3.js';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import type { PumpswapComboConfig } from './config.js';
import { appendComboEvent } from './journal.js';
import { comboLiveBridge } from './live-bridge.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import { liveSendSignedSwapPipeline } from '../live/phase6-send.js';
import { fetchLiveWalletSplBalancesByMint } from '../live/reconcile-live.js';
import { resolveMintPumpPool } from './pool-resolve.js';
import {
  buildPumpSwapBuyTx,
  buildPumpSwapSellTx,
  quotePumpSwapExitPriceUsd,
  signPumpSwapInstructions,
} from './pumpswap-direct.js';
import { ensureComboSolUsd } from './sol-oracle.js';
import { fillFromChainAndTokens, walletSolSpentFromTx } from './chain-fill.js';

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

async function resolvePoolAddress(cfg: PumpswapComboConfig, mint: string, poolAddress?: string): Promise<string | null> {
  const direct = poolAddress?.trim();
  if (direct) return direct;
  const rpc = liveRpcUrl(cfg, comboLiveBridge(cfg));
  return resolveMintPumpPool(rpc, mint);
}

function isStaleBlockhashError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('blockhash not found') || m.includes('blockhash expired');
}

function isSlippageSimError(message: string): boolean {
  return message.includes('6023') || message.includes('6058') || message.includes('6001');
}

async function connectionSimOk(rpcUrl: string, signedB64: string): Promise<{ ok: boolean; message?: string }> {
  const conn = new Connection(rpcUrl, 'confirmed');
  const vtx = VersionedTransaction.deserialize(Buffer.from(signedB64, 'base64'));
  const sim = await conn.simulateTransaction(vtx, { sigVerify: true, commitment: 'processed' });
  if (sim.value.err) {
    return { ok: false, message: `sim_failed:${JSON.stringify(sim.value.err)}` };
  }
  return { ok: true };
}

async function signAndSendPumpSwap(args: {
  liveCfg: ReturnType<typeof comboLiveBridge>;
  rpcUrl: string;
  payer: Keypair;
  swapIxs: import('@solana/web3.js').TransactionInstruction[];
}): Promise<Awaited<ReturnType<typeof liveSendSignedSwapPipeline>>> {
  const priority = priorityLamports(args.liveCfg);
  for (let attempt = 0; attempt < 3; attempt++) {
    const signedB64 = await signPumpSwapInstructions({
      rpcUrl: args.rpcUrl,
      payer: args.payer,
      instructions: args.swapIxs,
      priorityMaxLamports: priority,
    });
    const sim = await connectionSimOk(args.rpcUrl, signedB64);
    if (!sim.ok) {
      if (attempt < 2 && isStaleBlockhashError(sim.message ?? '')) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return { ok: false, kind: 'sim_err', message: sim.message ?? 'sim_failed' };
    }
    const sent = await liveSendSignedSwapPipeline({
      cfg: args.liveCfg,
      signedTxSerializedBase64: signedB64,
    });
    if (sent.ok || !isStaleBlockhashError(sent.message)) return sent;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return { ok: false, kind: 'sim_err', message: 'blockhash_retry_exhausted' };
}

export async function executeComboBuy(args: {
  cfg: PumpswapComboConfig;
  mint: string;
  symbol: string;
  poolAddress: string;
  signalPriceUsd: number;
  intent: 'probe' | 'add' | 'shadow_probe' | 'shadow_add';
  dumpPct?: number;
  dipFromPeakPct?: number;
}): Promise<{
  ok: boolean;
  fillPriceUsd?: number;
  usdAtMarket?: number;
  solSpent?: number;
  tokensReceived?: number;
  txSignature?: string;
  reason?: string;
}> {
  const { cfg, mint, symbol, signalPriceUsd, intent } = args;
  const liveCfg = comboLiveBridge(cfg);
  const pk = signer(cfg);
  const rpcUrl = liveRpcUrl(cfg, liveCfg);

  const pool = await resolvePoolAddress(cfg, mint, args.poolAddress);
  if (!pool) {
    appendComboEvent(cfg, { kind: 'buy_fail', mint, symbol, intent, reason: 'no_pool' });
    return { ok: false, reason: 'no_pool' };
  }

  const solUsdAtFill = await ensureComboSolUsd(true);

  const balancesBefore = await fetchLiveWalletSplBalancesByMint(liveCfg);
  const tokenBefore = balancesBefore?.get(mint) ?? 0n;

  let built: Awaited<ReturnType<typeof buildPumpSwapBuyTx>> = null;
  let slippageBps = cfg.slippageBps;
  const maxSlippage = Math.min(800, cfg.slippageBps + cfg.slippageBps);
  let sent: Awaited<ReturnType<typeof signAndSendPumpSwap>> = {
    ok: false,
    kind: 'sim_err',
    message: 'build_tx_or_non_wsol_pool',
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      built = await buildPumpSwapBuyTx({
        rpcUrl: liveRpcUrl(cfg, liveCfg),
        poolAddress: pool,
        payer: pk,
        legUsd: cfg.legUsd,
        slippageBps,
      });
      if (!built) break;
      sent = await signAndSendPumpSwap({
        liveCfg,
        rpcUrl,
        payer: pk,
        swapIxs: built.swapIxs,
      });
      if (sent.ok || !isSlippageSimError(sent.message)) break;
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
    appendComboEvent(cfg, { kind: 'buy_fail', mint, symbol, intent, reason: 'build_tx_or_non_wsol_pool' });
    return { ok: false, reason: 'build_tx_or_non_wsol_pool' };
  }

  let fillPriceUsd = signalPriceUsd;
  let usdAtMarket = 0;
  let solSpent = 0;
  let tokensReceived = 0;
  if (sent.ok && sent.signature) {
    const balancesAfter = await fetchLiveWalletSplBalancesByMint(liveCfg);
    const tokenAfter = balancesAfter?.get(mint) ?? 0n;
    const chain = await walletSolSpentFromTx({
      rpcUrl,
      wallet: pk.publicKey,
      signature: sent.signature,
    });
    if (chain) {
      const fill = fillFromChainAndTokens({
        solSpent: chain.solSpent,
        solUsd: solUsdAtFill,
        tokenBefore,
        tokenAfter,
        decimals: built.decimals,
        fallbackPriceUsd: signalPriceUsd,
      });
      fillPriceUsd = fill.fillPriceUsd;
      usdAtMarket = fill.usdAtMarket;
      solSpent = fill.solSpent;
      tokensReceived = fill.tokensReceived;
    }
  }

  appendComboEvent(cfg, {
    kind: sent.ok ? 'buy_ok' : 'buy_fail',
    mint,
    symbol,
    intent,
    targetLegUsd: cfg.legUsd,
    usd: usdAtMarket > 0 ? usdAtMarket : cfg.legUsd,
    solSpent: solSpent > 0 ? solSpent : null,
    solUsdAtFill,
    quoteLamports: built.quoteLamports.toString(),
    tokensReceived: tokensReceived > 0 ? tokensReceived : null,
    fillPriceUsd,
    poolAddress: pool,
    execVenue: 'pumpswap_direct',
    dumpPct: args.dumpPct ?? null,
    dipFromPeakPct: args.dipFromPeakPct ?? null,
    txSignature: sent.ok ? sent.signature : null,
    error: sent.ok ? null : sent.message,
  });

  if (!sent.ok) return { ok: false, reason: sent.message, fillPriceUsd };
  return {
    ok: true,
    fillPriceUsd,
    usdAtMarket: usdAtMarket > 0 ? usdAtMarket : cfg.legUsd,
    solSpent,
    tokensReceived,
    txSignature: sent.signature,
  };
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

  const pool = await resolvePoolAddress(cfg, mint, args.poolAddress);
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
  let sent: Awaited<ReturnType<typeof signAndSendPumpSwap>> = {
    ok: false,
    kind: 'sim_err',
    message: 'build_tx_or_non_wsol_pool',
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      built = await buildPumpSwapSellTx({
        rpcUrl: liveRpcUrl(cfg, liveCfg),
        poolAddress: pool,
        payer: signer(cfg),
        baseAmountRaw: sellRaw,
        slippageBps,
      });
      if (!built) break;
      sent = await signAndSendPumpSwap({
        liveCfg,
        rpcUrl: liveRpcUrl(cfg, liveCfg),
        payer: signer(cfg),
        swapIxs: built.swapIxs,
      });
      if (sent.ok || !isSlippageSimError(sent.message)) break;
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
      reason: 'build_tx_or_non_wsol_pool',
    });
    return { ok: false, reason: 'build_tx_or_non_wsol_pool' };
  }

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
  const pool = await resolvePoolAddress(cfg, mint, poolAddress);
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
