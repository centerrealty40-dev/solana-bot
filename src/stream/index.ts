import 'dotenv/config';
import { loadStreamConfig } from './config.js';
import { StreamWriter, streamMetrics } from './writer.js';
import { LogsWsClient } from './rpc-ws.js';
import { getHealthSnapshot } from './health.js';
import { programIdToName } from './programs.js';
import { child } from '../core/logger.js';

const log = child('sa-stream');

export async function runStream(): Promise<void> {
  const cfg = loadStreamConfig();
  log.info(
    {
      rpc_ws_host: safeHost(cfg.rpcWsUrl),
      programs: cfg.programIds.map((id) => ({ id, name: programIdToName(id) })),
      commitment: cfg.commitment,
    },
    'sa-stream starting',
  );

  const writer = new StreamWriter(cfg.batchSize, cfg.batchMs);

  const client = new LogsWsClient(cfg, (n) => {
    writer.enqueue({
      signature: n.signature,
      slot: n.slot,
      programId: n.programId,
      kind: 'log',
      err: n.err,
      logCount: n.logs.length,
      payload: n.payload,
      observedSlot: n.slot,
    });

    if (streamMetrics.received_total % cfg.logEveryN === 0) {
      void logPeriodic(writer);
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'sa-stream shutdown');
    client.stop();
    await writer.shutdown().catch((e) => log.error({ err: String(e) }, 'flush on shutdown failed'));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  client.start();

  setInterval(() => {
    void getHealthSnapshot()
      .then((h) => {
        log.info(
          {
            inserted_total: h.gauges.inserted_total,
            received_total: h.gauges.received_total,
            m5: h.m5,
            last_flush: h.gauges.last_flush_at?.toISOString() ?? null,
          },
          'sa-stream health tick',
        );
      })
      .catch(() => {});
  }, 60_000);
}

function safeHost(wsUrl: string): string {
  try {
    return new URL(wsUrl).host;
  } catch {
    return '?';
  }
}

async function logPeriodic(writer: StreamWriter): Promise<void> {
  await writer.flush().catch(() => {});
  const snap = await getHealthSnapshot().catch(() => null);
  log.info(
    {
      received_total: streamMetrics.received_total,
      inserted_total: streamMetrics.inserted_total,
      flush_failures: streamMetrics.flush_failures_total,
      last_event_at: streamMetrics.last_event_at?.toISOString() ?? null,
      db_m5: snap?.m5,
    },
    'sa-stream progress',
  );
}
