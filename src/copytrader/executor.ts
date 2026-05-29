import fs from 'node:fs';
import path from 'node:path';
import type { CopyTraderConfig } from './config.js';
import type { EvalResult } from './evaluate.js';
import { executeLiveCopyBuy, executeLiveCopySell } from './live-exec.js';

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
};

export type SellExecutionResult = {
  ok: boolean;
  priceUsd: number;
  signature?: string;
  pnlPct?: number;
  tokenRawRemaining?: string;
  reason?: string;
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
    const live = await executeLiveCopyBuy({ cfg, mint, symbol, sizeUsd, kind, leaderSignature });
    appendJsonl(cfg.journalPath, {
      kind: kind === 'add' ? 'copy_add' : 'copy_buy',
      mode: 'live',
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
    });
    return {
      ok: live.ok,
      priceUsd: live.priceUsd || priceUsd,
      signature: live.signature,
      tokenRaw: live.tokenRaw,
      reason: live.reason,
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
  } = args;
  const pnlPct = entryPriceUsd > 0 ? ((exitPriceUsd / entryPriceUsd - 1) * 100) : 0;

  if (cfg.executionMode === 'paper' || cfg.executionMode === 'dry_run') {
    appendJsonl(cfg.journalPath, {
      kind: 'copy_sell',
      mode: cfg.executionMode,
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
    const live = await executeLiveCopySell({ cfg, mint, symbol, leaderSignature, fraction });
    const exitPx = live.priceUsd || exitPriceUsd;
    const livePnl = entryPriceUsd > 0 ? ((exitPx / entryPriceUsd - 1) * 100) : pnlPct;
    appendJsonl(cfg.journalPath, {
      kind: 'copy_sell',
      mode: 'live',
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
    });
    return {
      ok: live.ok,
      priceUsd: exitPx,
      pnlPct: livePnl,
      signature: live.signature,
      tokenRawRemaining: live.tokenRawRemaining,
      reason: live.reason,
    };
  }

  return { ok: false, priceUsd: exitPriceUsd, reason: 'unknown_execution_mode' };
}

export function appendCopyEvent(cfg: CopyTraderConfig, event: Record<string, unknown>): void {
  appendJsonl(cfg.journalPath, event);
}
