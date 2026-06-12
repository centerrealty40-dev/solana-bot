import { dcaCrossedDownward } from '../papertrader/executor/dca-state.js';
import { quoteExitPriceUsd } from '../pumpswap-combo/pricing.js';
import { comboLiveBridge } from '../pumpswap-combo/live-bridge.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import { executeFollowBuy } from './executor.js';
import { appendFollowEvent } from './journal.js';
import { paperPoolExitQuoteUsd } from './paper-pricing.js';
import { resolveFollowPoolAddress } from './pool-resolve.js';
import {
  ensureFollowWaveBState,
  followAvgFillUsd,
  followDcaTaken,
  markFollowDcaFired,
} from './follow-wave-b-state.js';
import { writeFollowState, type FollowState } from './state.js';

/**
 * Price-triggered front-run DCA: fire before leader avg-down (e.g. −8% vs first, −7% vs avg).
 * Leader mirror adds stay disabled — we buy on our thresholds, leader lift follows.
 */
export async function evaluateFollowDca(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
): Promise<void> {
  const dcaPolicies = new Set(['oscar_wave_b', 'flow8z_antidump']);
  if (!dcaPolicies.has(cfg.exitPolicy) || !cfg.dcaLevels.length) return;

  for (const pos of state.positions) {
    if (pos.remainingFrac <= 1e-6) continue;
    if (pos.legs.length >= cfg.maxBuyLegs) continue;

    const resolved = await resolveFollowPoolAddress(cfg, pos.mint, { poolHint: pos.poolAddress });
    const pool = resolved.pool ?? pos.poolAddress;
    if (!pool) continue;

    let mark = 0;
    if (cfg.executionMode === 'paper') {
      const q = await paperPoolExitQuoteUsd({ rpcUrl: cfg.rpcUrl, pos });
      mark = q.priceUsd ?? 0;
    } else {
      const liveCfg = comboLiveBridge(toComboExecutorConfig(cfg));
      const q = await quoteExitPriceUsd(liveCfg, pos.mint, pool);
      mark = q.priceUsd ?? 0;
    }
    if (!(mark > 0)) continue;

    const firstPx = pos.legs[0]?.fillPriceUsd ?? 0;
    if (!(firstPx > 0)) continue;

    const wb = ensureFollowWaveBState(pos);
    const dcaLegCount = pos.legs.filter((l) => l.kind === 'dca').length;
    const legacyMirrorLegs = Math.max(0, pos.legs.length - 1 - dcaLegCount);
    if (legacyMirrorLegs > 0 && wb.dcaUsedIndices.length === 0) {
      for (let i = 0; i < Math.min(legacyMirrorLegs, cfg.dcaLevels.length); i++) {
        markFollowDcaFired(wb, i, cfg.dcaLevels[i]!.triggerPct);
      }
    }

    const avgPx = followAvgFillUsd(pos);
    const dropFromFirst = mark / firstPx - 1;
    const dropFromAvg = avgPx > 0 ? mark / avgPx - 1 : dropFromFirst;
    if (!wb.dcaLastEvalDropPctByIdx) wb.dcaLastEvalDropPctByIdx = {};

    for (let dcaIdx = 0; dcaIdx < cfg.dcaLevels.length; dcaIdx++) {
      const lvl = cfg.dcaLevels[dcaIdx]!;
      const drop = lvl.anchor === 'avg' ? dropFromAvg : dropFromFirst;
      const effPrev =
        wb.dcaLastEvalDropPctByIdx[dcaIdx] != null && Number.isFinite(wb.dcaLastEvalDropPctByIdx[dcaIdx])
          ? wb.dcaLastEvalDropPctByIdx[dcaIdx]!
          : Number.POSITIVE_INFINITY;
      if (followDcaTaken(wb, dcaIdx, lvl.triggerPct)) continue;
      if (!dcaCrossedDownward(effPrev, drop, lvl.triggerPct)) continue;

      const addUsd = cfg.dcaNotionalUsd * lvl.addFraction;
      if (!(addUsd > 0)) continue;

      const buy = await executeFollowBuy({
        cfg,
        mint: pos.mint,
        symbol: pos.symbol,
        poolAddress: pool,
        leaderPriceUsd: mark,
        intent: 'add',
        leaderSignature: `dca_${dcaIdx}_${Date.now()}`,
        buyUsd: addUsd,
      });

      if (!buy.ok || !(buy.fillPriceUsd && buy.fillPriceUsd > 0)) {
        appendFollowEvent(cfg, {
          kind: 'add_fail',
          mode: cfg.executionMode,
          mint: pos.mint,
          symbol: pos.symbol,
          reason: buy.reason ?? 'dca_fill_failed',
          dcaStepIndex: dcaIdx,
          triggerPct: lvl.triggerPct,
          addUsd,
        });
        break;
      }

      pos.legs.push({
        ts: Date.now(),
        usd: buy.usdAtMarket ?? addUsd,
        fillPriceUsd: buy.fillPriceUsd,
        txSignature: buy.txSignature,
        kind: 'dca',
      });
      if (buy.fillPriceUsd > pos.botPeakUsd) pos.botPeakUsd = buy.fillPriceUsd;
      markFollowDcaFired(wb, dcaIdx, lvl.triggerPct);

      appendFollowEvent(cfg, {
        kind: 'dca_add',
        mode: cfg.executionMode,
        mint: pos.mint,
        symbol: pos.symbol,
        dcaStepIndex: dcaIdx,
        dcaLevelsTotal: cfg.dcaLevels.length,
        triggerPct: lvl.triggerPct,
        addUsd,
        fillPriceUsd: buy.fillPriceUsd,
        legs: pos.legs.length,
        dropFromFirstPct: dropFromFirst * 100,
        dropFromAvgPct: dropFromAvg * 100,
        dcaAnchor: lvl.anchor,
      });
      break;
    }

    for (let dcaIdx = 0; dcaIdx < cfg.dcaLevels.length; dcaIdx++) {
      const lvl = cfg.dcaLevels[dcaIdx]!;
      wb.dcaLastEvalDropPctByIdx![dcaIdx] = lvl.anchor === 'avg' ? dropFromAvg : dropFromFirst;
    }
    wb.dcaLastEvalDropFromFirstPct = dropFromFirst;
  }

  writeFollowState(cfg, state);
}
