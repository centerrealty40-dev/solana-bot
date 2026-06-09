import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import { appendFollowEvent } from './journal.js';
import { paperInvestedRemainingUsd, paperPnlPctVsAvg } from './paper-pricing.js';
import type { FollowPosition } from './types.js';
import { executeComboBuy, executeComboSell } from '../pumpswap-combo/executor.js';
import { fetchMintSignalPrice } from '../pumpswap-combo/watchlist.js';

export type FollowBuyResult = {
  ok: boolean;
  fillPriceUsd?: number;
  usdAtMarket?: number;
  txSignature?: string;
  reason?: string;
};

export type FollowSellResult = {
  ok: boolean;
  pnlUsd?: number;
  pnlPct?: number;
  txSignature?: string;
  reason?: string;
};

function entrySlippageMult(cfg: PumpswapComboFollowConfig): number {
  return 1 + cfg.slippageBps / 10_000;
}

export async function executeFollowBuy(args: {
  cfg: PumpswapComboFollowConfig;
  mint: string;
  symbol: string;
  poolAddress: string;
  leaderPriceUsd: number;
  intent: 'probe' | 'add';
  leaderSignature: string;
}): Promise<FollowBuyResult> {
  const { cfg, mint, symbol, poolAddress, leaderPriceUsd, intent, leaderSignature } = args;

  if (cfg.executionMode === 'paper') {
    let fill = leaderPriceUsd;
    if (!(fill > 0)) {
      fill = (await fetchMintSignalPrice(mint)) ?? 0;
    }
    if (!(fill > 0)) {
      appendFollowEvent(cfg, {
        kind: 'buy_fail',
        mode: 'paper',
        mint,
        symbol,
        reason: 'no_fill_price',
        leaderSignature,
      });
      return { ok: false, reason: 'no_fill_price' };
    }
    fill *= entrySlippageMult(cfg);
    const usd = cfg.legUsd;
    const sig = `paper_${Date.now()}`;
    return {
      ok: true,
      fillPriceUsd: fill,
      usdAtMarket: usd,
      txSignature: sig,
    };
  }

  const execCfg = toComboExecutorConfig(cfg);
  return executeComboBuy({
    cfg: execCfg,
    mint,
    symbol,
    poolAddress,
    signalPriceUsd: leaderPriceUsd,
    intent,
  });
}

export async function executeFollowSell(args: {
  cfg: PumpswapComboFollowConfig;
  pos: FollowPosition;
  markPriceUsd: number;
  exitReason: string;
  intent: 'tp1_partial' | 'tp2_full' | 'stop_loss';
  sellFrac: number;
}): Promise<FollowSellResult> {
  const { cfg, pos, markPriceUsd, exitReason, intent, sellFrac } = args;
  const inv = paperInvestedRemainingUsd(pos);
  const pnlPct = paperPnlPctVsAvg(pos, markPriceUsd);
  const isFull = intent === 'tp2_full' || intent === 'stop_loss';
  const frac = isFull ? 1 : Math.min(1, Math.max(0.05, sellFrac));

  if (cfg.executionMode === 'paper') {
    const pnlUsd = inv * frac * (pnlPct / 100);
    pos.remainingFrac = Math.max(0, pos.remainingFrac * (1 - frac));
    return { ok: true, pnlUsd, pnlPct, txSignature: `paper_${Date.now()}` };
  }

  const execCfg = toComboExecutorConfig(cfg);
  return executeComboSell({
    cfg: execCfg,
    mint: pos.mint,
    symbol: pos.symbol,
    poolAddress: pos.poolAddress,
    markPriceUsd,
    investedUsd: inv,
    pnlPctAtMark: pnlPct,
    exitReason,
    intent,
    sellFrac: frac,
  });
}
