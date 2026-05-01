import pino from 'pino';
import {
  loadPaperTraderConfig,
  parseDcaLevels,
  parseFollowupOffsets,
  parseTpLadder,
} from './config.js';
import { configureStore, appendEvent } from './store-jsonl.js';
import {
  refreshSolPrice,
  getSolUsd,
  refreshBtcContext,
  getBtcContext,
  getLiveMcUsd,
} from './pricing.js';
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
import { loadStore } from './executor/store-restore.js';
import type { ClosedTrade, ExitReason, OpenTrade, SafetyVerdict } from './types.js';
import { evaluateMintSafety } from './safety/index.js';

const logger = pino({ name: 'papertrader' });

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

export async function main(): Promise<void> {
  const cfg = loadPaperTraderConfig();
  configureStore({ storePath: cfg.storePath, strategyId: cfg.strategyId });

  void fetchLaunchpadCandidates;
  void fetchFreshValidatedCandidates;

  const dcaLevels = parseDcaLevels(cfg.dcaLevelsSpec);
  const tpLadder = parseTpLadder(cfg.tpLadderSpec);
  const followupOffsets = parseFollowupOffsets(cfg.followupOffsetsMinSpec);

  const restored = loadStore(cfg.storePath);
  for (const [mint, ts] of restored.evaluatedAt) evaluatedAtMap.set(mint, ts);
  for (const [mint, ts] of restored.lastEntryTsByMint) lastEntryTsByMintMap.set(mint, ts);
  const open: Map<string, OpenTrade> = restored.open;
  const closed: ClosedTrade[] = [];

  const startedAt = Date.now();
  const stats = {
    discovered: 0,
    evaluated: 0,
    passed: 0,
    opened: 0,
    skippedSafety: 0,
    ticks: 0,
    errors: 0,
  };
  const trackerStats: TrackerStats = {
    closed: { TP: 0, SL: 0, TRAIL: 0, TIMEOUT: 0, NO_DATA: 0, KILLSTOP: 0 } as Record<ExitReason, number>,
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
    followupOffsets,
    tpX: cfg.tpX,
    slX: cfg.slX,
    trailDrop: cfg.trailDrop,
    trailTriggerX: cfg.trailTriggerX,
    timeoutHours: cfg.timeoutHours,
    restoredOpen: open.size,
    safetyCheckEnabled: cfg.safetyCheckEnabled,
  });

  await Promise.allSettled([refreshSolPrice(), refreshBtcContext(cfg)]);

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
        appendEvent({
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
        });
        if (!d.pass) continue;
        if (open.has(d.mint)) {
          appendEvent({
            kind: 'eval-skip-open',
            lane: d.lane,
            source: d.source,
            mint: d.mint,
            reason: 'already_open',
          });
          continue;
        }
        if (cfg.dryRun) continue;

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
        };
        const ot = makeOpenTradeFromEntry({
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
            appendEvent({
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

        /** Same as ladder/close rows — lets dashboards show mcap at Open when snapshots have it. */
        let mcUsdLiveOpen: number | null = null;
        try {
          mcUsdLiveOpen = await getLiveMcUsd(
            ot.mint,
            ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot',
          );
        } catch {
          /* best-effort */
        }

        appendEvent({
          kind: 'open',
          mint: ot.mint,
          symbol: ot.symbol,
          lane: ot.lane,
          source: ot.source,
          dex: ot.dex,
          entryTs: ot.entryTs,
          entryMcUsd: ot.entryMcUsd,
          entryMarketPrice: ot.legs[0]?.marketPrice ?? ot.entryMcUsd,
          legs: ot.legs,
          totalInvestedUsd: ot.totalInvestedUsd,
          avgEntry: ot.avgEntry,
          avgEntryMarket: ot.avgEntryMarket,
          eval_reasons: d.reasons,
          features: d.features,
          btc,
          whale_analysis: d.whale,
          pre_entry_dynamics: preDyn,
          context_swaps: ctxSwaps,
          safety: safetyAttached,
          mcUsdLive: mcUsdLiveOpen,
        });

        open.set(ot.mint, ot);
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
    appendEvent({
      kind: 'heartbeat',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      openPositions: open.size,
      closedTotal: closed.length,
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      note: `dip executor: ticks=${stats.ticks} disc=${stats.discovered} eval=${stats.evaluated} pass=${stats.passed} opened=${stats.opened} skip_safety=${stats.skippedSafety} closed=${closed.length} pending_followups=${pendingFollowupsCount()} errors=${stats.errors}`,
    });
    logger.info({
      msg: 'heartbeat',
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      stats,
      open: open.size,
      closed: closed.length,
      trackerStats: trackerStats.closed,
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

  const solTimer = setInterval(() => {
    void refreshSolPrice();
  }, cfg.solPriceRefreshMs);
  const btcTimer = setInterval(() => {
    void refreshBtcContext(cfg);
  }, cfg.btcContextRefreshMs);

  await discoveryTick();

  const shutdown = (sig: string) => {
    logger.info({ msg: 'papertrader shutdown', sig, stats, open: open.size, closed: closed.length });
    clearInterval(discoveryTimer);
    clearInterval(trackerTimer);
    clearInterval(followupTimer);
    clearInterval(heartbeatTimer);
    clearInterval(statsTimer);
    clearInterval(solTimer);
    clearInterval(btcTimer);
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
