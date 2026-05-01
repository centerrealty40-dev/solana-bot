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
import { startPriorityFeeTicker, stopPriorityFeeTicker, getPriorityFeeUsd } from './pricing/priority-fee.js';
import { verifyEntryPrice } from './pricing/price-verify.js';
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
import { loadStore } from './executor/store-restore.js';
import type { ClosedTrade, ExitReason, OpenTrade, PriceVerifyVerdict, SafetyVerdict } from './types.js';
import { evaluateMintSafety } from './safety/index.js';
import { getHoldersResolveStats } from './holders/holders-resolve.js';

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
    } as Record<ExitReason, number>,
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
          holders_meta: d.holdersMeta ?? null,
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
            appendEvent({
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
            ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot',
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
            appendEvent({
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
    const holdersStats = cfg.holdersLiveEnabled ? getHoldersResolveStats() : null;
    appendEvent({
      kind: 'heartbeat',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      openPositions: open.size,
      closedTotal: closed.length,
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      note: `dip executor: ticks=${stats.ticks} disc=${stats.discovered} eval=${stats.evaluated} pass=${stats.passed} opened=${stats.opened} skip_safety=${stats.skippedSafety} skip_price_verify=${stats.skippedPriceVerify} closed=${closed.length} pending_followups=${pendingFollowupsCount()} errors=${stats.errors}`,
      skippedPriceVerify: stats.skippedPriceVerify,
      holdersResolveStats: holdersStats,
      trackerStats: trackerStats.closed,
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

  const solTimer = setInterval(() => {
    void refreshSolPrice();
  }, cfg.solPriceRefreshMs);
  const btcTimer = setInterval(() => {
    void refreshBtcContext(cfg);
  }, cfg.btcContextRefreshMs);

  await discoveryTick();

  const shutdown = (sig: string) => {
    logger.info({ msg: 'papertrader shutdown', sig, stats, open: open.size, closed: closed.length });
    stopPriorityFeeTicker();
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
