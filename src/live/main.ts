/**
 * W8.0 Live Oscar — Phase 0–1: config + validated JSONL (heartbeat); no RPC / signing.
 */
import pino from 'pino';
import { loadLiveOscarConfig } from './config.js';
import { runLiveJupiterSelfTest } from './jupiter-self-test.js';
import { appendLiveJsonlEvent, configureLiveStore } from './store-jsonl.js';

const log = pino({ name: 'live-oscar' });

export function main(): void {
  const cfg = loadLiveOscarConfig();
  configureLiveStore({ storePath: cfg.liveTradesPath, strategyId: cfg.strategyId });

  log.info(
    {
      strategyId: cfg.strategyId,
      profile: cfg.profile,
      liveTradesPath: cfg.liveTradesPath,
      strategyEnabled: cfg.strategyEnabled,
      executionMode: cfg.executionMode,
    },
    'live-oscar executor start (W8.0 phase 1)',
  );

  appendLiveJsonlEvent({
    kind: 'live_boot',
    profile: cfg.profile,
    liveStrategyEnabled: cfg.strategyEnabled,
    executionMode: cfg.executionMode,
    phase: 'W8.0-p2',
  });

  void runLiveJupiterSelfTest(cfg).catch((err) => {
    log.error({ err: (err as Error)?.message }, 'runLiveJupiterSelfTest failed');
  });

  const heartbeatTimer = setInterval(() => {
    appendLiveJsonlEvent({
      kind: 'heartbeat',
      uptimeSec: Math.floor(process.uptime()),
      openPositions: 0,
      closedTotal: 0,
      liveStrategyEnabled: cfg.strategyEnabled,
      executionMode: cfg.executionMode,
      note: cfg.strategyEnabled
        ? 'phase2: Jupiter quote/build wired; simulate/send in later phases'
        : 'live disabled — heartbeat only (W8.0-p2)',
    });
    log.debug({ uptimeSec: Math.floor(process.uptime()) }, 'live-oscar heartbeat');
  }, cfg.heartbeatIntervalMs);

  const shutdown = (sig: string) => {
    clearInterval(heartbeatTimer);
    appendLiveJsonlEvent({ kind: 'live_shutdown', sig }, { sync: true });
    log.info({ sig }, 'live-oscar shutdown');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
