import { sql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import { loadBotBucketConfig } from './config.js';
import { applyLayerAUmbrella } from './layer-a-umbrella.js';
import { applyLayerBFanout, applyLayerBManyMints, applyLayerBSwapBurst } from './layer-b-sql.js';

const log = child('intel-bot-bucket');

export type BotBucketMetrics = {
  enabled: boolean;
  dryRun: boolean;
  ruleSet: string;
  sinceHours: number;
  layerA: { candidates: number; written: number };
  layerB: {
    swapBurst: { candidates: number; written: number };
    manyMints: { candidates: number; written: number };
    fanout: { candidates: number; written: number };
  };
};

export type RunBotBucketOptions = {
  /** CLI — игнорировать BOT_BUCKET_ENABLED */
  force?: boolean;
  /** CLI — только метрики, без записи */
  dryRun?: boolean;
  /** Переопределить окно (часы) */
  sinceHoursOverride?: number;
};

export async function runBotBucketPass(opts: RunBotBucketOptions = {}): Promise<BotBucketMetrics> {
  const cfgIn = loadBotBucketConfig();
  const sinceHours = opts.sinceHoursOverride ?? cfgIn.sinceHours;
  const c = { ...cfgIn, sinceHours };

  const dryRun = opts.dryRun ?? c.dryRun;
  const enabled = opts.force || c.enabled;

  const z: BotBucketMetrics = {
    enabled,
    dryRun,
    ruleSet: c.ruleSet,
    sinceHours: c.sinceHours,
    layerA: { candidates: 0, written: 0 },
    layerB: {
      swapBurst: { candidates: 0, written: 0 },
      manyMints: { candidates: 0, written: 0 },
      fanout: { candidates: 0, written: 0 },
    },
  };

  if (!enabled) {
    log.info(z, 'intel-bot-bucket skipped (BOT_BUCKET_ENABLED=0)');
    return z;
  }

  if (c.statementTimeoutMs > 0) {
    await db.execute(sql.raw(`SET statement_timeout TO ${c.statementTimeoutMs}`));
  }

  z.layerA = await applyLayerAUmbrella(db, c, dryRun);

  const sb = await applyLayerBSwapBurst(db, c, dryRun);
  z.layerB.swapBurst = sb;

  const mm = await applyLayerBManyMints(db, c, dryRun);
  z.layerB.manyMints = mm;

  const fo = await applyLayerBFanout(db, c, dryRun);
  z.layerB.fanout = fo;

  log.info(z, 'intel-bot-bucket summary');
  return z;
}
