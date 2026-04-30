import 'dotenv/config';
import { db } from '../core/db/client.js';
import { loadAtlasConfig } from './config.js';
import { readSwapBatch } from './reader.js';
import { getLastSwapId, upsertAtlasCursor } from './cursor.js';
import { enrichTokens, enrichEntityWallets } from './writer-entities.js';
import { writePumpMoneyFlows } from './writer-flows.js';
import { applyActivityTags } from './tagger.js';
import { atlasMetrics } from './metrics.js';
import { getAtlasHealthSnapshot } from './health.js';
import { child } from '../core/logger.js';

const log = child('sa-atlas');

export { atlasMetrics };

export async function runAtlas(): Promise<void> {
  const cfg = loadAtlasConfig();
  log.info(
    {
      batch: cfg.batchSize,
      tick_ms: cfg.tickMs,
      lookback_h: cfg.lookbackHours,
      flows: cfg.flowsEnabled,
      tags: cfg.tagsEnabled,
      dry_run: cfg.dryRun,
    },
    'sa-atlas starting',
  );

  let shuttingDown = false;
  let tickRunning = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'sa-atlas shutdown');
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
      const lastId = await getLastSwapId(db);
      const rows = await readSwapBatch(lastId, cfg.lookbackHours, cfg.batchSize);
      if (rows.length === 0) {
        return;
      }

      const ids = rows.map((r) => r.id);
      const lastRow = rows[rows.length - 1]!;

      await db.transaction(async (tx) => {
        if (!cfg.dryRun) {
          await enrichTokens(tx, ids);
          await enrichEntityWallets(tx, ids);
          if (cfg.flowsEnabled) {
            await writePumpMoneyFlows(tx, ids);
            atlasMetrics.flows_inserted_total += rows.filter((r) => r.dex === 'pumpfun').length;
          }
          if (cfg.tagsEnabled) {
            await applyActivityTags(tx, ids, cfg.tagWindowHours);
          }
        }

        atlasMetrics.swaps_processed_total += rows.length;
        atlasMetrics.enriched_batches += 1;
        if (cfg.tagsEnabled && !cfg.dryRun) {
          atlasMetrics.tags_upserted_total += 1;
        }

        await upsertAtlasCursor(tx, lastRow.id, {
          swaps_processed_total: atlasMetrics.swaps_processed_total,
          enriched_batches: atlasMetrics.enriched_batches,
          flows_inserted_total: atlasMetrics.flows_inserted_total,
          tags_batches: atlasMetrics.tags_upserted_total,
          dry_run: cfg.dryRun,
          last_batch: rows.length,
        });
      });

      if (atlasMetrics.swaps_processed_total % cfg.logEveryN === 0) {
        const snap = await getAtlasHealthSnapshot().catch(() => null);
        log.info(
          {
            swaps_processed_total: atlasMetrics.swaps_processed_total,
            lag_swaps: snap?.lag_swaps,
            ew_m5: snap?.ew_m5,
            last_batch: rows.length,
          },
          'sa-atlas progress',
        );
      }
    } catch (e) {
      log.error({ err: String(e) }, 'sa-atlas tick error');
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
    void getAtlasHealthSnapshot()
      .then((h) => {
        log.info(
          {
            ew_m5: h.ew_m5,
            lag_swaps: h.lag_swaps,
            atlas_tags_m5: h.atlas_tags_m5,
            atlas_flows_m5: h.atlas_flows_m5,
          },
          'sa-atlas health tick',
        );
      })
      .catch(() => {});
  }, 60_000);

  await loop();
}
