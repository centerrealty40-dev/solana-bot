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
import { main as paperOscarMain } from '../papertrader/main.js';
import {
  clearLiveReconcileBlock,
  getLiveReconcileBootSnapshot,
  setLiveReconcileBlock,
  setLiveReconcileBootSnapshot,
} from './live-reconcile-state.js';
import { createLiveOscarPhase5Bundle } from './phase5-runtime.js';
import { reconcileLiveWalletVsReplay } from './reconcile-live.js';
import { replayLiveStrategyJournal, type ReplayLiveStrategyJournalResult } from './replay-strategy-journal.js';

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
  setLiveReconcileBootSnapshot(null);

  let liveStrategyReplay: ReplayLiveStrategyJournalResult | undefined;

  if (!liveCfg.strategyEnabled) {
    log.info({}, 'live-oscar Phase 7 replay skipped (LIVE_STRATEGY_ENABLED=0)');
    setLiveReconcileBootSnapshot({ status: 'skipped', skipReason: 'strategy_disabled' });
  } else if (!liveCfg.liveReplayOnBoot) {
    setLiveReconcileBootSnapshot({ status: 'skipped', skipReason: 'replay_off' });
  } else {
    liveStrategyReplay = replayLiveStrategyJournal({
      storePath: liveCfg.liveTradesPath,
      strategyId: liveCfg.strategyId,
      tailLines: liveCfg.liveReplayTailLines,
      sinceTs: liveCfg.liveReplaySinceTs,
      maxFileBytes: liveCfg.liveReplayMaxFileBytes,
    });
    const journalTruncated = Boolean(liveStrategyReplay.journalTruncated);
    log.info(
      {
        replayOpen: liveStrategyReplay.open.size,
        replayClosed: liveStrategyReplay.closed.length,
        journalTruncated,
      },
      'live-oscar Phase 7 replay',
    );
    if (journalTruncated) {
      log.warn(
        { path: liveCfg.liveTradesPath, maxBytes: liveCfg.liveReplayMaxFileBytes },
        'live journal replay used trailing-byte truncation (LIVE_REPLAY_MAX_FILE_BYTES)',
      );
    }

    if (liveCfg.executionMode === 'dry_run') {
      setLiveReconcileBootSnapshot({ status: 'skipped', skipReason: 'dry_run', journalTruncated });
    } else if (!liveCfg.liveReconcileOnBoot) {
      setLiveReconcileBootSnapshot({ status: 'skipped', skipReason: 'reconcile_off', journalTruncated });
    } else if (liveCfg.executionMode !== 'simulate' && liveCfg.executionMode !== 'live') {
      setLiveReconcileBootSnapshot({ status: 'skipped', skipReason: 'execution_mode', journalTruncated });
    } else {
      const rec = await reconcileLiveWalletVsReplay({
        liveCfg,
        open: liveStrategyReplay.open,
        toleranceAtoms: BigInt(liveCfg.liveReconcileToleranceAtoms),
        mode: liveCfg.liveReconcileMode,
      });

      const rpcFail = rec.mismatches.some((m) => m.mint === '_rpc_');
      const divergentMintList = rec.mismatches.filter((m) => m.mint !== '_rpc_').map((m) => m.mint);

      if (rpcFail) {
        setLiveReconcileBootSnapshot({
          status: 'rpc_fail',
          divergentMints: divergentMintList.length ? divergentMintList : undefined,
          walletSolLamports: rec.walletSolLamports,
          chainOnlyMints: rec.chainOnlyMints,
          journalTruncated,
        });
        const detailStr = JSON.stringify({ mismatches: rec.mismatches }).slice(0, 500);
        if (liveCfg.liveReconcileMode === 'block_new') {
          setLiveReconcileBlock(true);
          appendLiveJsonlEvent({
            kind: 'risk_block',
            limit: 'reconcile_rpc_fail',
            detail: { mismatches: rec.mismatches },
          });
        } else if (liveCfg.liveReconcileMode === 'report') {
          appendLiveJsonlEvent({
            kind: 'execution_skip',
            reason: 'reconcile_rpc_fail',
            detail: detailStr,
          });
        } else {
          appendLiveJsonlEvent({
            kind: 'execution_skip',
            reason: 'reconcile_rpc_fail_trust_chain_stub',
            detail: detailStr,
          });
        }
      } else if (!rec.ok) {
        setLiveReconcileBootSnapshot({
          status: 'mismatch',
          divergentMints: divergentMintList,
          walletSolLamports: rec.walletSolLamports,
          chainOnlyMints: rec.chainOnlyMints,
          journalTruncated,
        });
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
      } else {
        setLiveReconcileBootSnapshot({
          status: 'ok',
          walletSolLamports: rec.walletSolLamports,
          chainOnlyMints: rec.chainOnlyMints,
          journalTruncated,
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
      const boot = getLiveReconcileBootSnapshot();
      appendLiveJsonlEvent({
        kind: 'heartbeat',
        uptimeSec: Math.floor(process.uptime()),
        openPositions,
        closedTotal,
        liveStrategyEnabled: liveCfg.strategyEnabled,
        executionMode: liveCfg.executionMode,
        note: `W8.0-p7 oscar: opened=${stats.opened} ticks=${stats.ticks} errors=${stats.errors} tracker=${JSON.stringify(trackerClosed)}`,
        ...(boot && {
          reconcileBootStatus: boot.status,
          reconcileBootSkipReason: boot.skipReason,
          reconcileMintsDivergent: boot.divergentMints,
          reconcileWalletSolLamports: boot.walletSolLamports ?? undefined,
          reconcileChainOnlyMints: boot.chainOnlyMints,
          journalReplayTruncated: boot.journalTruncated,
        }),
      });
    },
  });
}
