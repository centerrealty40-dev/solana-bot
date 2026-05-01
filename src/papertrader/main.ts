import pino from 'pino';
import { loadPaperTraderConfig } from './config.js';
import { configureStore, appendEvent } from './store-jsonl.js';
import { refreshSolPrice, getSolUsd, refreshBtcContext, getBtcContext } from './pricing.js';

const logger = pino({ name: 'papertrader' });

export async function main(): Promise<void> {
  const cfg = loadPaperTraderConfig();
  configureStore({ storePath: cfg.storePath, strategyId: cfg.strategyId });

  const startedAt = Date.now();
  logger.info({
    msg: 'papertrader skeleton start',
    strategyId: cfg.strategyId,
    strategyKind: cfg.strategyKind,
    storePath: cfg.storePath,
    positionUsd: cfg.positionUsd,
    dryRun: cfg.dryRun,
  });

  await Promise.allSettled([refreshSolPrice(), refreshBtcContext(cfg)]);

  const heartbeatTimer = setInterval(() => {
    const note = 'no candidates (skeleton — discovery not implemented yet)';
    appendEvent({
      kind: 'heartbeat',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      openPositions: 0,
      closedTotal: 0,
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      note,
    });
    logger.info({ msg: 'heartbeat', solUsd: getSolUsd(), btc: getBtcContext(), note });
  }, cfg.heartbeatIntervalMs);

  const solTimer = setInterval(() => {
    void refreshSolPrice();
  }, cfg.solPriceRefreshMs);
  const btcTimer = setInterval(() => {
    void refreshBtcContext(cfg);
  }, cfg.btcContextRefreshMs);

  const shutdown = (sig: string) => {
    logger.info({ msg: 'papertrader shutdown', sig });
    clearInterval(heartbeatTimer);
    clearInterval(solTimer);
    clearInterval(btcTimer);
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
