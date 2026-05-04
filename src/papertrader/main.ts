import pino from 'pino';
import {
  loadPaperTraderConfig,
  parseDcaLevels,
  parseFollowupOffsets,
  parseTpLadder,
} from './config.js';
import { configureStore, appendEvent } from './store-jsonl.js';
import type { LiveOscarRuntimeBundle, LiveOscarStrategyDeps } from '../live/phase4-types.js';
import {
  refreshSolPrice,
  getSolUsd,
  refreshBtcContext,
  getBtcContext,
  getLiveMcUsd,
} from './pricing.js';
import { startPriorityFeeTicker, stopPriorityFeeTicker, getPriorityFeeUsd } from './pricing/priority-fee.js';
import { verifyEntryPrice } from './pricing/price-verify.js';
import { runOpenSimAudit } from './pricing/sim-audit.js';
import { runImpulseConfirmGate, takeImpulseJupiterReuse } from './pricing/impulse-confirm.js';
import {
  evaluatedAtMap,
  lastEntryTsByMintMap,
  recordEntryTs,
  runDipDiscovery,
} from './discovery/dip-clones.js';
import { fetchLaunchpadCandidates } from './discovery/launchpad.js';
import { fetchFreshValidatedCandidates } from './discovery/fresh-validated.js';
import { makeOpenTradeFromEntry, snapshotSourceToDex } from './executor/open.js';
import { fetchPreEntryDynamics } from './executor/dynamics.js';
import { fetchContextSwaps } from './executor/context-swaps.js';
import { followupTick, schedulePendingFollowups, pendingFollowupsCount } from './executor/followup.js';
import { trackerTick, type TrackerStats } from './executor/tracker.js';
import { reconcileOpenTradeDcaFromLegs } from './executor/dca-state.js';
import { loadStore } from './executor/store-restore.js';
import type {
  ClosedTrade,
  ExitReason,
  OpenTrade,
  PriceVerifyVerdict,
  SafetyVerdict,
  SimAuditStamp,
} from './types.js';
import { isMintBlockedForAmbiguousLiveBuy } from '../live/pending-buy-cooldown.js';
import type { LivePeriodicSelfHealPaperContext } from '../live/periodic-self-heal.js';
import { applyLiveBuyAnchorsAfterOpen } from '../live/live-buy-anchor.js';
import { serializeOpenTrade } from '../live/strategy-snapshot.js';
import { evaluateMintSafety } from './safety/index.js';
import { getHoldersResolveStats } from './holders/holders-resolve.js';

const logger = pino({ name: 'papertrader' });

export interface PapertraderMainOptions {
  /** Default: paper JSONL `appendEvent`. Live-oscar passes noop (P4-I1). */
  journalAppend?: (event: Record<string, unknown>) => void;
  /** Live-oscar: do not read/write paper store path. */
  skipPaperJsonlStore?: boolean;
  liveOscar?: LiveOscarRuntimeBundle;
  /** Phase 5 — bundle needs live open/closed maps; preferred over `liveOscar` when both set. */
  liveOscarFactory?: (deps: LiveOscarStrategyDeps) => LiveOscarRuntimeBundle;
  /** Phase 7 — seed from live JSONL replay (`live-oscar` + `skipPaperJsonlStore`). */
  liveStrategyReplay?: { open: Map<string, OpenTrade>; closed: ClosedTrade[] };
  /** Phase 7 — validated live JSONL mirror events (`live_position_*`). */
  journalLiveStrategy?: (event: Record<string, unknown>) => void;
  /** Live: tracker tick — opens with zero on-chain SPL balance → RECONCILE_ORPHAN (see `tracker.ts`). */
  reconcilePaperCloseZeroMints?: (
    open: Map<string, OpenTrade>,
  ) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** Live: SPL re-read before orphan close — avoid false orphan on transient RPC/indexer empty reads. */
  verifyReconcileOrphanWalletZero?: (mint: string) => Promise<boolean>;
  /** Optional: min age since `entryTs` before RECONCILE_ORPHAN paper-close (live integrations). */
  reconcileOrphanMinPositionAgeMs?: number;
  onShutdown?: (signal: string) => void;
  /**
   * Live-oscar only: periodic tail sweep + stuck-open force exit (`live/main` closes over `liveCfg`).
   */
  livePeriodicSelfHealFactory?: (
    ctx: LivePeriodicSelfHealPaperContext,
  ) => ReturnType<typeof setInterval> | null;

  onOscarHeartbeat?: (payload: {
    openPositions: number;
    closedTotal: number;
    stats: {
      discovered: number;
      evaluated: number;
      passed: number;
      opened: number;
      skippedSafety: number;
      skippedPriceVerify: number;
      ticks: number;
      errors: number;
    };
    trackerClosed: TrackerStats['closed'];
  }) => void;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

export async function main(opts?: PapertraderMainOptions): Promise<void> {
  const cfg = loadPaperTraderConfig();
  const journalAppend =
    opts?.journalAppend ??
    ((e: Record<string, unknown>) => {
      appendEvent(e as never);
    });

  if (!opts?.skipPaperJsonlStore) {
    configureStore({ storePath: cfg.storePath, strategyId: cfg.strategyId });
  }

  void fetchLaunchpadCandidates;
  void fetchFreshValidatedCandidates;

  const dcaLevels = parseDcaLevels(cfg.dcaLevelsSpec);
  const tpLadder = cfg.tpGridStepPnl > 0 ? [] : parseTpLadder(cfg.tpLadderSpec);
  const followupOffsets = parseFollowupOffsets(cfg.followupOffsetsMinSpec);

  const restored = opts?.skipPaperJsonlStore
    ? {
        evaluatedAt: new Map<string, number>(),
        lastEntryTsByMint: new Map<string, number>(),
        open: new Map<string, OpenTrade>(),
      }
    : loadStore(cfg.storePath);
  for (const [mint, ts] of restored.evaluatedAt) evaluatedAtMap.set(mint, ts);
  for (const [mint, ts] of restored.lastEntryTsByMint) lastEntryTsByMintMap.set(mint, ts);
  const open: Map<string, OpenTrade> =
    opts?.skipPaperJsonlStore && opts.liveStrategyReplay ? opts.liveStrategyReplay.open : restored.open;
  for (const ot of open.values()) {
    reconcileOpenTradeDcaFromLegs(ot, dcaLevels);
  }
  const closed: ClosedTrade[] =
    opts?.skipPaperJsonlStore && opts.liveStrategyReplay ? [...opts.liveStrategyReplay.closed] : [];

  let liveOscarResolved = false;
  let cachedLiveOscar: LiveOscarRuntimeBundle | undefined;
  function resolveLiveOscar(): LiveOscarRuntimeBundle | undefined {
    if (liveOscarResolved) return cachedLiveOscar;
    liveOscarResolved = true;
    if (opts?.liveOscarFactory) {
      cachedLiveOscar = opts.liveOscarFactory({
        getOpen: () => open,
        getClosed: () => closed,
      });
      return cachedLiveOscar;
    }
    cachedLiveOscar = opts?.liveOscar;
    return cachedLiveOscar;
  }

  const startedAt = Date.now();
  const stats = {
    discovered: 0,
    evaluated: 0,
    passed: 0,
    opened: 0,
    skippedSafety: 0,
    skippedPriceVerify: 0,
    ticks: 0,
    errors: 0,
  };
  const trackerStats: TrackerStats = {
    closed: {
      TP: 0,
      SL: 0,
      TRAIL: 0,
      TIMEOUT: 0,
      NO_DATA: 0,
      KILLSTOP: 0,
      LIQ_DRAIN: 0,
      RECONCILE_ORPHAN: 0,
      PERIODIC_HEAL: 0,
    } as Record<ExitReason, number>,
    skippedPriceVerifyExit: 0,
  };

  logger.info({
    msg: 'papertrader executor start',
    strategyId: cfg.strategyId,
    strategyKind: cfg.strategyKind,
    storePath: cfg.storePath,
    positionUsd: cfg.positionUsd,
    dryRun: cfg.dryRun,
    whaleEnabled: cfg.whaleEnabled,
    dcaLevels: dcaLevels.length,
    tpLadder: tpLadder.length,
    tpGridStepPnl: cfg.tpGridStepPnl,
    followupOffsets,
    tpX: cfg.tpX,
    slX: cfg.slX,
    trailDrop: cfg.trailDrop,
    trailTriggerX: cfg.trailTriggerX,
    trailMode: cfg.trailMode,
    timeoutHours: cfg.timeoutHours,
    restoredOpen: open.size,
    safetyCheckEnabled: cfg.safetyCheckEnabled,
    priorityFeeEnabled: cfg.priorityFeeEnabled,
    holdersLive: cfg.holdersLiveEnabled
      ? {
          enabled: true,
          minHolderCount: cfg.globalMinHolderCount,
          ttlMs: cfg.holdersTtlMs,
          maxPerTick: cfg.holdersMaxPerTick,
          includeToken2022: cfg.holdersIncludeToken2022,
          onFail: cfg.holdersOnFail,
          dbWriteback: cfg.holdersDbWriteback,
          useAddon: cfg.holdersUseQnAddon,
        }
      : { enabled: false },
    impulseConfirm: cfg.impulseConfirmEnabled
      ? {
          enabled: true,
          dipPolicy: cfg.impulseDipPolicy,
          pgDropPct: cfg.impulsePgMinDropPct,
          dipPolicyDetail: cfg.impulsePgAbsMode ? `abs>=${cfg.impulsePgMinAbsPct}%` : undefined,
        }
      : { enabled: false },
  });

  await Promise.allSettled([refreshSolPrice(), refreshBtcContext(cfg)]);
  startPriorityFeeTicker(cfg);

  async function discoveryTick(): Promise<void> {
    stats.ticks++;
    try {
      if (cfg.strategyKind !== 'dip') return;
      const res = await runDipDiscovery(cfg);
      stats.discovered += res.discovered;
      stats.evaluated += res.evaluated;
      stats.passed += res.passed;
      const btc = getBtcContext();
      for (const d of res.decisions) {
        journalAppend({
          kind: 'eval',
          lane: d.lane,
          source: d.source,
          mint: d.mint,
          symbol: d.symbol,
          ageMin: d.ageMin,
          pass: d.pass,
          reasons: d.reasons,
          m: d.features,
          btc,
          whale_analysis: d.whale,
          holders_meta: d.holdersMeta ?? null,
          entry_path: d.entryPath,
        });
        if (!d.pass) continue;
        if (open.has(d.mint)) {
          journalAppend({
            kind: 'eval-skip-open',
            lane: d.lane,
            source: d.source,
            mint: d.mint,
            reason: 'already_open',
          });
          continue;
        }
        if (resolveLiveOscar() && isMintBlockedForAmbiguousLiveBuy(d.mint)) {
          opts?.journalLiveStrategy?.({
            kind: 'execution_skip',
            reason: 'live_ambiguous_buy_cooldown:discovery',
            detail: d.mint.slice(0, 12),
          });
          continue;
        }
        if (cfg.dryRun && !resolveLiveOscar()) continue;

        const dex = snapshotSourceToDex(d.source);
        const row = {
          mint: d.mint,
          symbol: d.symbol,
          ts: new Date(),
          launch_ts: null,
          age_min: d.ageMin,
          price_usd: d.features.price_usd,
          liquidity_usd: d.features.liq_usd,
          volume_5m: d.features.vol5m_usd,
          buys_5m: d.features.buys5m,
          sells_5m: d.features.sells5m,
          market_cap_usd: d.features.market_cap_usd,
          source: d.source,
          holder_count: d.features.holders,
          token_age_min: d.features.token_age_min,
          pair_address: d.features.pair_address ?? null,
        };
        let ot = makeOpenTradeFromEntry({
          cfg,
          row,
          lane: d.lane,
          dex,
          liquidityUsd: d.features.liq_usd,
        });

        const preDyn = cfg.preEntryDynamicsEnabled
          ? await fetchPreEntryDynamics(d.mint, ot.entryTs)
          : null;
        const ctxSwaps = await fetchContextSwaps(cfg, d.mint, ot.entryTs);

        let safetyAttached: SafetyVerdict | { skipped: string } | null = null;
        if (cfg.safetyCheckEnabled) {
          const isAmm = ot.metricType !== 'mc';
          const outcome = await evaluateMintSafety(d.mint, {
            topHolderMaxPct: cfg.safetyTopHolderMaxPct,
            requireMintAuthorityNull: cfg.safetyRequireMintAuthNull,
            requireFreezeAuthorityNull: cfg.safetyRequireFreezeAuthNull,
            treatAsAmm: isAmm,
            timeoutMs: cfg.safetyTimeoutMs,
          });
          if (outcome.kind === 'verdict' && !outcome.verdict.ok) {
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              reason: `safety:${outcome.verdict.reasons.join(',')}`,
            });
            stats.skippedSafety += 1;
            continue;
          }
          safetyAttached = outcome.kind === 'verdict' ? outcome.verdict : { skipped: outcome.reason };
        }

        let impulseConfirm: import('./pricing/impulse-confirm.js').ImpulseConfirmStamp | null = null;
        let impulseJupiterReuse: PriceVerifyVerdict | null = null;
        if (cfg.impulseConfirmEnabled) {
          const liveSol = getSolUsd() ?? 0;
          let baseDec: number | null = null;
          if (safetyAttached && 'decimals' in safetyAttached && safetyAttached.decimals != null) {
            const d0 = Number(safetyAttached.decimals);
            if (Number.isFinite(d0) && d0 >= 0 && d0 <= 24) baseDec = Math.floor(d0);
          }
          const ig = await runImpulseConfirmGate({
            cfg,
            lane: d.lane,
            mint: d.mint,
            symbol: d.symbol,
            source: d.source,
            pairAddress: row.pair_address,
            anchorPriceUsd: d.features.price_usd,
            baseDecimals: baseDec,
            solUsd: liveSol,
          });
          impulseConfirm = ig.stamp;
          if (ig.blocksOpen) {
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              reason: ig.reason,
              impulseConfirm: ig.stamp,
            });
            continue;
          }
          impulseJupiterReuse = ig.jupiterVerdictForReuse;
        }

        /** Same as ladder/close rows — lets dashboards show mcap at Open when snapshots have it. */
        let mcUsdLiveOpen: number | null = null;
        try {
          mcUsdLiveOpen = await getLiveMcUsd(
            ot.mint,
            ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap',
          );
        } catch {
          /* best-effort */
        }

        const snapshotEntryPriceUsd = d.features.price_usd;
        let priceVerify: PriceVerifyVerdict | null = null;
        if (cfg.priceVerifyEnabled) {
          let dec = 6;
          if (safetyAttached && 'decimals' in safetyAttached && safetyAttached.decimals != null) {
            const d0 = Number(safetyAttached.decimals);
            if (Number.isFinite(d0) && d0 >= 0) dec = Math.floor(d0);
          }
          try {
            const reused =
              impulseJupiterReuse ??
              takeImpulseJupiterReuse(ot.mint, 3000) ??
              null;
            priceVerify = await verifyEntryPrice({
              cfg,
              mint: ot.mint,
              outMintDecimals: dec,
              sizeUsd: cfg.positionUsd,
              solUsd: getSolUsd() ?? 0,
              snapshotPriceUsd: snapshotEntryPriceUsd,
              reuseVerdict: reused?.kind === 'ok' ? reused : undefined,
            });
          } catch (e) {
            logger.warn({ err: (e as Error)?.message, mint: ot.mint }, 'verifyEntryPrice threw');
            priceVerify = { kind: 'skipped', reason: 'fetch-fail', ts: Date.now() };
          }
          if (priceVerify.kind === 'blocked' && cfg.priceVerifyBlockOnFail) {
            stats.skippedPriceVerify += 1;
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: ot.mint,
              reason: `price_verify:${priceVerify.reason}`,
              snapshotPriceUsd: priceVerify.snapshotPriceUsd,
              jupiterPriceUsd: priceVerify.jupiterPriceUsd,
              slipPct: priceVerify.slipPct,
              priceImpactPct: priceVerify.priceImpactPct,
            });
            continue;
          }
          if (
            priceVerify.kind === 'ok' &&
            cfg.priceVerifyUseJupiterPrice &&
            priceVerify.jupiterPriceUsd > 0
          ) {
            const rowJ = { ...row, price_usd: priceVerify.jupiterPriceUsd, pair_address: row.pair_address };
            ot = makeOpenTradeFromEntry({
              cfg,
              row: rowJ,
              lane: d.lane,
              dex,
              liquidityUsd: d.features.liq_usd,
              entryTs: ot.entryTs,
            });
          }
        }

        const pfQuoteOpen = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);

        let simAudit: SimAuditStamp | null = null;
        if (cfg.simAuditEnabled) {
          try {
            simAudit = await runOpenSimAudit({
              cfg,
              mint: ot.mint,
              entryTs: ot.entryTs,
              solUsd: getSolUsd() ?? 0,
            });
          } catch (e) {
            logger.warn({ err: (e as Error)?.message, mint: ot.mint }, 'runOpenSimAudit threw');
            simAudit = { kind: 'skipped', reason: 'exception', ts: Date.now(), wallMs: 0 };
          }
        }

        let tokenDecimals: number | null = null;
        if (safetyAttached && 'decimals' in safetyAttached && safetyAttached.decimals != null) {
          const d0 = Number(safetyAttached.decimals);
          if (Number.isFinite(d0) && d0 >= 0 && d0 <= 24) tokenDecimals = Math.floor(d0);
        }
        ot.tokenDecimals = tokenDecimals;

        const liveOscar = resolveLiveOscar();
        if (liveOscar) {
          const opened = await liveOscar.discovery.tryExecuteBuyOpen({
            liveCfg: liveOscar.liveCfg,
            paperCfg: cfg,
            ot,
            decision: d,
            snapshotEntryPriceUsd,
            tokenDecimals,
          });
          if (!opened.ok) continue;
          applyLiveBuyAnchorsAfterOpen(ot, opened);
        } else {
          journalAppend({
            kind: 'open',
            mint: ot.mint,
            symbol: ot.symbol,
            lane: ot.lane,
            source: ot.source,
            dex: ot.dex,
            entryTs: ot.entryTs,
            entryMcUsd: ot.entryMcUsd,
            entryMarketPrice: ot.legs[0]?.marketPrice ?? ot.entryMcUsd,
            snapshotEntryPriceUsd,
            legs: ot.legs,
            totalInvestedUsd: ot.totalInvestedUsd,
            avgEntry: ot.avgEntry,
            avgEntryMarket: ot.avgEntryMarket,
            pairAddress: ot.pairAddress,
            entryLiqUsd: ot.entryLiqUsd,
            eval_reasons: d.reasons,
            features: d.features,
            btc,
            whale_analysis: d.whale,
            pre_entry_dynamics: preDyn,
            context_swaps: ctxSwaps,
            safety: safetyAttached,
            mcUsdLive: mcUsdLiveOpen,
            priorityFee: pfQuoteOpen,
            priceVerify: cfg.priceVerifyEnabled ? priceVerify : null,
            impulseConfirm: impulseConfirm ?? undefined,
            ...(simAudit != null ? { simAudit } : {}),
          });
        }

        open.set(ot.mint, ot);
        opts?.journalLiveStrategy?.({
          kind: 'live_position_open',
          mint: ot.mint,
          openTrade: serializeOpenTrade(ot),
        });
        recordEntryTs(ot.mint, ot.entryTs);
        stats.opened++;
        schedulePendingFollowups(
          cfg,
          {
            mint: ot.mint,
            symbol: ot.symbol,
            entryTs: ot.entryTs,
            entryPrice: ot.legs[0]?.price ?? ot.entryMcUsd,
            entryMarketPrice: ot.legs[0]?.marketPrice ?? ot.entryMcUsd,
            metricType: ot.metricType,
            source: ot.source,
          },
          followupOffsets,
        );
      }
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'discovery tick failed', err: (err as Error).message });
    }
  }

  let discoveryRunning = false;
  let trackerRunning = false;
  let followupRunning = false;

  const discoveryTimer = setInterval(async () => {
    if (discoveryRunning) return;
    discoveryRunning = true;
    try {
      await withTimeout(discoveryTick(), 60_000, 'discoveryTick');
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'discovery error', err: (err as Error).message });
    }
    discoveryRunning = false;
  }, cfg.discoveryIntervalMs);

  const trackerTimer = setInterval(async () => {
    if (trackerRunning) return;
    trackerRunning = true;
    try {
      await withTimeout(
        trackerTick({
          cfg,
          open,
          closed,
          dcaLevels,
          tpLadder,
          stats: trackerStats,
          btcCtx: getBtcContext,
          journalAppend,
          journalLiveStrategy: opts?.journalLiveStrategy,
          livePhase4: resolveLiveOscar()?.tracker,
          liveOscarCfg: resolveLiveOscar()?.liveCfg,
          reconcilePaperCloseZeroMints: opts?.reconcilePaperCloseZeroMints,
          verifyReconcileOrphanWalletZero: opts?.verifyReconcileOrphanWalletZero,
          reconcileOrphanMinPositionAgeMs: opts?.reconcileOrphanMinPositionAgeMs,
        }),
        45_000,
        'trackerTick',
      );
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'tracker error', err: (err as Error).message });
    }
    trackerRunning = false;
  }, cfg.trackIntervalMs);

  const followupTimer = setInterval(async () => {
    if (followupRunning) return;
    followupRunning = true;
    try {
      await followupTick();
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'followup error', err: (err as Error).message });
    }
    followupRunning = false;
  }, cfg.followupTickMs);

  const heartbeatTimer = setInterval(() => {
    const holdersStats = cfg.holdersLiveEnabled ? getHoldersResolveStats() : null;
    journalAppend({
      kind: 'heartbeat',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      openPositions: open.size,
      closedTotal: closed.length,
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      note: `dip executor: ticks=${stats.ticks} disc=${stats.discovered} eval=${stats.evaluated} pass=${stats.passed} opened=${stats.opened} skip_safety=${stats.skippedSafety} skip_price_verify=${stats.skippedPriceVerify} skip_price_verify_exit=${trackerStats.skippedPriceVerifyExit} closed=${closed.length} pending_followups=${pendingFollowupsCount()} errors=${stats.errors}`,
      skippedPriceVerify: stats.skippedPriceVerify,
      skippedPriceVerifyExit: trackerStats.skippedPriceVerifyExit,
      holdersResolveStats: holdersStats,
      trackerStats: trackerStats.closed,
    });
    opts?.onOscarHeartbeat?.({
      openPositions: open.size,
      closedTotal: closed.length,
      stats: { ...stats },
      trackerClosed: trackerStats.closed,
    });
    logger.info({
      msg: 'heartbeat',
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      stats,
      open: open.size,
      closed: closed.length,
      trackerStats: trackerStats.closed,
      holdersResolveStats: holdersStats,
    });
  }, cfg.heartbeatIntervalMs);

  const statsTimer = setInterval(() => {
    const wins = closed.filter((c) => c.pnlPct > 0).length;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
    logger.info({
      msg: 'stats',
      open: open.size,
      closed: closed.length,
      wins,
      winRate: +winRate.toFixed(1),
      exits: trackerStats.closed,
    });
  }, cfg.statsIntervalMs);

  const livePeriodicHealTimer = opts?.livePeriodicSelfHealFactory?.({
    paperCfg: cfg,
    getOpen: () => open,
    getClosed: () => closed,
    tpLadder,
    trackerStats,
    btcCtx: getBtcContext,
    journalAppend,
    journalLiveStrategy: opts?.journalLiveStrategy,
    resolveLiveOscar,
    isTrackerBusy: () => trackerRunning,
  });

  const solTimer = setInterval(() => {
    void refreshSolPrice();
  }, cfg.solPriceRefreshMs);
  const btcTimer = setInterval(() => {
    void refreshBtcContext(cfg);
  }, cfg.btcContextRefreshMs);

  await discoveryTick();

  const shutdown = (sig: string) => {
    opts?.onShutdown?.(sig);
    logger.info({ msg: 'papertrader shutdown', sig, stats, open: open.size, closed: closed.length });
    stopPriorityFeeTicker();
    clearInterval(discoveryTimer);
    clearInterval(trackerTimer);
    clearInterval(followupTimer);
    clearInterval(heartbeatTimer);
    clearInterval(statsTimer);
    if (livePeriodicHealTimer) clearInterval(livePeriodicHealTimer);
    clearInterval(solTimer);
    clearInterval(btcTimer);
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
