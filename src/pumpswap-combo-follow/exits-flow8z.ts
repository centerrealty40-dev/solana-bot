/**
 * Flow8z anti-dump follow exits.
 * Mirror selective leader entries; exit via TP ladder before leader dump;
 * optional killstop (off by default); if leader sells while we still hold — pool flush (not dump px).
 */
import { alertComboTradeLoss } from '../pumpswap-combo/alerts.js';
import { pnlPctVsAvgFill, quoteExitPriceUsd } from '../pumpswap-combo/pricing.js';
import { recordRealizedPnl, updateBotPeak } from '../pumpswap-combo/risk.js';
import { investedUsd } from '../pumpswap-combo/state.js';
import { comboLiveBridge } from '../pumpswap-combo/live-bridge.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import { executeFollowSell } from './executor.js';
import { nextExitRung } from './exit-ladder.js';
import { appendFollowEvent } from './journal.js';
import { paperInvestedRemainingUsd, paperPoolExitQuoteUsd, paperPnlPctVsAvg } from './paper-pricing.js';
import { followMaxHoldDue, followHoldSec } from './exit-max-hold.js';
import {
  evaluateLeaderPoolFlush,
  leaderFlushExitReason,
} from './flow8z-leader-flush.js';
import {
  followStateAsCombo,
  leaderSellSinceOpen,
  setFollowLossCooldown,
  writeFollowState,
  type FollowState,
} from './state.js';
import type { ComboPosition } from '../pumpswap-combo/types.js';

async function resolveExitMark(
  cfg: PumpswapComboFollowConfig,
  pos: FollowState['positions'][0],
  liveCfg: ReturnType<typeof comboLiveBridge>,
): Promise<number | null> {
  if (cfg.executionMode === 'paper') {
    const q = await paperPoolExitQuoteUsd({ rpcUrl: cfg.rpcUrl, pos });
    return q.priceUsd;
  }
  const q = await quoteExitPriceUsd(liveCfg, pos.mint, pos.poolAddress);
  return q.priceUsd;
}

export async function evaluateFollowExitsFlow8z(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
): Promise<void> {
  const execCfg = toComboExecutorConfig(cfg);
  const liveCfg = comboLiveBridge(execCfg);
  const closedMints = new Set<string>();
  const comboState = followStateAsCombo(state);
  const killPct = cfg.flow8zKillstopPct;

  for (const pos of state.positions) {
    if (closedMints.has(pos.mint) || pos.remainingFrac <= 1e-6) continue;

    const mark = await resolveExitMark(cfg, pos, liveCfg);
    if (mark == null) continue;

    const comboPos = comboState.positions.find((p) => p.mint === pos.mint) as ComboPosition;
    updateBotPeak(comboPos, mark);
    pos.botPeakUsd = comboPos.botPeakUsd;

    const pnlPct =
      cfg.executionMode === 'paper' ? paperPnlPctVsAvg(pos, mark) : pnlPctVsAvgFill(comboPos, mark);
    const inv =
      cfg.executionMode === 'paper' ? paperInvestedRemainingUsd(pos) : investedUsd(comboPos);
    const leaderSellRef = leaderSellSinceOpen(state, pos.mint, pos.openedAt);
    const flushVerdict = evaluateLeaderPoolFlush({
      nowMs: Date.now(),
      enabled: cfg.flow8zLeaderFlushEnabled,
      sellRef: leaderSellRef,
      openedAt: pos.openedAt,
      minSellUsd: cfg.flow8zLeaderFlushMinSellUsd,
      largeSellDelayMs: cfg.flow8zLeaderSellDelayMs,
      flatFlushDelayMs: cfg.flow8zLeaderFlatFlushDelayMs,
    });
    const holdSec = followHoldSec(pos);

    if (followMaxHoldDue(pos, cfg.maxHoldMs)) {
      const res = await executeFollowSell({
        cfg,
        pos,
        markPriceUsd: mark,
        exitReason: 'max_hold',
        intent: 'tp2_full',
        sellFrac: 1,
      });
      if (!res.ok) continue;
      closedMints.add(pos.mint);
      const realized = res.pnlUsd ?? inv * (pnlPct / 100);
      recordRealizedPnl(comboState, realized);
      state.realizedPnlUsd = comboState.realizedPnlUsd;
      if (realized < 0) setFollowLossCooldown(cfg, state, pos.mint, Date.now());
      appendFollowEvent(cfg, {
        kind: 'round_trip',
        mode: cfg.executionMode,
        mint: pos.mint,
        symbol: pos.symbol,
        legs: pos.legs.length,
        investedUsd: inv,
        pnlUsd: realized,
        pnlPct,
        exitReason: 'max_hold',
        markSource: 'pool_quote',
        holdSec,
        maxHoldMs: cfg.maxHoldMs,
      });
      continue;
    }

    const rung = nextExitRung(cfg.exitLadder, pos.rungsTaken);
    if (rung && pnlPct >= rung.effectiveTpPct) {
      const intent = rung.isFinal ? 'tp2_full' : 'tp1_partial';
      const res = await executeFollowSell({
        cfg,
        pos,
        markPriceUsd: mark,
        exitReason: rung.id,
        intent,
        sellFrac: rung.sellFracOfRemaining,
      });
      if (res.ok) {
        pos.rungsTaken.push(rung.id);
        appendFollowEvent(cfg, {
          kind: rung.isFinal ? 'close' : 'partial_sell',
          mode: cfg.executionMode,
          mint: pos.mint,
          symbol: pos.symbol,
          exitReason: rung.id,
          intent,
          sellFrac: rung.sellFracOfRemaining,
          effectiveTpPct: rung.effectiveTpPct,
          markPriceUsd: mark,
          pnlUsd: res.pnlUsd,
          pnlPct,
          remainingFrac: pos.remainingFrac,
        });
        if (rung.isFinal || pos.remainingFrac <= 1e-6) {
          closedMints.add(pos.mint);
          const realized = res.pnlUsd ?? inv * (pnlPct / 100);
          recordRealizedPnl(comboState, realized);
          state.realizedPnlUsd = comboState.realizedPnlUsd;
          appendFollowEvent(cfg, {
            kind: 'round_trip',
            mode: cfg.executionMode,
            mint: pos.mint,
            symbol: pos.symbol,
            legs: pos.legs.length,
            investedUsd: inv,
            pnlUsd: realized,
            pnlPct,
            exitReason: rung.id,
            rungsTaken: [...pos.rungsTaken],
            holdSec: Math.round((Date.now() - pos.openedAt) / 1000),
          });
        }
      }
      continue;
    }

    if (killPct > 0 && pnlPct <= -killPct) {
      const res = await executeFollowSell({
        cfg,
        pos,
        markPriceUsd: mark,
        exitReason: 'flow8z_killstop',
        intent: 'stop_loss',
        sellFrac: 1,
      });
      if (!res.ok) continue;
      closedMints.add(pos.mint);
      const realized = res.pnlUsd ?? inv * (pnlPct / 100);
      recordRealizedPnl(comboState, realized);
      state.realizedPnlUsd = comboState.realizedPnlUsd;
      if (realized < 0) {
        setFollowLossCooldown(cfg, state, pos.mint, Date.now());
        if (cfg.executionMode === 'live') {
          void alertComboTradeLoss(execCfg, {
            mint: pos.mint,
            symbol: pos.symbol,
            pnlUsd: realized,
            exitReason: 'flow8z_killstop',
          });
        }
      }
      appendFollowEvent(cfg, {
        kind: 'round_trip',
        mode: cfg.executionMode,
        mint: pos.mint,
        symbol: pos.symbol,
        legs: pos.legs.length,
        investedUsd: inv,
        pnlUsd: realized,
        pnlPct,
        exitReason: 'flow8z_killstop',
        markSource: 'pool_quote',
        holdSec: Math.round((Date.now() - pos.openedAt) / 1000),
      });
      continue;
    }

    if (flushVerdict.shouldFlush) {
      const exitReason = leaderFlushExitReason(flushVerdict.reason);
      const res = await executeFollowSell({
        cfg,
        pos,
        markPriceUsd: mark,
        exitReason,
        intent: 'tp2_full',
        sellFrac: 1,
      });
      if (!res.ok) continue;
      closedMints.add(pos.mint);
      const realized = res.pnlUsd ?? inv * (pnlPct / 100);
      recordRealizedPnl(comboState, realized);
      state.realizedPnlUsd = comboState.realizedPnlUsd;
      if (realized < 0) setFollowLossCooldown(cfg, state, pos.mint, Date.now());
      appendFollowEvent(cfg, {
        kind: 'round_trip',
        mode: cfg.executionMode,
        mint: pos.mint,
        symbol: pos.symbol,
        legs: pos.legs.length,
        investedUsd: inv,
        pnlUsd: realized,
        pnlPct,
        exitReason,
        markSource: 'pool_quote',
        holdSec: Math.round((Date.now() - pos.openedAt) / 1000),
        leaderSellDelayMs: cfg.flow8zLeaderSellDelayMs,
        leaderFlatFlushDelayMs: cfg.flow8zLeaderFlatFlushDelayMs,
        leaderFlushMinSellUsd: cfg.flow8zLeaderFlushMinSellUsd,
        leaderSellObservedTs: leaderSellRef?.ts,
        leaderSellUsd: leaderSellRef?.sellUsd ?? null,
        leaderFlat: leaderSellRef?.leaderFlat ?? null,
        leaderFlushReason: flushVerdict.reason,
      });
      continue;
    }
  }

  if (closedMints.size) {
    state.positions = state.positions.filter((p) => !closedMints.has(p.mint));
  }
  writeFollowState(cfg, state);
}
