import { LogsWsClient } from '../../stream/rpc-ws.js';
import type { StreamConfig } from '../../stream/config.js';
import { extractMintCandidatesFromLogs } from './awakening-mint-from-logs.js';
import { child } from '../../core/logger.js';

const log = child('awakening-stream-ws');

export type AwakeningWsLogHandler = (mint: string, tsMs: number) => void;

/** In-process Alchemy/primary RPC logsSubscribe — zero Postgres load. */
export function startAwakeningStreamWs(args: {
  rpcWsUrl: string;
  programIds: string[];
  onMintActivity: AwakeningWsLogHandler;
}): { stop: () => void } {
  const cfg: StreamConfig = {
    rpcHttpUrl: 'https://placeholder.local',
    rpcWsUrl: args.rpcWsUrl,
    programIds: args.programIds,
    commitment: 'confirmed',
    batchSize: 50,
    batchMs: 1000,
    reconnectMinMs: 2000,
    reconnectMaxMs: 60_000,
    logEveryN: 2000,
  };

  const client = new LogsWsClient(cfg, (n) => {
    const tsMs = Date.now();
    const mints = extractMintCandidatesFromLogs(n.logs);
    for (const mint of mints) {
      args.onMintActivity(mint, tsMs);
    }
  });

  client.start();
  log.info(
    { wsHost: safeHost(args.rpcWsUrl), programs: args.programIds.length },
    'awakening ws stream started',
  );

  return {
    stop: () => client.stop(),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}
