import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { child } from '../core/logger.js';
import { estimatePaperFill } from './jupiter-sim.js';
import { openPosition, applyExit } from './position-store.js';
import { QUOTE_MINTS } from '../core/constants.js';
import { notifyEntry, notifyExit } from './telegram.js';
import type { ExitSignal, HypothesisPositionView, HypothesisSignal } from '../hypotheses/base.js';

const log = child('paper-executor');

/**
 * Decimals lookup helper — cheap cache. We default to 6 (most SPL tokens we care about)
 * if we don't have it cached. The Jupiter quote uses raw amounts, so a wrong decimals
 * estimate just affects our sizing but not P&L correctness.
 */
const decimalsCache = new Map<string, number>();

async function getDecimals(mint: string): Promise<number> {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint)!;
  const rows = await db
    .select({ decimals: schema.tokens.decimals })
    .from(schema.tokens)
    .where(dsql`${schema.tokens.mint} = ${mint}`);
  const d = rows[0]?.decimals ?? 6;
  decimalsCache.set(mint, d || 6);
  return d || 6;
}

export async function executePaperEntry(
  signal: HypothesisSignal,
  midPriceUsd: number,
  approvedSizeUsd: number,
): Promise<bigint | null> {
  if (signal.side !== 'buy') {
    log.warn({ signal }, 'paper executor only supports buy entries');
    return null;
  }
  const decimals = await getDecimals(signal.baseMint);
  const fill = await estimatePaperFill({
    side: 'buy',
    baseMint: signal.baseMint,
    sizeUsd: approvedSizeUsd,
    midPriceUsd,
    decimals,
  });
  const positionId = await openPosition({
    hypothesisId: signal.hypothesisId,
    mode: 'paper',
    baseMint: signal.baseMint,
    quoteMint: QUOTE_MINTS.USDC,
    sizeUsd: approvedSizeUsd,
    entryPriceUsd: fill.fillPriceUsd,
    baseAmountRaw: fill.outAmountRaw,
    quoteAmountRaw: fill.inAmountRaw,
    slippageBps: fill.slippageBps,
    feeUsd: fill.feeUsd,
    signature: null,
    signalMeta: signal.meta,
  });
  log.info(
    {
      hypothesisId: signal.hypothesisId,
      positionId: String(positionId),
      mint: signal.baseMint,
      sizeUsd: approvedSizeUsd,
      entryPrice: fill.fillPriceUsd,
      slippageBps: fill.slippageBps,
    },
    'paper entry filled',
  );
  void notifyEntry({
    hypothesisId: signal.hypothesisId,
    positionId,
    baseMint: signal.baseMint,
    sizeUsd: approvedSizeUsd,
    entryPriceUsd: fill.fillPriceUsd,
    slippageBps: fill.slippageBps,
    feeUsd: fill.feeUsd,
    reason: signal.reason,
  });
  return positionId;
}

export async function executePaperExit(
  pos: HypothesisPositionView,
  exit: ExitSignal,
  midPriceUsd: number,
): Promise<void> {
  const decimals = await getDecimals(pos.baseMint);
  const fraction = Math.min(Math.max(exit.fraction, 0), 1);
  const fill = await estimatePaperFill({
    side: 'sell',
    baseMint: pos.baseMint,
    sizeUsd: pos.sizeUsd * fraction,
    baseAmountRaw: scaleBigInt(pos.baseAmountRaw, fraction),
    midPriceUsd,
    decimals,
  });
  const updated = await applyExit({
    positionId: pos.positionId,
    fraction,
    exitPriceUsd: fill.fillPriceUsd,
    slippageBps: fill.slippageBps,
    feeUsd: fill.feeUsd,
    signature: null,
    reason: exit.reason,
  });
  log.info(
    {
      hypothesisId: pos.hypothesisId,
      positionId: String(pos.positionId),
      mint: pos.baseMint,
      fraction,
      exitPrice: fill.fillPriceUsd,
      realizedPnl: updated.realizedPnlUsd,
      reason: exit.reason,
    },
    'paper exit filled',
  );
  // PnL contributed by THIS exit only (mirrors applyExit's internal formula)
  const tradePnl =
    pos.sizeUsd * fraction * (fill.fillPriceUsd / Math.max(pos.entryPriceUsd, 1e-12) - 1) -
    fill.feeUsd;
  void notifyExit({
    hypothesisId: pos.hypothesisId,
    positionId: pos.positionId,
    baseMint: pos.baseMint,
    fraction,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd: fill.fillPriceUsd,
    realizedPnlUsd: tradePnl,
    totalPnlUsd: updated.realizedPnlUsd,
    heldMs: Date.now() - pos.openedAt.getTime(),
    closed: updated.status === 'closed',
    reason: exit.reason,
  });
  // Update daily PnL aggregate
  if (updated.status === 'closed') {
    const day = new Date().toISOString().slice(0, 10);
    const won = updated.realizedPnlUsd > 0 ? 1 : 0;
    await db
      .insert(schema.dailyPnl)
      .values({
        hypothesisId: pos.hypothesisId,
        day,
        mode: 'paper',
        realizedPnlUsd: updated.realizedPnlUsd,
        tradesCount: 1,
        winsCount: won,
      })
      .onConflictDoUpdate({
        target: [schema.dailyPnl.hypothesisId, schema.dailyPnl.day, schema.dailyPnl.mode],
        set: {
          realizedPnlUsd: dsql`${schema.dailyPnl.realizedPnlUsd} + EXCLUDED.realized_pnl_usd`,
          tradesCount: dsql`${schema.dailyPnl.tradesCount} + 1`,
          winsCount: dsql`${schema.dailyPnl.winsCount} + EXCLUDED.wins_count`,
        },
      });
  }
}

function scaleBigInt(amount: bigint, fraction: number): bigint {
  if (fraction >= 1) return amount;
  if (fraction <= 0) return 0n;
  const factor = BigInt(Math.round(fraction * 1_000_000_000));
  return (amount * factor) / 1_000_000_000n;
}
