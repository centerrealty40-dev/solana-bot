/**
 * W8.0 Live Oscar — Phase 4: reuse paper Oscar gates + tracker; live JSONL + Jupiter simulate only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import pino from 'pino';
import { loadLiveOscarConfig } from './config.js';
import { runLiveJupiterSelfTest } from './jupiter-self-test.js';
import { runLivePhase3SimSelfTest } from './phase3-self-test.js';
import { createLiveDiscoveryAuditJournalAppend } from './discovery-audit-jsonl.js';
import { appendLiveJsonlEvent, configureLiveStore } from './store-jsonl.js';
import { configureSignalLabStore } from './signal-lab.js';
import { configureMtmShadowStore } from './mtm-shadow.js';
import { configureStagedAddSimCooldown } from './staged-add-sim-cooldown.js';
import { configureMintTimedLossCooldown } from './mint-timed-loss-cooldown.js';
import { configureMintScratchReentry } from './mint-scratch-reentry.js';
import { configureAdaptivePriorityFee } from './adaptive-priority-fee.js';
import { initMintFileWatchers } from './mint-file-watchers.js';
import { startLiveDailySummary } from './daily-summary.js';
import { loadPaperTraderConfig } from '../papertrader/config.js';
import {
  assertLiveOscarUnifiedEntrySizing,
  resolveLiveOscarEntrySplitLegUsd,
} from '../papertrader/live-oscar-entry-sizing.js';
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
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';
import type { OpenTrade } from '../papertrader/types.js';
import {
  discoveryHealthSummaryRolling,
  getNearReadyDipWatchlist,
} from '../papertrader/discovery-health-window.js';
import { gmgnMintHrefHtml } from '../papertrader/discovery/near-ready-dip-watch.js';
import { sendTagged } from '../core/telegram/sender.js';
import { liveConsecSimFailCount } from './phase5-state.js';
import { tickLiveBtcGateTelegram } from './btc-gate-telegram.js';
import {
  buildSnapshotStaleAlertBody,
  fetchDexSnapshotFreshness,
  formatSnapshotFreshnessPulseLine,
  snapshotMaxAgeSecFromEnv,
  snapshotsAnyStale,
} from '../ingestion/pair-snapshot-freshness.js';
import {
  isLiveBuyDiscoveryTelegramSuppressed,
  refreshLiveBuyTelegramSuppressForTick,
} from './wallet-buy-affordability.js';
import type { PaperTraderConfig } from '../papertrader/config.js';

const log = pino({ name: 'live-oscar' });

/** Минты из прошлого HEALTH-сообщения (не считаем всё множество «новым» при первом pulse). */
let prevHbNearReadyMintSet: Set<string> | null = null;

function escapeHtmlPlain(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function liveOscarDiscoveryBuyLegUsd(paperCfg: PaperTraderConfig): number {
  if (paperCfg.liveStagedEntryEnabled && paperCfg.liveStagedEntryEntrySplitLegUsd > 0) {
    return resolveLiveOscarEntrySplitLegUsd(paperCfg);
  }
  return paperCfg.positionUsd * paperCfg.entryFirstLegFraction;
}

async function writeDiscoveryHealthSnapshotFile(extras?: {
  nearReadyDipWaitCount?: number;
  nearReadyDipNewSinceLastHb?: number;
}): Promise<void> {
  const h = discoveryHealthSummaryRolling();
  const file =
    process.env.LIVE_DISCOVERY_HEALTH_SNAPSHOT_PATH?.trim() ||
    path.join('data', 'live-discovery-health.json');
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      windowMs: h.windowMs,
      discovered: h.discovered,
      evaluated: h.evaluated,
      gateFail: h.gateFail,
      opened: h.opened,
      discoveryTicks: h.discoveryTicks,
      ...(extras?.nearReadyDipWaitCount != null
        ? { nearReadyDipWaitCount: extras.nearReadyDipWaitCount }
        : {}),
      ...(extras?.nearReadyDipNewSinceLastHb != null
        ? { nearReadyDipNewSinceLastHb: extras.nearReadyDipNewSinceLastHb }
        : {}),
    }),
    'utf8',
  );
}

/** Skip orphan RECONCILE_ORPHAN right after `entryTs` (RPC / indexer lag vs fresh buys). */
const LIVE_ORPHAN_RECONCILE_MIN_AGE_MS = 120_000;

/** Optional second `.env` fragment with `PAPER_*` baseline for parity (W8.0-p4 §3.3.1). */
function loadOptionalInheritEnv(): void {
  const p = process.env.LIVE_INHERIT_ENV_FILE?.trim();
  if (!p) return;
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  dotenv.config({ path: abs });
}

export async function main(): Promise<void> {
  /** PM2 не подмешивает `.env` автоматически — подтягиваем секреты/TELEGRAM_* как у остальных сервисов. */
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });
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
  configureSignalLabStore({ storePath: liveCfg.signalLabPath, strategyId: liveCfg.strategyId });
  configureMtmShadowStore({ storePath: liveCfg.mtmShadowPath, strategyId: liveCfg.strategyId });
  configureStagedAddSimCooldown(
    {
      streakThreshold: liveCfg.liveStagedAddSimErrThreshold,
      cooldownMs: liveCfg.liveStagedAddSimErrCooldownMs,
      autoDenylistEnabled: liveCfg.liveStagedAddAutoDenylistEnabled,
      autoDenylistRearmsThreshold: liveCfg.liveStagedAddAutoDenylistRearmsThreshold,
      autoDenylistTelegramEnabled: liveCfg.liveStagedAddAutoDenylistTelegramEnabled,
    },
    liveCfg,
  );
  configureMintTimedLossCooldown(liveCfg);
  configureMintScratchReentry(liveCfg);
  configureAdaptivePriorityFee({
    enabled: liveCfg.liveAdaptivePriorityFeeEnabled,
    threshold: liveCfg.liveAdaptivePriorityFeeThreshold,
    windowMs: liveCfg.liveAdaptivePriorityFeeWindowMs,
    boostFactor: liveCfg.liveAdaptivePriorityFeeBoostFactor,
    holdMs: liveCfg.liveAdaptivePriorityFeeHoldMs,
  });
  /** 1.11.231 — реактивный hot-reload whitelist + denylist (mtime-poll работал и раньше). */
  initMintFileWatchers(liveCfg);
  /** 1.11.231 — Daily Telegram-сводка по live-oscar. */
  startLiveDailySummary(liveCfg);
  const paperBaseline = loadPaperTraderConfig();
  assertLiveOscarUnifiedEntrySizing(paperBaseline);

  if (
    liveCfg.strategyEnabled &&
    liveCfg.executionMode === 'live' &&
    paperBaseline.entryFirstLegFraction < 1 - 1e-9 &&
    !liveCfg.liveEntryScaleInEnabled &&
    !paperBaseline.liveStagedEntryEnabled
  ) {
    throw new Error(
      'live-oscar: PAPER_ENTRY_FIRST_LEG_FRACTION < 1 requires LIVE_ENTRY_SCALE_IN_ENABLED=1 or PAPER_LIVE_STAGED_ENTRY_ENABLED=1.',
    );
  }

  if (
    liveCfg.strategyEnabled &&
    (liveCfg.executionMode === 'live' || liveCfg.executionMode === 'simulate')
  ) {
    const maxUsd = liveCfg.liveMaxPositionUsd;
    if (
      maxUsd != null &&
      Number.isFinite(maxUsd) &&
      paperBaseline.positionUsd > maxUsd + 1e-6
    ) {
      throw new Error(
        `live-oscar: PAPER_POSITION_USD (${paperBaseline.positionUsd}) exceeds LIVE_MAX_POSITION_USD (${maxUsd}). Fix env / LIVE_INHERIT_ENV_FILE (see ecosystem live-oscar).`,
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

  const orphanReconcileLive =
    liveCfg.strategyEnabled &&
    (liveCfg.executionMode === 'live' || liveCfg.executionMode === 'simulate') &&
    Boolean(liveCfg.walletSecret?.trim());

  await paperOscarMain({
    heartbeatIntervalMsOverride: liveCfg.heartbeatIntervalMs,
    journalAppend: createLiveDiscoveryAuditJournalAppend(liveCfg.liveDiscoveryAuditJsonlEnabled),
    skipPaperJsonlStore: true,
    liveStrategyReplay,
    journalLiveStrategy: (body) => appendLiveJsonlEvent(body),
    liveOscarFactory: (deps) => createLiveOscarPhase5Bundle(liveCfg, deps, paperBaseline.positionUsd),
    onShutdown: (sig) => {
      appendLiveJsonlEvent({ kind: 'live_shutdown', sig }, { sync: true });
    },
    livePeriodicSelfHealFactory: (ctx) => startLivePeriodicSelfHeal({ ...ctx, liveCfg }),

    reconcilePaperCloseZeroMints: orphanReconcileLive
      ? async (open: Map<string, OpenTrade>) => {
          const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
          if (!chainMap) return undefined;
          const orphans: string[] = [];
          for (const mint of open.keys()) {
            const b = chainMap.get(mint);
            if (!b || b === 0n) orphans.push(mint);
          }
          return orphans.length ? orphans : undefined;
        }
      : undefined,
    verifyReconcileOrphanWalletZero: orphanReconcileLive
      ? async (mint: string) => {
          const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
          if (!chainMap) return false;
          const b = chainMap.get(mint);
          return !b || b === 0n;
        }
      : undefined,
    reconcileOrphanMinPositionAgeMs: orphanReconcileLive ? LIVE_ORPHAN_RECONCILE_MIN_AGE_MS : undefined,

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
      const dh = discoveryHealthSummaryRolling();
      const dhMin = Math.max(1, Math.round(dh.windowMs / 60_000));
      const legacyDisc =
        process.env.LIVE_HEARTBEAT_LEGACY_DISC_JSONL?.trim() === '1' ||
        process.env.LIVE_HEARTBEAT_LEGACY_DISC_TELEGRAM?.trim() === '1';

      const nearListRaw = getNearReadyDipWatchlist();
      const nearDedup = new Map<string, { mint: string; symbol: string }>();
      for (const x of nearListRaw) {
        const m = x.mint.trim();
        if (!m) continue;
        if (!nearDedup.has(m)) nearDedup.set(m, { mint: m, symbol: x.symbol || '?' });
      }
      const nearList = [...nearDedup.values()];
      const nearCount = nearList.length;
      const currNearSet = new Set(nearList.map((x) => x.mint));
      let newSinceLastHb = 0;
      let newcomersFull: typeof nearList = [];
      if (prevHbNearReadyMintSet === null) {
        prevHbNearReadyMintSet = new Set(currNearSet);
      } else {
        newcomersFull = nearList.filter((x) => !prevHbNearReadyMintSet!.has(x.mint));
        newSinceLastHb = newcomersFull.length;
        prevHbNearReadyMintSet = new Set(currNearSet);
      }

      const simStreak = liveConsecSimFailCount();
      let note = `W8.0-p7 oscar: opened=${stats.opened} skip_live_wl=${stats.skippedLiveMintWhitelist ?? 0} skip_live_permanent_deny=${stats.skippedLivePermanentDeny ?? 0} disc_cycles=${stats.ticks} near_ready_dip_wait=${nearCount} near_ready_new_hb=${newSinceLastHb} consec_sim_fail=${simStreak} errors=${stats.errors} tracker=${JSON.stringify(trackerClosed)}`;
      if (legacyDisc) {
        note += ` ${dhMin}m_cand=${dh.discovered} ${dhMin}m_eval=${dh.evaluated} ${dhMin}m_gate_skip=${dh.gateFail} ${dhMin}m_opened=${dh.opened} ${dhMin}m_disc_ticks=${dh.discoveryTicks}`;
      }

      appendLiveJsonlEvent({
        kind: 'heartbeat',
        uptimeSec: Math.floor(process.uptime()),
        openPositions,
        closedTotal,
        liveStrategyEnabled: liveCfg.strategyEnabled,
        executionMode: liveCfg.executionMode,
        note,
        nearReadyDipWaitCount: nearCount,
        nearReadyDipNewSinceLastHb: newSinceLastHb,
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
        consecSimFailStreak: simStreak,
      });

      void writeDiscoveryHealthSnapshotFile({
        nearReadyDipWaitCount: nearCount,
        nearReadyDipNewSinceLastHb: newSinceLastHb,
      }).catch((e) => log.warn({ err: String(e) }, 'live discovery health snapshot write failed'));

      tickLiveBtcGateTelegram(liveCfg);

      const tgHeartbeatOff = process.env.LIVE_TELEGRAM_HEARTBEAT?.trim() === '0';
      /**
       * 1.11.235 — отдельный switch: слать health-pulse в Telegram **только когда
       * есть отклонения** (`stats.errors > 0` / `simStreak > 0` / `snapshot stale`).
       * При нормальном состоянии — silent. `snapshot_stale` ALERT отправляется
       * независимо от этого флага (это диагностика реальной PG-проблемы).
       *
       * Включается env `LIVE_TELEGRAM_HEALTH_PULSE_ONLY_ON_ALERT=1`.
       * Полностью отключить heartbeat (включая alerts) можно как раньше:
       * `LIVE_TELEGRAM_HEARTBEAT=0`.
       */
      const tgPulseOnlyOnAlert =
        process.env.LIVE_TELEGRAM_HEALTH_PULSE_ONLY_ON_ALERT?.trim() === '1';
      if (!tgHeartbeatOff) {
        void (async () => {
          if (liveCfg.executionMode === 'live') {
            await refreshLiveBuyTelegramSuppressForTick(
              liveCfg,
              liveOscarDiscoveryBuyLegUsd(paperBaseline),
            );
          }
          const suppressCoinTg = isLiveBuyDiscoveryTelegramSuppressed();

        const tok = process.env.TELEGRAM_BOT_TOKEN?.trim();
        const chat = process.env.TELEGRAM_CHAT_ID?.trim();
        const wlTok = process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim();
        const wlChat = process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim();
        const wMin = dhMin;
        const legacyTg = process.env.LIVE_HEARTBEAT_LEGACY_DISC_TELEGRAM?.trim() === '1';
        const snapMaxSec = snapshotMaxAgeSecFromEnv();
        let snapPulseLine = 'snap_worst_age_min=?';
        let snapStale = false;
        try {
          const snapRows = await fetchDexSnapshotFreshness(snapMaxSec);
          snapPulseLine = formatSnapshotFreshnessPulseLine(snapRows);
          snapStale = snapshotsAnyStale(snapRows, snapMaxSec);
          if (snapStale) {
            void sendTagged('ALERT', 'snapshot_stale', buildSnapshotStaleAlertBody(snapRows, snapMaxSec), {
              skipQuietHours: true,
            }).catch((e) => log.warn({ err: String(e) }, 'snapshot stale alert telegram failed'));
          }
        } catch (e) {
          snapPulseLine = 'snap_worst_age_min=err';
          log.warn({ err: String(e) }, 'snapshot freshness check failed');
        }

        /**
         * 1.11.235 — при `LIVE_TELEGRAM_HEALTH_PULSE_ONLY_ON_ALERT=1` отправляем pulse
         * только если что-то ненормально. Иначе тихо выходим (alert уже выше отправлен).
         */
        const hasIncident = stats.errors > 0 || simStreak > 0 || snapStale;
        if (tgPulseOnlyOnAlert && !hasIncident) {
          return;
        }
        const baseLines = [
          `uptime=${Math.floor(process.uptime())}s`,
          `open=${openPositions}`,
          `closed=${closedTotal}`,
          `mode=${liveCfg.executionMode}`,
          `strat=${liveCfg.strategyId}`,
          `near_ready_dip_wait=${nearCount}`,
          `near_ready_new_since_last_pulse=${newSinceLastHb}`,
          `consec_sim_fail=${simStreak}`,
          `disc_cycles_total=${stats.ticks}`,
          `${wMin}m cand=${dh.discovered} eval=${dh.evaluated} gate_skip=${dh.gateFail} opened_win=${dh.opened}`,
          snapPulseLine,
          `errors=${stats.errors}`,
          `opened_total=${stats.opened}`,
        ];
        if (legacyTg) {
          baseLines.splice(9, 0, `${wMin}m disc_ticks=${dh.discoveryTicks}`);
        }

        const rawMax = process.env.LIVE_HEARTBEAT_NEAR_READY_MAX_LINES?.trim();
        const parsedMax = rawMax ? Number.parseInt(rawMax, 10) : 15;
        const maxNew = Number.isFinite(parsedMax) ? Math.max(1, Math.min(25, parsedMax)) : 15;
        const newcomersTg = suppressCoinTg ? [] : newcomersFull.slice(0, maxNew);
        let pulseBody: string;
        let parseMode: 'HTML' | undefined;
        if (newcomersTg.length > 0) {
          parseMode = 'HTML';
          const linesEscaped = baseLines.map(escapeHtmlPlain).join('\n');
          const rows = newcomersTg
            .map((x) => `<b>${escapeHtmlPlain(x.symbol)}</b> ${gmgnMintHrefHtml(x.mint, x.mint)}`)
            .join('\n');
          const more =
            newcomersFull.length > maxNew
              ? `\n<i>+${newcomersFull.length - maxNew} more</i>`
              : '';
          pulseBody = `${linesEscaped}\n\n<b>new_on_horizon</b>\n${rows}${more}`;
        } else {
          pulseBody = baseLines.join('\n');
        }

        const sendPulse = (token: string | undefined, chatId: string | undefined, viaWl: boolean): void => {
          if (!token || !chatId) return;
          const out =
            viaWl && parseMode === 'HTML'
              ? `${pulseBody}\n<i>via=wl_bot</i>`
              : viaWl
                ? `${pulseBody} via=wl_bot`
                : pulseBody;
          void sendTagged('HEALTH', 'live_oscar_pulse', out, {
            skipQuietHours: true,
            parseMode,
            ...(viaWl ? { telegramBotToken: token, telegramChatId: chatId } : {}),
          }).catch((e) => log.warn({ err: String(e) }, 'live heartbeat telegram failed'));
        };

        if (tok && chat) {
          sendPulse(tok, chat, false);
        } else if (wlTok && wlChat) {
          sendPulse(wlTok, wlChat, true);
        } else {
          log.warn({}, 'live heartbeat telegram skipped: set TELEGRAM_BOT_TOKEN/CHAT_ID or LIVE_MINT_WHITELIST_TELEGRAM_*');
        }
        })().catch((e) => log.warn({ err: String(e) }, 'live heartbeat telegram failed'));
      }
    },
  });
}
