import pino from 'pino';
import { loadPaperTraderConfig } from './config.js';
import { configureStore, appendEvent } from './store-jsonl.js';
import { refreshSolPrice, getSolUsd, refreshBtcContext, getBtcContext } from './pricing.js';
import { runDipDiscovery } from './discovery/dip-clones.js';
import { fetchLaunchpadCandidates } from './discovery/launchpad.js';
import { fetchFreshValidatedCandidates } from './discovery/fresh-validated.js';

const logger = pino({ name: 'papertrader' });

export async function main(): Promise<void> {
  const cfg = loadPaperTraderConfig();
  configureStore({ storePath: cfg.storePath, strategyId: cfg.strategyId });

  void fetchLaunchpadCandidates;
  void fetchFreshValidatedCandidates;

  const startedAt = Date.now();
  const stats = { discovered: 0, evaluated: 0, passed: 0, ticks: 0, errors: 0 };

  logger.info({
    msg: 'papertrader discovery start',
    strategyId: cfg.strategyId,
    strategyKind: cfg.strategyKind,
    storePath: cfg.storePath,
    positionUsd: cfg.positionUsd,
    dryRun: cfg.dryRun,
    whaleEnabled: cfg.whaleEnabled,
    enableMigrationLane: cfg.enableMigrationLane,
    enablePostLane: cfg.enablePostLane,
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
      }
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'discovery tick failed', err: (err as Error).message });
    }
  }

  const discoveryTimer = setInterval(() => {
    void discoveryTick();
  }, cfg.discoveryIntervalMs);

  const heartbeatTimer = setInterval(() => {
    const note =
      cfg.strategyKind !== 'dip'
        ? `strategy_kind=${cfg.strategyKind} not implemented in W6.3b (stubbed)`
        : `discovery active: ticks=${stats.ticks} discovered=${stats.discovered} evaluated=${stats.evaluated} passed=${stats.passed} errors=${stats.errors}`;
    appendEvent({
      kind: 'heartbeat',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      openPositions: 0,
      closedTotal: 0,
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      note,
    });
    logger.info({ msg: 'heartbeat', solUsd: getSolUsd(), btc: getBtcContext(), stats, note });
  }, cfg.heartbeatIntervalMs);

  const solTimer = setInterval(() => {
    void refreshSolPrice();
  }, cfg.solPriceRefreshMs);
  const btcTimer = setInterval(() => {
    void refreshBtcContext(cfg);
  }, cfg.btcContextRefreshMs);

  await discoveryTick();

  const shutdown = (sig: string) => {
    logger.info({ msg: 'papertrader shutdown', sig, stats });
    clearInterval(discoveryTimer);
    clearInterval(heartbeatTimer);
    clearInterval(solTimer);
    clearInterval(btcTimer);
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
