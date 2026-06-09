import { alertComboTradeLoss } from '../pumpswap-combo/alerts.js';
import { pnlPctVsAvgFill, quoteExitPriceUsd } from '../pumpswap-combo/pricing.js';
import {
  applyPortfolioHalt,
  portfolioSnapshot,
  recordRealizedPnl,
  updateBotPeak,
} from '../pumpswap-combo/risk.js';
import { investedUsd } from '../pumpswap-combo/state.js';
import { comboLiveBridge } from '../pumpswap-combo/live-bridge.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import { executeFollowSell } from './executor.js';
import { effectiveStopLossPct, nextExitRung } from './exit-ladder.js';
import { evaluateFollowExitsWaveB } from './exits-wave-b.js';
import { stopLossAllowed } from './exit-policy.js';
import { leaderPreBalanceRaw } from './leader-ledger.js';
import { appendFollowEvent } from './journal.js';
import { followPaperPortfolioSnapshot } from './paper-portfolio.js';
import { paperInvestedRemainingUsd, paperPoolExitQuoteUsd, paperPnlPctVsAvg } from './paper-pricing.js';
import {
  followStateAsCombo,
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

export async function evaluateFollowExits(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
): Promise<void> {
  if (cfg.exitPolicy === 'oscar_wave_b') {
    return evaluateFollowExitsWaveB(cfg, state);
  }

  const execCfg = toComboExecutorConfig(cfg);
  const liveCfg = comboLiveBridge(execCfg);
  const closedMints = new Set<string>();
  const comboState = followStateAsCombo(state);

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
    const multiLeg = pos.legs.length > 1;
    const slPct = effectiveStopLossPct(
      cfg.slSingleLegPct,
      cfg.exitLeadPct,
      multiLeg,
      cfg.slMultiLegPct,
      { legs: pos.legs.length, maxBuyLegs: cfg.maxBuyLegs, slPreDcaPct: cfg.slPreDcaPct },
    );

    const leaderHolds = leaderPreBalanceRaw(state, pos.mint) > 0n;
    const leaderSoldSinceOpen = Boolean(state.lastLeaderSellByMint[pos.mint]);
    const slAllowed = stopLossAllowed({
      slMode: cfg.slMode,
      leaderHolds,
      leaderSoldSinceOpen,
    });

    if (slAllowed && pnlPct <= -slPct) {
      const res = await executeFollowSell({
        cfg,
        pos,
        markPriceUsd: mark,
        exitReason: 'stop_loss',
        intent: 'stop_loss',
        sellFrac: 1,
      });
      if (!res.ok) continue;

      closedMints.add(pos.mint);
      const realized = res.pnlUsd ?? inv * (pnlPct / 100);
      recordRealizedPnl(comboState, realized);
      state.realizedPnlUsd = comboState.realizedPnlUsd;
      if (realized < 0 && cfg.executionMode === 'live') {
        setFollowLossCooldown(cfg, state, pos.mint, Date.now());
        void alertComboTradeLoss(execCfg, {
          mint: pos.mint,
          symbol: pos.symbol,
          pnlUsd: realized,
          exitReason: 'stop_loss',
        });
      } else if (realized < 0) {
        setFollowLossCooldown(cfg, state, pos.mint, Date.now());
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
        exitReason: 'stop_loss',
        markSource: 'pool_quote',
        leaderSlPct: multiLeg ? cfg.slMultiLegPct : cfg.slSingleLegPct,
        effectiveSlPct: slPct,
        exitLeadPct: cfg.exitLeadPct,
        slMode: cfg.slMode,
        leaderHolds,
        holdSec: Math.round((Date.now() - pos.openedAt) / 1000),
      });
      continue;
    }

    if (!slAllowed && pnlPct <= -slPct) {
      appendFollowEvent(cfg, {
        kind: 'stop_loss_suppressed',
        mode: cfg.executionMode,
        mint: pos.mint,
        symbol: pos.symbol,
        pnlPct,
        effectiveSlPct: slPct,
        slMode: cfg.slMode,
        leaderHolds,
        leaderSoldSinceOpen,
      });
    }

    const rung = nextExitRung(cfg.exitLadder, pos.rungsTaken);
    if (!rung) continue;
    if (pnlPct < rung.effectiveTpPct) continue;

    const intent = rung.isFinal ? 'tp2_full' : 'tp1_partial';
    const res = await executeFollowSell({
      cfg,
      pos,
      markPriceUsd: mark,
      exitReason: rung.id,
      intent,
      sellFrac: rung.sellFracOfRemaining,
    });
    if (!res.ok) continue;

    pos.rungsTaken.push(rung.id);
    appendFollowEvent(cfg, {
      kind: rung.isFinal ? 'close' : 'partial_sell',
      mode: cfg.executionMode,
      mint: pos.mint,
      symbol: pos.symbol,
      exitReason: rung.id,
      intent,
      sellFrac: rung.sellFracOfRemaining,
      leaderTpPct: rung.leaderTpPct,
      effectiveTpPct: rung.effectiveTpPct,
      exitLeadPct: cfg.exitLeadPct,
      markPriceUsd: mark,
      markSource: 'pool_quote',
      pnlUsd: res.pnlUsd,
      pnlPct,
      remainingFrac: pos.remainingFrac,
    });

    if (rung.isFinal || pos.remainingFrac <= 1e-6) {
      closedMints.add(pos.mint);
      const realized = res.pnlUsd ?? inv * (pnlPct / 100);
      recordRealizedPnl(comboState, realized);
      state.realizedPnlUsd = comboState.realizedPnlUsd;
      if (realized < 0 && cfg.executionMode === 'live') {
        setFollowLossCooldown(cfg, state, pos.mint, Date.now());
        void alertComboTradeLoss(execCfg, {
          mint: pos.mint,
          symbol: pos.symbol,
          pnlUsd: realized,
          exitReason: rung.id,
        });
      } else if (realized < 0) {
        setFollowLossCooldown(cfg, state, pos.mint, Date.now());
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
        exitReason: rung.id,
        rungsTaken: [...pos.rungsTaken],
        holdSec: Math.round((Date.now() - pos.openedAt) / 1000),
      });
    }
  }

  if (closedMints.size) {
    state.positions = state.positions.filter((p) => !closedMints.has(p.mint));
  }
  writeFollowState(cfg, state);
}

export async function checkFollowPortfolioHalt(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
): Promise<boolean> {
  const snap =
    cfg.executionMode === 'paper'
      ? await followPaperPortfolioSnapshot(cfg, state)
      : await portfolioSnapshot(toComboExecutorConfig(cfg), followStateAsCombo(state));

  if (cfg.executionMode === 'paper') {
    if (snap.totalPnlUsd > -Math.abs(cfg.portfolioStopLossUsd)) return false;
    state.halted = true;
    state.haltReason = `portfolio_stop_${cfg.portfolioStopLossUsd}usd`;
    state.haltedAt = Date.now();
  } else {
    const comboState = followStateAsCombo(state);
    if (!applyPortfolioHalt(toComboExecutorConfig(cfg), comboState, snap.totalPnlUsd)) return false;
    state.halted = comboState.halted;
    state.haltReason = comboState.haltReason;
    state.haltedAt = comboState.haltedAt;
  }

  appendFollowEvent(cfg, {
    kind: 'portfolio_halt',
    mode: cfg.executionMode,
    totalPnlUsd: snap.totalPnlUsd,
    limitUsd: cfg.portfolioStopLossUsd,
  });
  writeFollowState(cfg, state);
  return true;
}
