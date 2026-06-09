import { configureLiveStore } from '../live/store-jsonl.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { portfolioSnapshot } from '../pumpswap-combo/risk.js';
import { followPaperPortfolioSnapshot } from './paper-portfolio.js';
import { ensureComboSolUsd } from '../pumpswap-combo/sol-oracle.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import { checkFollowPortfolioHalt, evaluateFollowExits } from './exits.js';
import { appendFollowEvent } from './journal.js';
import { pollLeaderAndScheduleBuys, processPendingFollowBuys } from './leader-sync.js';
import { rebalanceFollowTreasuryIfNeeded } from './treasury-rebalance.js';
import {
  followStateAsCombo,
  gcFollowSeenSignatures,
  pruneFollowCooldowns,
  readFollowState,
} from './state.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runPumpswapComboFollowLoop(cfg: PumpswapComboFollowConfig): Promise<void> {
  configureLiveStore({ storePath: cfg.journalPath, strategyId: cfg.strategyId });
  let lastHeartbeat = 0;
  const execCfg = toComboExecutorConfig(cfg);

  const solUsdBoot = await ensureComboSolUsd(true);
  const ladderSummary = cfg.exitLadder
    .map(
      (r) =>
        `${(r.sellFracOfRemaining * 100).toFixed(0)}%@${r.effectiveTpPct}% (lead ${cfg.exitLeadPct}% vs ${r.leaderTpPct}%)`,
    )
    .join(' → ');

  appendFollowEvent(cfg, {
    kind: 'boot',
    execVenue: cfg.executionMode === 'paper' ? 'paper_pool_quote' : 'pumpswap_direct',
    executionMode: cfg.executionMode,
    mode: 'follow_hnu5',
    targetWallet: cfg.targetWallet,
    legUsd: cfg.legUsd,
    maxBuyLegs: cfg.maxBuyLegs,
    solUsd: solUsdBoot,
    portfolioStopLossUsd: cfg.portfolioStopLossUsd,
    exitLeadPct: cfg.exitLeadPct,
    exitLadder: ladderSummary,
    slSingle: effectiveSlSummary(cfg),
    buyDelayMs: cfg.buyDelayMs,
    treasuryUsdcTargetPct: cfg.treasuryUsdcTargetPct,
    treasuryUsdcMinPct: cfg.treasuryUsdcMinPct,
    treasuryUsdcMaxPct: cfg.treasuryUsdcMaxPct,
  });

  console.log(
    `[pumpswap-combo-follow] ${cfg.executionMode.toUpperCase()} follow=${cfg.targetWallet.slice(0, 8)} leg=$${cfg.legUsd} ladder=${ladderSummary} poll=${cfg.pollIntervalMs}ms`,
  );

  if (cfg.executionMode === 'live') {
    await rebalanceFollowTreasuryIfNeeded(cfg);
  }

  for (;;) {
    const nowMs = Date.now();
    try {
      await ensureComboSolUsd();
      const state = readFollowState(cfg);
      pruneFollowCooldowns(state, nowMs);
      gcFollowSeenSignatures(state, nowMs);

      if (!state.halted) {
        await checkFollowPortfolioHalt(cfg, state);
      }

      const fresh = readFollowState(cfg);
      if (!fresh.halted) {
        const poll = await pollLeaderAndScheduleBuys(cfg, fresh);
        if (poll.rpcFailed) {
          appendFollowEvent(cfg, { kind: 'poll_rpc_fail' });
        }
        await processPendingFollowBuys(cfg, fresh);
        await evaluateFollowExits(cfg, fresh);
      }

      if (nowMs - lastHeartbeat >= cfg.heartbeatIntervalMs) {
        lastHeartbeat = nowMs;
        if (cfg.executionMode === 'live') {
          await rebalanceFollowTreasuryIfNeeded(cfg);
        }
        const hbState = readFollowState(cfg);
        const snap =
          cfg.executionMode === 'paper'
            ? await followPaperPortfolioSnapshot(cfg, hbState)
            : await portfolioSnapshot(execCfg, followStateAsCombo(hbState));
        appendFollowEvent(cfg, {
          kind: 'heartbeat',
          executionMode: cfg.executionMode,
          openCount: snap.openCount,
          pendingBuys: hbState.pendingBuys.length,
          realizedPnlUsd: snap.realizedPnlUsd,
          unrealizedPnlUsd: snap.unrealizedPnlUsd,
          totalPnlUsd: snap.totalPnlUsd,
          halted: snap.halted,
          solUsd: getSolUsd(),
          targetWallet: cfg.targetWallet,
        });
        console.log(
          `[pumpswap-combo-follow] heartbeat open=${snap.openCount} pending=${hbState.pendingBuys.length} pnl=$${snap.totalPnlUsd.toFixed(2)} halted=${snap.halted}`,
        );
      }
    } catch (err) {
      console.warn('[pumpswap-combo-follow] tick error', (err as Error).message);
      appendFollowEvent(cfg, { kind: 'tick_error', error: (err as Error).message });
    }
    await sleep(cfg.pollIntervalMs);
  }
}

function effectiveSlSummary(cfg: PumpswapComboFollowConfig): string {
  const single = Math.max(1, cfg.slSingleLegPct - cfg.exitLeadPct);
  const multi = Math.max(1, cfg.slMultiLegPct - cfg.exitLeadPct);
  return `single -${single}% / multi -${multi}% (lead ${cfg.exitLeadPct}%)`;
}
