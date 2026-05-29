/**
 * dca_frontrun — paper trading engine (state machine + accounting).
 * NEVER signs or sends transactions. Simulates fills at the live market price and persists
 * positions, fills and an equity curve. See config.ts for the agreed trading spec.
 */
import { dcabotConfig as cfg } from './config.js';
import {
  listActivePositions,
  recordFill,
  savePosition,
  snapshotEquity,
  pgSql,
  type DcabotPosition,
} from './db.js';
import { getPriceUsd, getTokenMarket, estimateGainPct } from './market.js';
import { scoreToken } from './scorer.js';
import { cycleProgress } from './vault.js';

function applyBuy(p: DcabotPosition, price: number, usd: number): { qty: number } {
  const qty = price > 0 ? usd / price : 0;
  p.qtyToken += qty;
  p.costUsd += usd;
  p.avgEntryPrice = p.qtyToken > 0 ? p.costUsd / p.qtyToken : 0;
  if (p.costUsd > p.maxCapitalUsd) p.maxCapitalUsd = p.costUsd;
  return { qty };
}

function applySell(p: DcabotPosition, price: number, qty: number): { usd: number; realized: number } {
  const sellQty = Math.min(qty, p.qtyToken);
  const proceeds = sellQty * price;
  const costPortion = p.avgEntryPrice * sellQty;
  const realized = proceeds - costPortion;
  p.qtyToken -= sellQty;
  p.costUsd = Math.max(0, p.costUsd - costPortion);
  p.realizedUsd += realized;
  return { usd: proceeds, realized };
}

async function buy(p: DcabotPosition, price: number, usd: number, reason: string, cycleIndex: number | null): Promise<void> {
  if (price <= 0 || usd <= 0) return;
  const { qty } = applyBuy(p, price, usd);
  await recordFill({ positionId: p.id, side: 'buy', reason, priceUsd: price, qtyToken: qty, usd, cycleIndex });
}

async function sellFraction(p: DcabotPosition, price: number, fraction: number, reason: string, cycleIndex: number | null): Promise<void> {
  const qty = p.qtyToken * Math.max(0, Math.min(1, fraction));
  await sellQty(p, price, qty, reason, cycleIndex);
}

async function sellQty(p: DcabotPosition, price: number, qty: number, reason: string, cycleIndex: number | null): Promise<void> {
  if (price <= 0 || qty <= 0) return;
  const { usd, realized } = applySell(p, price, qty);
  await recordFill({ positionId: p.id, side: 'sell', reason, priceUsd: price, qtyToken: qty, usd, cycleIndex, realizedUsd: realized });
}

function close(p: DcabotPosition, reason: string): void {
  p.state = 'closed';
  p.closeReason = reason;
  p.pendingSellQty = 0;
  p.pendingSellAtMs = null;
}

async function processScoring(p: DcabotPosition): Promise<void> {
  const market = await getTokenMarket(p.mint);
  const legit = await scoreToken(p.mint).catch(() => null);
  p.legitScore = legit?.score ?? null;
  if (market?.symbol) p.symbol = market.symbol;
  const remainingBuyUsd = p.cycleUsd * Math.max(1, p.plannedCycles);
  p.estGainPct = estimateGainPct(remainingBuyUsd, market?.liquidityUsd ?? 0);
  p.state = 'armed';
}

async function processArmed(p: DcabotPosition): Promise<void> {
  const prog = await cycleProgress(p.vault, p.openTsMs, p.cycleFreqSec, p.plannedCycles);
  if (prog.ended) {
    // Order finished before we could enter — record as skipped.
    p.state = 'skipped';
    p.closeReason = 'ended_before_entry';
    return;
  }
  if (prog.executed < 1) return; // wait for cycle 1 to execute

  if ((p.estGainPct ?? 0) < cfg.minGainPct) {
    p.state = 'skipped';
    p.closeReason = `est_gain_below_min(${(p.estGainPct ?? 0).toFixed(2)}%)`;
    return;
  }
  const price = await getPriceUsd(p.mint);
  if (price <= 0) return;
  await buy(p, price, cfg.baseEntryUsd, 'entry', prog.executed);
  p.ddStepsHit = 0;
  p.tpStepsHit = 0;
  p.state = 'managing';
  console.log('[dcabot] ENTER', { mint: p.mint, sym: p.symbol, price, estGain: p.estGainPct, legit: p.legitScore });
}

async function processManaging(p: DcabotPosition): Promise<void> {
  const price = await getPriceUsd(p.mint);
  if (price <= 0) return;
  const prog = await cycleProgress(p.vault, p.openTsMs, p.cycleFreqSec, p.plannedCycles);

  // 1) Operator early-cancel: vault drained well before the schedule.
  if (prog.earlyCancel) {
    const pnl = p.qtyToken * price - p.costUsd;
    if (pnl > 0) {
      await sellFraction(p, price, 1, 'early_cancel_profit', prog.executed);
      close(p, 'early_cancel_profit');
    } else {
      await sellFraction(p, price, cfg.earlyCancelLossFirstFraction, 'early_cancel_loss_1', prog.executed);
      p.pendingSellQty = p.qtyToken;
      p.pendingSellAtMs = Date.now() + cfg.earlyCancelDelayMin * 60_000;
      p.state = 'closing';
    }
    return;
  }

  // 2) Natural completion while still holding (e.g. big-cycle hold rode to the end).
  if (prog.ended) {
    await sellFraction(p, price, 1, 'completed', prog.executed);
    close(p, 'completed');
    return;
  }

  // 3) Pre-exit ahead of the bots — unless this is a very large per-cycle order (ride fully).
  if (p.cycleUsd <= cfg.bigCycleHoldUsd && p.plannedCycles > 0) {
    const remaining = p.plannedCycles - prog.executed;
    if (remaining <= cfg.exitSecondCyclesBefore) {
      await sellFraction(p, price, 1, 'exit_pre_final', prog.executed);
      close(p, 'exit_pre_final');
      return;
    }
    if (!p.exitFirstDone && remaining <= cfg.exitFirstCyclesBefore) {
      await sellFraction(p, price, cfg.exitFirstFraction, 'exit_pre_first', prog.executed);
      p.exitFirstDone = true;
    }
  }

  // 4) Average-down ladder (one add per tick; re-bases on the moving avg entry).
  const ddTarget = p.avgEntryPrice * (1 - (cfg.avgDownStepPct / 100) * (p.ddStepsHit + 1));
  const ddRoom = cfg.avgDownMaxAdds === 0 || p.ddStepsHit < cfg.avgDownMaxAdds;
  if (p.qtyToken > 0 && ddRoom && price <= ddTarget) {
    await buy(p, price, cfg.avgDownUsd, 'avg_down', prog.executed);
    p.ddStepsHit += 1;
    return;
  }

  // 5) Take-profit ladder (one tranche per tick; fixed multiples above avg entry).
  const tpTarget = p.avgEntryPrice * (1 + (cfg.tpStepPct / 100) * (p.tpStepsHit + 1));
  if (p.qtyToken > 0 && price >= tpTarget) {
    await sellFraction(p, price, cfg.tpSellFraction, 'take_profit', prog.executed);
    p.tpStepsHit += 1;
    if (p.qtyToken * price < 0.5) close(p, 'tp_dust');
  }
}

async function processClosing(p: DcabotPosition): Promise<void> {
  if (p.pendingSellAtMs != null && Date.now() >= p.pendingSellAtMs) {
    const price = await getPriceUsd(p.mint);
    if (price <= 0) return;
    await sellQty(p, price, p.pendingSellQty, 'early_cancel_loss_2', null);
    close(p, 'early_cancel_loss');
  }
}

async function writeEquity(): Promise<void> {
  const agg = await pgSql<
    { realized: number | null; open_cost: number | null; open_count: number | null; max_cap: number | null }[]
  >`
    SELECT
      COALESCE(SUM(realized_usd), 0) AS realized,
      COALESCE(SUM(cost_usd) FILTER (WHERE state IN ('managing','closing')), 0) AS open_cost,
      COUNT(*) FILTER (WHERE state IN ('managing','closing')) AS open_count,
      COALESCE(SUM(max_capital_usd), 0) AS max_cap
    FROM dcabot_positions
  `;
  const realized = Number(agg[0]?.realized || 0);
  const openCost = Number(agg[0]?.open_cost || 0);
  const openCount = Number(agg[0]?.open_count || 0);
  const maxCap = Number(agg[0]?.max_cap || 0);

  // Unrealized = current value of open positions − their cost basis.
  const open = await pgSql<{ mint: string; qty_token: number; cost_usd: number }[]>`
    SELECT mint, qty_token, cost_usd FROM dcabot_positions WHERE state IN ('managing','closing') AND qty_token > 0
  `;
  let posValue = 0;
  for (const o of open) {
    const px = await getPriceUsd(String(o.mint));
    posValue += Number(o.qty_token) * px;
  }
  const unrealized = posValue - openCost;
  const cash = cfg.bankUsd + realized - openCost;
  const equity = cash + posValue;

  await snapshotEquity({
    cashUsd: cash,
    positionsValueUsd: posValue,
    equityUsd: equity,
    realizedUsd: realized,
    unrealizedUsd: unrealized,
    openPositions: openCount,
    maxCapitalUsd: maxCap,
  });
}

export async function tickEngine(): Promise<void> {
  const positions = await listActivePositions();
  for (const p of positions) {
    try {
      if (p.state === 'scoring') await processScoring(p);
      else if (p.state === 'armed') await processArmed(p);
      else if (p.state === 'managing') await processManaging(p);
      else if (p.state === 'closing') await processClosing(p);
      await savePosition(p);
    } catch (e) {
      console.warn('[dcabot] position tick failed', p.mint, String(e).slice(0, 160));
    }
  }
  await writeEquity().catch((e) => console.warn('[dcabot] equity snapshot failed', String(e).slice(0, 160)));
}
