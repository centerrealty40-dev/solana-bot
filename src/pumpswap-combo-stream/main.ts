import { qnCall } from '../core/rpc/qn-client.js';
import { LogsWsClient } from '../stream/rpc-ws.js';
import type { StreamConfig } from '../stream/config.js';
import { child } from '../core/logger.js';
import type { PumpswapComboStreamConfig } from './config.js';
import { decodePumpSwapStreamSnapshot, isPumpSwapTradeLog } from './decode-snapshot.js';
import { upsertPumpSwapStreamSnapshot, countRecentStreamSnapshots } from './pg-writer.js';
import { ensureComboSolUsd } from '../pumpswap-combo/sol-oracle.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';

const log = child('pumpswap-combo-stream');

type QueuedSig = { signature: string; enqueuedAt: number };

function streamCfgFromCombo(cfg: PumpswapComboStreamConfig): StreamConfig {
  return {
    rpcHttpUrl: cfg.rpcHttpUrl,
    rpcWsUrl: cfg.rpcWsUrl,
    programIds: [cfg.programId],
    commitment: cfg.commitment,
    batchSize: 50,
    batchMs: 1000,
    reconnectMinMs: 1000,
    reconnectMaxMs: 30_000,
    logEveryN: cfg.logEveryN,
  };
}

export async function runPumpswapComboStream(cfg: PumpswapComboStreamConfig): Promise<void> {
  const queue: QueuedSig[] = [];
  const seen = new Set<string>();
  let received = 0;
  let parsed = 0;
  let dropped = 0;
  let budgetBlocked = 0;
  let lastFetchAt = 0;
  let workerRunning = false;

  const enqueue = (signature: string) => {
    if (seen.has(signature)) return;
    seen.add(signature);
    if (seen.size > cfg.queueMax * 4) {
      for (const s of [...seen].slice(0, seen.size - cfg.queueMax * 2)) seen.delete(s);
    }
    if (queue.length >= cfg.queueMax) {
      queue.shift();
      dropped++;
    }
    queue.push({ signature, enqueuedAt: Date.now() });
  };

  const client = new LogsWsClient(streamCfgFromCombo(cfg), (n) => {
    if (n.err != null) return;
    if (!isPumpSwapTradeLog(n.logs)) return;
    received++;
    enqueue(n.signature);
    if (received % cfg.logEveryN === 0) {
      log.info({ received, parsed, queued: queue.length, dropped, budgetBlocked }, 'pumpswap-combo-stream ingest');
    }
  });

  const worker = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      while (queue.length) {
        const head = queue[0]!;
        if (Date.now() - head.enqueuedAt > cfg.queueMaxAgeMs) {
          queue.shift();
          continue;
        }
        const wait = lastFetchAt + cfg.txFetchMinGapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const item = queue.shift()!;
        lastFetchAt = Date.now();

        const res = await qnCall<TxJsonParsed>(
          'getTransaction',
          [item.signature, { encoding: 'jsonParsed', commitment: cfg.commitment, maxSupportedTransactionVersion: 0 }],
          { feature: 'pumpswap_combo_stream', creditsPerCall: 30, timeoutMs: 12_000, httpUrl: cfg.rpcHttpUrl },
        );
        if (!res.ok) {
          if (res.reason === 'budget') budgetBlocked++;
          continue;
        }
        if (!res.value) continue;

        const snap = decodePumpSwapStreamSnapshot(res.value, await ensureComboSolUsd());
        if (!snap) continue;
        await upsertPumpSwapStreamSnapshot({ snap, source: cfg.snapshotSource });
        parsed++;
      }
    } finally {
      workerRunning = false;
    }
  };

  setInterval(() => void worker(), Math.max(100, Math.floor(cfg.txFetchMinGapMs / 2)));
  setInterval(() => {
    void countRecentStreamSnapshots(cfg.snapshotSource, 15).then((n) =>
      log.info({ pgRows15m: n, received, parsed, queued: queue.length }, 'pumpswap-combo-stream pg health'),
    );
  }, 60_000);

  log.info({ program: cfg.programId, queueMax: cfg.queueMax, txGapMs: cfg.txFetchMinGapMs }, 'pumpswap-combo-stream starting');
  client.start();
  await new Promise<void>(() => {});
}
