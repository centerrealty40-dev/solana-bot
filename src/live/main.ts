/**
 * W8.0 Live Oscar — Phase 0: config + heartbeat JSONL only (no RPC, no signing).
 */
import pino from 'pino';
import { loadLiveOscarConfig } from './config.js';
import { appendLiveEvent, configureLiveStore } from './store-jsonl.js';

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
    'live-oscar executor start (W8.0 phase 0)',
  );

  appendLiveEvent(
    {
      kind: 'live_boot',
      profile: cfg.profile,
      liveStrategyEnabled: cfg.strategyEnabled,
      executionMode: cfg.executionMode,
      phase: 'W8.0-p0',
    },
    { sync: true },
  );

  const heartbeatTimer = setInterval(() => {
    appendLiveEvent({
      kind: 'heartbeat',
      uptimeSec: Math.floor(process.uptime()),
      openPositions: 0,
      closedTotal: 0,
      liveStrategyEnabled: cfg.strategyEnabled,
      executionMode: cfg.executionMode,
      note: cfg.strategyEnabled
        ? 'phase0: execution not wired — enable only after later phases'
        : 'live disabled — heartbeat only (W8.0 phase 0)',
    });
    log.debug({ uptimeSec: Math.floor(process.uptime()) }, 'live-oscar heartbeat');
  }, cfg.heartbeatIntervalMs);

  const shutdown = (sig: string) => {
    clearInterval(heartbeatTimer);
    appendLiveEvent({ kind: 'live_shutdown', sig }, { sync: true });
    log.info({ sig }, 'live-oscar shutdown');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
