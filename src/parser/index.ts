import 'dotenv/config';
import { loadParserConfig } from './config.js';
import { readStreamBatch } from './reader.js';
import { getTransactionsParsed } from './rpc-http.js';
import { decodePumpfunSwap, isPumpfunSwap } from './pumpfun.js';
import type { SwapInsert } from './pumpfun.js';
import { insertSwaps, touchTokensAndWallets } from './writer.js';
import { getLastEventId, upsertCursor } from './cursor.js';
import { getParserHealthSnapshot } from './health.js';
import { parserMetrics } from './metrics.js';
import { child } from '../core/logger.js';

const log = child('sa-parser');

function safeRpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

export { parserMetrics };

export async function runParser(): Promise<void> {
  const cfg = loadParserConfig();
  log.info(
    {
      rpc_host: safeRpcHost(cfg.rpcHttpUrl),
      program_id: cfg.programId,
      batch: cfg.batchSize,
      tick_ms: cfg.tickMs,
      dry_run: cfg.dryRun,
    },
    'sa-parser starting',
  );

  let shuttingDown = false;
  let tickRunning = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'sa-parser shutdown');
    while (tickRunning) {
      await new Promise((r) => setTimeout(r, 50));
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const tick = async () => {
    if (shuttingDown) return;
    tickRunning = true;
    try {
      let after = await getLastEventId(cfg.programId);
      const rows = await readStreamBatch(cfg.programId, after, cfg.lookbackHours, cfg.batchSize);
      if (rows.length === 0) {
        return;
      }

      parserMetrics.parsed_total += rows.length;

      const uniqueSigs = [...new Set(rows.map((r) => r.signature))];
      const txs = await getTransactionsParsed(
        cfg.rpcHttpUrl,
        uniqueSigs,
        cfg.rpcBatch,
        cfg.rpcTimeoutMs,
        cfg.maxInflight,
      );

      const swaps: SwapInsert[] = [];
      for (const sig of uniqueSigs) {
        const tx = txs.get(sig) ?? null;
        if (!tx) {
          parserMetrics.rpc_failures_total += 1;
          continue;
        }
        if (!isPumpfunSwap(tx, cfg.programId)) continue;
        const decoded = decodePumpfunSwap(tx, cfg.programId, cfg.solUsdFallback);
        if (decoded.length === 0) {
          parserMetrics.decode_failures_total += 1;
        } else {
          swaps.push(...decoded);
        }
      }

      let inserted = 0;
      if (!cfg.dryRun && swaps.length > 0) {
        inserted = await insertSwaps(swaps);
        parserMetrics.swaps_inserted_total += inserted;
        await touchTokensAndWallets(swaps);
      } else if (cfg.dryRun && swaps.length > 0) {
        log.info({ would_insert: swaps.length, dry_run: true }, 'sa-parser dry-run skip inserts');
      }

      const last = rows[rows.length - 1]!;
      const lastId = typeof last.id === 'bigint' ? last.id : BigInt(last.id as unknown as string);

      await upsertCursor(cfg.programId, lastId, last.signature, last.slot, {
        parsed_total: parserMetrics.parsed_total,
        swaps_inserted_total: parserMetrics.swaps_inserted_total,
        decode_failures_total: parserMetrics.decode_failures_total,
        rpc_failures_total: parserMetrics.rpc_failures_total,
        last_tick_inserted: inserted,
        dry_run: cfg.dryRun,
      });

      if (parserMetrics.parsed_total % cfg.logEveryN === 0) {
        const snap = await getParserHealthSnapshot(cfg.programId).catch(() => null);
        log.info(
          {
            parsed_total: parserMetrics.parsed_total,
            swaps_inserted_total: parserMetrics.swaps_inserted_total,
            decode_failures_total: parserMetrics.decode_failures_total,
            rpc_failures_total: parserMetrics.rpc_failures_total,
            lag_events: snap?.lag_events,
            last_tick_rows: rows.length,
            last_tick_swaps: swaps.length,
            last_tick_inserted: inserted,
          },
          'sa-parser progress',
        );
      }
    } catch (e) {
      log.error({ err: String(e) }, 'sa-parser tick error');
    } finally {
      tickRunning = false;
    }
  };

  const loop = async () => {
    while (!shuttingDown) {
      await tick();
      await new Promise((r) => setTimeout(r, cfg.tickMs));
    }
  };

  setInterval(() => {
    void getParserHealthSnapshot(cfg.programId)
      .then((h) => {
        log.info(
          {
            swaps_m5: h.m5,
            lag_events: h.lag_events,
            inserted_total: parserMetrics.swaps_inserted_total,
          },
          'sa-parser health tick',
        );
      })
      .catch(() => {});
  }, 60_000);

  await loop();
}
