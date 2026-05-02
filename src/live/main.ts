/**
 * W8.0 Live Oscar — config + JSONL; Phase 2 Jupiter; Phase 3 sign + simulate (optional self-test).
 */
import pino from 'pino';
import { loadLiveOscarConfig } from './config.js';
import { runLiveJupiterSelfTest } from './jupiter-self-test.js';
import { runLivePhase3SimSelfTest } from './phase3-self-test.js';
import { appendLiveJsonlEvent, configureLiveStore } from './store-jsonl.js';

const log = pino({ name: 'live-oscar' });

function heartbeatNote(cfg: ReturnType<typeof loadLiveOscarConfig>): string {
  if (!cfg.strategyEnabled) return 'live disabled — heartbeat only (W8.0-p3)';
  if (cfg.executionMode === 'dry_run')
    return 'phase2/3: Jupiter self-test optional; no wallet/simulate until simulate mode';
  if (cfg.executionMode === 'simulate')
    return 'phase3: wallet + simulateTransaction wired; send still Phase 6';
  return cfg.executionMode;
}

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
    'live-oscar executor start (W8.0-p3)',
  );

  appendLiveJsonlEvent({
    kind: 'live_boot',
    profile: cfg.profile,
    liveStrategyEnabled: cfg.strategyEnabled,
    executionMode: cfg.executionMode,
    phase: 'W8.0-p3',
  });

  void runLiveJupiterSelfTest(cfg).catch((err) => {
    log.error({ err: (err as Error)?.message }, 'runLiveJupiterSelfTest failed');
  });

  void runLivePhase3SimSelfTest(cfg).catch((err) => {
    log.error({ err: (err as Error)?.message }, 'runLivePhase3SimSelfTest failed');
  });

  const heartbeatTimer = setInterval(() => {
    appendLiveJsonlEvent({
      kind: 'heartbeat',
      uptimeSec: Math.floor(process.uptime()),
      openPositions: 0,
      closedTotal: 0,
      liveStrategyEnabled: cfg.strategyEnabled,
      executionMode: cfg.executionMode,
      note: heartbeatNote(cfg),
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
