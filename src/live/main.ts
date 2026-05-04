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
import { verifyReplayedOpenBuyAnchorsOnBoot } from './boot-anchor-verify.js';
import {
  clearLiveReconcileBlock,
  getLiveReconcileBootSnapshot,
  liveReconcileBlockAgeSec,
  liveReconcileBlocksNewExposure,
  setLiveReconcileBlock,
  setLiveReconcileBootSnapshot,
  type LiveReconcileBootSnapshot,
} from './live-reconcile-state.js';
import { createLiveOscarPhase5Bundle } from './phase5-runtime.js';
import { appendLiveReconcileReportJsonl } from './live-reconcile-report.js';
import {
  collectRecentConfirmedTxSignatures,
  verifyTxAnchorSample,
  type TxAnchorSampleResult,
} from './reconcile-tx-anchor-sample.js';
import { evaluateLiveNotionalParity } from './notional-parity.js';
import { replayLiveStrategyJournal, type ReplayLiveStrategyJournalResult } from './replay-strategy-journal.js';
import { repairMissedLiveBuysFromJournal } from './repair-missed-live-buys.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';
import { startLivePeriodicSelfHeal } from './periodic-self-heal.js';

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

  if (
    liveCfg.strategyEnabled &&
    (liveCfg.executionMode === 'simulate' || liveCfg.executionMode === 'live')
  ) {
    const expected = liveCfg.liveWalletPubkeyExpected?.trim();
    const secret = liveCfg.walletSecret?.trim();
    if (expected && secret) {
      const kp = loadLiveKeypairFromSecretEnv(secret);
      const got = kp.publicKey.toBase58();
      if (got !== expected) {
        throw new Error(
          `LIVE_WALLET_PUBKEY does not match LIVE_WALLET_SECRET (expected ${expected}, loaded ${got})`,
        );
      }
      log.info({ pubkey: got }, 'live-oscar wallet pubkey matches LIVE_WALLET_PUBKEY');
    }
  }

  configureLiveStore({ storePath: liveCfg.liveTradesPath, strategyId: liveCfg.strategyId });
  const paperBaseline = loadPaperTraderConfig();

  if (
    liveCfg.strategyEnabled &&
    (liveCfg.executionMode === 'live' || liveCfg.executionMode === 'simulate')
  ) {
    const maxUsd = liveCfg.liveMaxPositionUsd;
    if (
      maxUsd != null &&
      Number.isFinite(maxUsd) &&
      Math.abs(paperBaseline.positionUsd - maxUsd) > 1e-6
    ) {
      throw new Error(
        `live-oscar: PAPER_POSITION_USD (${paperBaseline.positionUsd}) must equal LIVE_MAX_POSITION_USD (${maxUsd}). Fix env / LIVE_INHERIT_ENV_FILE (see ecosystem live-oscar).`,
      );
    }
  }

  clearLiveReconcileBlock();
  setLiveReconcileBootSnapshot(null);

  let parityBlocked = false;
  const parity = evaluateLiveNotionalParity({
    strict: liveCfg.liveStrictNotionalParity,
    strategyEnabled: liveCfg.strategyEnabled,
    executionMode: liveCfg.executionMode,
    paperPositionUsd: paperBaseline.positionUsd,
    liveMaxPositionUsd: liveCfg.liveMaxPositionUsd,
    liveEntryNotionalUsd: liveCfg.liveEntryNotionalUsd,
  });
  if (!parity.ok) {
    parityBlocked = true;
    appendLiveJsonlEvent({
      kind: 'risk_block',
      limit: 'parity_notional_mismatch',
      detail: parity.detail,
    });
    setLiveReconcileBlock(true);
    log.warn({ detail: parity.detail }, 'live-oscar p7.1 notional parity blocked new exposure');
  }

  function commitBootSnapshot(s: LiveReconcileBootSnapshot): void {
    if (parityBlocked && s.status === 'ok') {
      setLiveReconcileBootSnapshot({
        ...s,
        status: 'mismatch',
        skipReason: 'parity_notional_mismatch',
      });
      return;
    }
    setLiveReconcileBootSnapshot(s);
  }

  let bootQuarantineMintPrefixes: string[] | undefined;

  let liveStrategyReplay: ReplayLiveStrategyJournalResult | undefined;

  const replayJournalOpts = () => ({
    storePath: liveCfg.liveTradesPath,
    strategyId: liveCfg.strategyId,
    tailLines: liveCfg.liveReplayTailLines,
    sinceTs: liveCfg.liveReplaySinceTs,
    maxFileBytes: liveCfg.liveReplayMaxFileBytes,
    trustGhostPositions: liveCfg.liveReplayTrustGhostPositions,
  });

  if (!liveCfg.strategyEnabled) {
    log.info({}, 'live-oscar Phase 7 replay skipped (LIVE_STRATEGY_ENABLED=0)');
    commitBootSnapshot({ status: 'skipped', skipReason: 'strategy_disabled' });
    appendLiveReconcileReportJsonl({
      reconcileStatus: 'skipped',
      ok: true,
      skipReason: 'strategy_disabled',
    });
  } else if (!liveCfg.liveReplayOnBoot) {
    commitBootSnapshot({ status: 'skipped', skipReason: 'replay_off' });
    appendLiveReconcileReportJsonl({
      reconcileStatus: 'skipped',
      ok: true,
      skipReason: 'replay_off',
    });
  } else {
    let anchorRpcPendingMints: string[] = [];

    liveStrategyReplay = replayLiveStrategyJournal(replayJournalOpts());
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

    if (liveCfg.executionMode === 'live' && liveCfg.walletSecret?.trim()) {
      try {
        const pk = loadLiveKeypairFromSecretEnv(liveCfg.walletSecret.trim()).publicKey.toBase58();
        const repair = await repairMissedLiveBuysFromJournal({
          liveCfg,
          paperCfg: paperBaseline,
          initialOpen: liveStrategyReplay.open,
          walletPubkey: pk,
        });
        if (repair.appended > 0) {
          log.info(repair, 'live-oscar repaired missed on-chain buys into live journal');
          liveStrategyReplay = replayLiveStrategyJournal(replayJournalOpts());
        }
      } catch (err) {
        log.warn({ err: (err as Error)?.message }, 'repairMissedLiveBuysFromJournal failed');
      }
    }

    if (
      liveCfg.executionMode === 'live' &&
      liveCfg.liveAnchorVerifyOnBoot &&
      liveCfg.walletSecret?.trim()
    ) {
      try {
        const v = await verifyReplayedOpenBuyAnchorsOnBoot({
          liveCfg,
          open: liveStrategyReplay.open,
        });
        liveStrategyReplay = { ...liveStrategyReplay, open: v.open };
        anchorRpcPendingMints = v.rpcPendingMints;
        if (v.ghostDetails.length) {
          bootQuarantineMintPrefixes = v.ghostDetails.map((g) => g.mint.slice(0, 8));
          for (const g of v.ghostDetails) {
            appendLiveJsonlEvent({
              kind: 'live_reconcile_quarantine',
              mint: g.mint,
              reason: g.reason,
            });
          }
        }
        log.info(
          {
            replayOpenAfterAnchors: liveStrategyReplay.open.size,
            ghosts: v.ghostDetails.length,
            rpcPending: anchorRpcPendingMints.length,
          },
          'live-oscar p7.1 boot anchor verify',
        );
      } catch (err) {
        log.warn({ err: (err as Error)?.message }, 'verifyReplayedOpenBuyAnchorsOnBoot failed');
      }
    }

    let txAnchorSample: TxAnchorSampleResult | undefined;
    if (liveCfg.liveReconcileTxSampleN > 0) {
      const sigs = collectRecentConfirmedTxSignatures({
        storePath: liveCfg.liveTradesPath,
        strategyId: liveCfg.strategyId,
        limit: liveCfg.liveReconcileTxSampleN,
        maxFileBytes: liveCfg.liveReplayMaxFileBytes,
      });
      txAnchorSample = await verifyTxAnchorSample(liveCfg, sigs);
      if (txAnchorSample.notFound.length > 0 || txAnchorSample.rpcErrors > 0) {
        log.warn({ txAnchorSample }, 'live-oscar Phase 7 tx anchor sample issues');
      }
    }

    if (liveCfg.executionMode === 'dry_run') {
      commitBootSnapshot({ status: 'skipped', skipReason: 'dry_run', journalTruncated });
      appendLiveReconcileReportJsonl({
        reconcileStatus: 'skipped',
        ok: true,
        skipReason: 'dry_run',
        journalReplayTruncated: journalTruncated,
        txAnchorSample,
      });
    } else if (liveCfg.executionMode !== 'simulate' && liveCfg.executionMode !== 'live') {
      commitBootSnapshot({ status: 'skipped', skipReason: 'execution_mode', journalTruncated });
      appendLiveReconcileReportJsonl({
        reconcileStatus: 'skipped',
        ok: true,
        skipReason: 'execution_mode',
        journalReplayTruncated: journalTruncated,
        txAnchorSample,
      });
    } else if (anchorRpcPendingMints.length > 0) {
      log.warn({ anchorRpcPendingMints }, 'live-oscar boot anchor verify still pending RPC (no exposure block)');
      commitBootSnapshot({
        status: 'skipped',
        skipReason: 'anchor_verify_rpc_pending',
        journalTruncated,
        quarantinedMints: bootQuarantineMintPrefixes,
      });
      appendLiveJsonlEvent({
        kind: 'execution_skip',
        reason: 'anchor_verify_rpc_pending',
        detail: JSON.stringify({ anchorRpcPendingMints }).slice(0, 500),
      });
      appendLiveReconcileReportJsonl({
        reconcileStatus: 'skipped',
        ok: true,
        skipReason: 'anchor_verify_rpc_pending',
        journalReplayTruncated: journalTruncated,
        txAnchorSample,
        anchorRpcPendingMints,
        quarantinedMints: bootQuarantineMintPrefixes,
      });
    } else {
      commitBootSnapshot({
        status: 'skipped',
        skipReason: 'spl_reconcile_removed',
        journalTruncated,
        quarantinedMints: bootQuarantineMintPrefixes,
      });
      appendLiveReconcileReportJsonl({
        reconcileStatus: 'skipped',
        ok: true,
        skipReason: 'spl_reconcile_removed',
        journalReplayTruncated: journalTruncated,
        txAnchorSample,
        quarantinedMints: bootQuarantineMintPrefixes,
      });
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

  await paperOscarMain({
    journalAppend: () => {},
    skipPaperJsonlStore: true,
    liveStrategyReplay,
    journalLiveStrategy: (body) => appendLiveJsonlEvent(body),
    liveOscarFactory: (deps) => createLiveOscarPhase5Bundle(liveCfg, deps, paperBaseline.positionUsd),
    onShutdown: (sig) => {
      appendLiveJsonlEvent({ kind: 'live_shutdown', sig }, { sync: true });
    },
    livePeriodicSelfHealFactory: (ctx) => startLivePeriodicSelfHeal({ ...ctx, liveCfg }),

    onOscarHeartbeat: ({ openPositions, closedTotal, stats, trackerClosed }) => {
      const maxBlockMs = liveCfg.liveReconcileBlockMaxMs;
      if (
        maxBlockMs > 0 &&
        liveReconcileBlocksNewExposure() &&
        liveCfg.strategyEnabled &&
        (liveCfg.executionMode === 'live' || liveCfg.executionMode === 'simulate')
      ) {
        const ageSec = liveReconcileBlockAgeSec();
        if (ageSec != null && ageSec * 1000 >= maxBlockMs) {
          clearLiveReconcileBlock();
          appendLiveJsonlEvent({
            kind: 'risk_note',
            reason: 'exposure_block_ttl_cleared',
            detail: { ageSec: +ageSec.toFixed(1), maxMs: maxBlockMs },
          });
          log.warn(
            { ageSec, maxMs: maxBlockMs },
            'exposure block cleared by LIVE_RECONCILE_BLOCK_MAX_MS (parity / legacy flag; emergency)',
          );
        }
      }

      const boot = getLiveReconcileBootSnapshot();
      const qm = boot?.quarantinedMints ?? bootQuarantineMintPrefixes;
      const blockAgeSec = liveReconcileBlockAgeSec();
      appendLiveJsonlEvent({
        kind: 'heartbeat',
        uptimeSec: Math.floor(process.uptime()),
        openPositions,
        closedTotal,
        liveStrategyEnabled: liveCfg.strategyEnabled,
        executionMode: liveCfg.executionMode,
        note: `W8.0-p7 oscar: opened=${stats.opened} ticks=${stats.ticks} errors=${stats.errors} tracker=${JSON.stringify(trackerClosed)}`,
        ...(liveReconcileBlocksNewExposure()
          ? {
              reconcileBlocksNewExposure: true,
              ...(blockAgeSec != null ? { reconcileBlockAgeSec: +blockAgeSec.toFixed(1) } : {}),
            }
          : {}),
        ...(boot && {
          reconcileBootStatus: boot.status,
          reconcileBootSkipReason: boot.skipReason,
          reconcileMintsDivergent: boot.divergentMints,
          reconcileWalletSolLamports: boot.walletSolLamports ?? undefined,
          reconcileChainOnlyMints: boot.chainOnlyMints,
          journalReplayTruncated: boot.journalTruncated,
        }),
        ...(qm?.length ? { quarantinedMints: qm } : {}),
      });
    },
  });
}
