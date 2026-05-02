/**
 * W8.0 Live Oscar — Phase 4: reuse paper Oscar gates + tracker; live JSONL + Jupiter simulate only.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import pino from 'pino';
import { loadLiveOscarConfig } from './config.js';
import { runLiveJupiterSelfTest } from './jupiter-self-test.js';
import { runLivePhase3SimSelfTest } from './phase3-self-test.js';
import { appendLiveJsonlEvent, configureLiveStore } from './store-jsonl.js';
import { loadPaperTraderConfig } from '../papertrader/config.js';
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import { main as paperOscarMain } from '../papertrader/main.js';
import { clearLiveReconcileBlock, setLiveReconcileBlock } from './live-reconcile-state.js';
import { createLiveOscarPhase5Bundle } from './phase5-runtime.js';
import { reconcileLiveWalletVsReplay } from './reconcile-live.js';
import { replayLiveStrategyJournal } from './replay-strategy-journal.js';

const log = pino({ name: 'live-oscar' });

/** Optional second `.env` fragment with `PAPER_*` baseline for parity (W8.0-p4 §3.3.1). */
function loadOptionalInheritEnv(): void {
  const p = process.env.LIVE_INHERIT_ENV_FILE?.trim();
  if (!p) return;
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  dotenv.config({ path: abs });
}

export async function main(): Promise<void> {
  loadOptionalInheritEnv();
  const liveCfg = loadLiveOscarConfig();
  configureLiveStore({ storePath: liveCfg.liveTradesPath, strategyId: liveCfg.strategyId });
  clearLiveReconcileBlock();

  let liveStrategyReplay: { open: Map<string, OpenTrade>; closed: ClosedTrade[] } | undefined;
  if (liveCfg.strategyEnabled && liveCfg.liveReplayOnBoot) {
    liveStrategyReplay = replayLiveStrategyJournal({
      storePath: liveCfg.liveTradesPath,
      strategyId: liveCfg.strategyId,
      tailLines: liveCfg.liveReplayTailLines,
      sinceTs: liveCfg.liveReplaySinceTs,
    });
    log.info(
      {
        replayOpen: liveStrategyReplay.open.size,
        replayClosed: liveStrategyReplay.closed.length,
      },
      'live-oscar Phase 7 replay',
    );
  }

  if (
    liveCfg.strategyEnabled &&
    liveCfg.liveReconcileOnBoot &&
    (liveCfg.executionMode === 'simulate' || liveCfg.executionMode === 'live') &&
    liveStrategyReplay &&
    liveStrategyReplay.open.size > 0
  ) {
    const rec = await reconcileLiveWalletVsReplay({
      liveCfg,
      open: liveStrategyReplay.open,
      toleranceAtoms: BigInt(liveCfg.liveReconcileToleranceAtoms),
      mode: liveCfg.liveReconcileMode,
    });
    if (!rec.ok) {
      const detailStr = JSON.stringify({ mismatches: rec.mismatches }).slice(0, 500);
      if (liveCfg.liveReconcileMode === 'block_new') {
        setLiveReconcileBlock(true);
        appendLiveJsonlEvent({
          kind: 'risk_block',
          limit: 'reconcile_divergence',
          detail: { mismatches: rec.mismatches },
        });
      } else if (liveCfg.liveReconcileMode === 'report') {
        appendLiveJsonlEvent({
          kind: 'execution_skip',
          reason: 'reconcile_mismatch',
          detail: detailStr,
        });
      } else {
        log.warn({ mismatches: rec.mismatches }, 'reconcile mismatch (trust_chain v1 same as report)');
        appendLiveJsonlEvent({
          kind: 'execution_skip',
          reason: 'reconcile_mismatch_trust_chain_stub',
          detail: detailStr,
        });
      }
    }
  }

  log.info(
    {
      strategyId: liveCfg.strategyId,
      profile: liveCfg.profile,
      liveTradesPath: liveCfg.liveTradesPath,
      strategyEnabled: liveCfg.strategyEnabled,
      executionMode: liveCfg.executionMode,
    },
    'live-oscar executor start (W8.0-p7)',
  );

  appendLiveJsonlEvent({
    kind: 'live_boot',
    profile: liveCfg.profile,
    liveStrategyEnabled: liveCfg.strategyEnabled,
    executionMode: liveCfg.executionMode,
    phase: 'W8.0-p7',
  });

  void runLiveJupiterSelfTest(liveCfg).catch((err) => {
    log.error({ err: (err as Error)?.message }, 'runLiveJupiterSelfTest failed');
  });

  void runLivePhase3SimSelfTest(liveCfg).catch((err) => {
    log.error({ err: (err as Error)?.message }, 'runLivePhase3SimSelfTest failed');
  });

  const paperBaseline = loadPaperTraderConfig();

  await paperOscarMain({
    journalAppend: () => {},
    skipPaperJsonlStore: true,
    liveStrategyReplay,
    journalLiveStrategy: (body) => appendLiveJsonlEvent(body),
    liveOscarFactory: (deps) => createLiveOscarPhase5Bundle(liveCfg, deps, paperBaseline.positionUsd),
    onShutdown: (sig) => {
      appendLiveJsonlEvent({ kind: 'live_shutdown', sig }, { sync: true });
    },
    onOscarHeartbeat: ({ openPositions, closedTotal, stats, trackerClosed }) => {
      appendLiveJsonlEvent({
        kind: 'heartbeat',
        uptimeSec: Math.floor(process.uptime()),
        openPositions,
        closedTotal,
        liveStrategyEnabled: liveCfg.strategyEnabled,
        executionMode: liveCfg.executionMode,
        note: `W8.0-p7 oscar: opened=${stats.opened} ticks=${stats.ticks} errors=${stats.errors} tracker=${JSON.stringify(trackerClosed)}`,
      });
    },
  });
}
