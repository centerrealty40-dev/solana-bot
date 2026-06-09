import { configureLiveStore } from '../live/store-jsonl.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { portfolioSnapshot } from '../pumpswap-combo/risk.js';
import { followPaperPortfolioSnapshot } from './paper-portfolio.js';
import { ensureComboSolUsd } from '../pumpswap-combo/sol-oracle.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import { startOpsHeartbeat } from '../core/ops-heartbeat.js';
import { checkFollowPortfolioHalt, evaluateFollowExits } from './exits.js';
import { evaluateFollowDca } from './follow-dca.js';
import { appendFollowEvent } from './journal.js';
import { LeaderWalletWsClient } from './leader-ws.js';
import {
  handleLeaderWsSignature,
  pollLeaderAndScheduleBuys,
  processPendingFollowBuys,
} from './leader-sync.js';
import {
  followStateAsCombo,
  gcFollowSeenSignatures,
  pruneFollowCooldowns,
  readFollowState,
  writeFollowState,
} from './state.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serialize poll + WS ingest so state/pendingBuys are not mutated concurrently. */
function createLeaderPipelineLock() {
  let chain: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export async function runPumpswapComboFollowLoop(cfg: PumpswapComboFollowConfig): Promise<void> {
  configureLiveStore({ storePath: cfg.journalPath, strategyId: cfg.strategyId });
  startOpsHeartbeat({ appName: cfg.strategyId, stats: () => ({ executionMode: cfg.executionMode }) });

  if (process.env.PUMPSWAP_COMBO_FOLLOW_CLEAR_HALT === '1') {
    const bootState = readFollowState(cfg);
    if (bootState.halted) {
      bootState.halted = false;
      bootState.haltReason = undefined;
      bootState.haltedAt = undefined;
      writeFollowState(cfg, bootState);
      appendFollowEvent(cfg, { kind: 'halt_cleared', reason: 'clear_halt_on_boot' });
    }
  }

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
    exitPolicy: cfg.exitPolicy,
    quoteAsset: 'SOL',
    legUsd: cfg.legUsd,
    entryUsd: cfg.entryUsd,
    dcaNotionalUsd: cfg.dcaNotionalUsd,
    dcaLevels: cfg.dcaLevels.map((l) => `${(l.triggerPct * 100).toFixed(0)}:${l.addFraction}`).join(','),
    dcaKillstopPct: cfg.dcaKillstopPct,
    mirrorLeaderAdds: cfg.mirrorLeaderAdds,
    waveBTrailSellFraction: cfg.waveBTrailSellFraction,
    maxBuyLegs: cfg.maxBuyLegs,
    solUsd: solUsdBoot,
    portfolioStopLossUsd: cfg.portfolioStopLossUsd,
    exitLeadPct: cfg.exitLeadPct,
    exitLadder: ladderSummary,
    slSingle: effectiveSlSummary(cfg),
    buyDelayMs: cfg.buyDelayMs,
    leaderWsEnabled: cfg.leaderWsEnabled,
    pollIntervalMs: cfg.pollIntervalMs,
    pollFallbackMs: cfg.pollFallbackMs,
    entryGate: cfg.entryGate,
    flowGateMinExtSellUsd: cfg.flowGateMinExtSellUsd,
    flowGateMaxExtSellUsd: cfg.flowGateMaxExtSellUsd,
    flowGateMaxLagSec: cfg.flowGateMaxLagSec,
    maxOpenPositions: cfg.maxOpenPositions,
    maxHoldMs: cfg.maxHoldMs,
  });

  const pollLabel = cfg.leaderWsEnabled
    ? `ws+pollFallback=${cfg.pollFallbackMs}ms`
    : `poll=${cfg.pollIntervalMs}ms`;
  const bootLine =
    cfg.exitPolicy === 'oscar_wave_b'
      ? `leg=$${cfg.entryUsd} dca=${cfg.dcaLevels.length}×${(cfg.dcaLevels[0]?.addFraction ?? 0) * 100}% kill=-${cfg.dcaKillstopPct}% waveB`
      : cfg.exitPolicy === 'flow8z_antidump'
        ? `leg=$${cfg.legUsd}${cfg.dcaLevels.length ? ` dca=${cfg.dcaLevels.length}×${((cfg.dcaLevels[0]?.addFraction ?? 0) * 100).toFixed(0)}%` : ''} flow8z ks=-${cfg.flow8zKillstopPct}% max1st=$${cfg.maxLeaderFirstBuyUsd} maxOpen=${cfg.maxOpenPositions}`
        : `leg=$${cfg.legUsd} ladder=${ladderSummary}`;

  console.log(
    `[pumpswap-combo-follow] ${cfg.executionMode.toUpperCase()} follow=${cfg.targetWallet.slice(0, 8)} ${bootLine} ${pollLabel}`,
  );

  const withLeaderLock = createLeaderPipelineLock();
  let lastPollMs = 0;
  let leaderWs: LeaderWalletWsClient | null = null;

  if (cfg.leaderWsEnabled && cfg.leaderWsUrl) {
    leaderWs = new LeaderWalletWsClient({
      wsUrl: cfg.leaderWsUrl,
      wallet: cfg.targetWallet,
      onSignature: (n) => {
        void withLeaderLock(async () => {
          try {
            await handleLeaderWsSignature(cfg, { signature: n.signature, err: n.err });
          } catch (err) {
            appendFollowEvent(cfg, {
              kind: 'leader_ws_ingest_error',
              leaderSignature: n.signature,
              error: (err as Error).message,
            });
          }
        });
      },
      onStatus: (event, detail) => {
        appendFollowEvent(cfg, { kind: 'leader_ws_status', event, detail: detail ?? null });
        if (event === 'open' || event === 'subscribed') {
          console.log(`[pumpswap-combo-follow] leader-ws ${event}${detail ? ` ${detail}` : ''}`);
        } else if (event === 'error') {
          console.warn(`[pumpswap-combo-follow] leader-ws error ${detail ?? ''}`);
        }
      },
    });
    leaderWs.start();
  } else if (cfg.executionMode === 'live') {
    console.warn('[pumpswap-combo-follow] leader WS disabled (no wss URL or PUMPSWAP_COMBO_FOLLOW_LEADER_WS=0)');
  }

  const tickMs = cfg.leaderWsEnabled ? 1000 : cfg.pollIntervalMs;
  const pollEveryMs = cfg.leaderWsEnabled ? cfg.pollFallbackMs : cfg.pollIntervalMs;

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
        const shouldPoll = nowMs - lastPollMs >= pollEveryMs;
        if (shouldPoll) {
          lastPollMs = nowMs;
          await withLeaderLock(async () => {
            const pollState = readFollowState(cfg);
            const poll = await pollLeaderAndScheduleBuys(cfg, pollState);
            if (poll.rpcFailed) {
              appendFollowEvent(cfg, { kind: 'poll_rpc_fail' });
            }
            await processPendingFollowBuys(cfg, pollState);
          });
        } else if (cfg.leaderWsEnabled) {
          await withLeaderLock(async () => {
            const pollState = readFollowState(cfg);
            await processPendingFollowBuys(cfg, pollState);
          });
        }
        const exitState = readFollowState(cfg);
        if (cfg.dcaLevels.length > 0) {
          await evaluateFollowDca(cfg, exitState);
        }
        await evaluateFollowExits(cfg, exitState);
      }

      if (nowMs - lastHeartbeat >= cfg.heartbeatIntervalMs) {
        lastHeartbeat = nowMs;
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
    await sleep(tickMs);
  }
}

function effectiveSlSummary(cfg: PumpswapComboFollowConfig): string {
  const single = Math.max(1, cfg.slSingleLegPct - cfg.exitLeadPct);
  const multi = Math.max(1, cfg.slMultiLegPct - cfg.exitLeadPct);
  return `single -${single}% / multi -${multi}% (lead ${cfg.exitLeadPct}%)`;
}
