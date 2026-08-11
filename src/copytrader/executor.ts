import fs from 'node:fs';
import path from 'node:path';
import type { CopyTraderConfig } from './config.js';
import type { EvalResult } from './evaluate.js';
import { executeLiveCopyBuy, executeLiveCopySell } from './live-exec.js';
import { COPY_LEADER_POSITION_SOURCE } from './state.js';

const POSITION_SOURCE = COPY_LEADER_POSITION_SOURCE;

function appendJsonl(journalPath: string, event: Record<string, unknown>): void {
  const dir = path.dirname(journalPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify({ ts: Date.now(), ...event })}\n`, 'utf8');
}

export type BuyExecutionResult = {
  ok: boolean;
  priceUsd: number;
  signature?: string;
  tokenRaw?: string;
  reason?: string;
  /** Jupiter quote USDC spent (buy). */
  quoteSpentUsd?: number;
  usdcBefore?: number;
  usdcAfter?: number;
  feeSolBefore?: number;
  feeSolAfter?: number;
};

export type SellExecutionResult = {
  ok: boolean;
  priceUsd: number;
  signature?: string;
  pnlPct?: number;
  tokenRawRemaining?: string;
  /** Balance the sell sized against (live only) — settlement truth. */
  tokenRawBefore?: string;
  /** Amount actually sent to Jupiter (live only). */
  tokenRawSold?: string;
  reason?: string;
  /** Jupiter quote USDC received (sell). */
  quoteReceivedUsd?: number;
  usdcBefore?: number;
  usdcAfter?: number;
  feeSolBefore?: number;
  feeSolAfter?: number;
};

export async function executeCopyBuy(args: {
  cfg: CopyTraderConfig;
  mint: string;
  symbol: string;
  priceUsd: number;
  sizeUsd: number;
  kind: 'entry' | 'add';
  evalResult: EvalResult;
  leaderSignature: string;
  /** Leader fill price — anchor for the post-quote premium guard. */
  leaderPriceUsd?: number;
  /** Leader buy timestamp — selects first-shot vs steady premium cap. */
  leaderBuyTs?: number;
}): Promise<BuyExecutionResult> {
  const { cfg, mint, symbol, priceUsd, sizeUsd, kind, evalResult, leaderSignature } = args;

  if (cfg.executionMode === 'paper' || cfg.executionMode === 'dry_run') {
    const tokenRaw =
      priceUsd > 0
        ? BigInt(Math.floor((sizeUsd / priceUsd) * 1_000_000)).toString()
        : undefined;
    appendJsonl(cfg.journalPath, {
      kind: kind === 'add' ? 'copy_add' : 'copy_buy',
      mode: cfg.executionMode,
      positionSource: POSITION_SOURCE,
      mint,
      symbol,
      sizeUsd,
      priceUsd,
      eval: evalResult,
      leaderSignature,
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

  if (cfg.executionMode === 'live') {
    const live = await executeLiveCopyBuy({
      cfg,
      mint,
      symbol,
      sizeUsd,
      kind,
      leaderSignature,
      leaderPriceUsd: args.leaderPriceUsd ?? 0,
      leaderBuyTs: args.leaderBuyTs ?? 0,
    });
    appendJsonl(cfg.journalPath, {
      kind: kind === 'add' ? 'copy_add' : 'copy_buy',
      mode: 'live',
      positionSource: POSITION_SOURCE,
      mint,
      symbol,
      sizeUsd,
      priceUsd: live.priceUsd || priceUsd,
      eval: evalResult,
      leaderSignature,
      tokenRaw: live.tokenRaw ?? null,
      txSignature: live.signature ?? null,
      ok: live.ok,
      reason: live.reason ?? null,
      quoteSpentUsd: live.quoteSpentUsd ?? null,
      usdcBefore: live.usdcBefore ?? null,
      usdcAfter: live.usdcAfter ?? null,
      feeSolBefore: live.feeSolBefore ?? null,
      feeSolAfter: live.feeSolAfter ?? null,
    });
    return {
      ok: live.ok,
      priceUsd: live.priceUsd || priceUsd,
      signature: live.signature,
      tokenRaw: live.tokenRaw,
      reason: live.reason,
      quoteSpentUsd: live.quoteSpentUsd,
      usdcBefore: live.usdcBefore,
      usdcAfter: live.usdcAfter,
      feeSolBefore: live.feeSolBefore,
      feeSolAfter: live.feeSolAfter,
    };
  }

  return { ok: false, priceUsd, reason: 'unknown_execution_mode' };
}

export async function executeCopySell(args: {
  cfg: CopyTraderConfig;
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  sizeUsd: number;
  fraction: number;
  leaderSignature: string;
  sellDelayMs: number;
  tokenRawBase?: string;
}): Promise<SellExecutionResult> {
  const {
    cfg,
    mint,
    symbol,
    entryPriceUsd,
    exitPriceUsd,
    sizeUsd,
    fraction,
    leaderSignature,
    sellDelayMs,
    tokenRawBase,
  } = args;
  const pnlPct = entryPriceUsd > 0 ? ((exitPriceUsd / entryPriceUsd - 1) * 100) : 0;

  if (cfg.executionMode === 'paper' || cfg.executionMode === 'dry_run') {
    appendJsonl(cfg.journalPath, {
      kind: 'copy_sell',
      mode: cfg.executionMode,
      positionSource: POSITION_SOURCE,
      mint,
      symbol,
      sizeUsd,
      sellFraction: fraction,
      entryPriceUsd,
      exitPriceUsd,
      pnlPct: +pnlPct.toFixed(2),
      leaderSignature,
      sellDelayMs,
      simulated: true,
    });
    return {
      ok: true,
      priceUsd: exitPriceUsd,
      pnlPct,
      signature: cfg.executionMode === 'paper' ? `paper_${Date.now()}` : undefined,
    };
  }

  if (cfg.executionMode === 'live') {
    const live = await executeLiveCopySell({
      cfg,
      mint,
      symbol,
      leaderSignature,
      fraction,
      tokenRawBase,
    });
    const exitPx = live.priceUsd || exitPriceUsd;
    const livePnl = entryPriceUsd > 0 ? ((exitPx / entryPriceUsd - 1) * 100) : pnlPct;
    appendJsonl(cfg.journalPath, {
      kind: 'copy_sell',
      mode: 'live',
      positionSource: POSITION_SOURCE,
      mint,
      symbol,
      sizeUsd,
      sellFraction: fraction,
      entryPriceUsd,
      exitPriceUsd: exitPx,
      pnlPct: +livePnl.toFixed(2),
      leaderSignature,
      sellDelayMs,
      txSignature: live.signature ?? null,
      ok: live.ok,
      reason: live.reason ?? null,
      quoteReceivedUsd: live.quoteReceivedUsd ?? null,
      usdcBefore: live.usdcBefore ?? null,
      usdcAfter: live.usdcAfter ?? null,
      feeSolBefore: live.feeSolBefore ?? null,
      feeSolAfter: live.feeSolAfter ?? null,
    });
    return {
      ok: live.ok,
      priceUsd: exitPx,
      pnlPct: livePnl,
      signature: live.signature,
      tokenRawRemaining: live.tokenRawRemaining,
      tokenRawBefore: live.tokenRawBefore,
      tokenRawSold: live.tokenRawSold,
      reason: live.reason,
      quoteReceivedUsd: live.quoteReceivedUsd,
      usdcBefore: live.usdcBefore,
      usdcAfter: live.usdcAfter,
      feeSolBefore: live.feeSolBefore,
      feeSolAfter: live.feeSolAfter,
    };
  }

  return { ok: false, priceUsd: exitPriceUsd, reason: 'unknown_execution_mode' };
}

export function appendCopyEvent(cfg: CopyTraderConfig, event: Record<string, unknown>): void {
  appendJsonl(cfg.journalPath, event);
}
