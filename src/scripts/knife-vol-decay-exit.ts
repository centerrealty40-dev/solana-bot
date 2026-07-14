/**
 * Volume-decay exit for knife-catcher — exit when vol keeps falling minute-over-minute.
 * Read-only PG (`pumpswap_pair_snapshots`); no DexScreener.
 */
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';

export type VolDecayMetric = 'vol5m' | 'vol1h';

export interface VolMinuteSample {
  /** Start of UTC minute bucket (ms). */
  bucketMs: number;
  volUsd: number;
}

export interface KnifeVolDecayConfig {
  enabled: boolean;
  /** Minute buckets with strictly lower vol than the prior bucket required to exit. */
  consecutiveMin: number;
  sampleMs: number;
  metric: VolDecayMetric;
}

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}

function envNum(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function loadKnifeVolDecayConfig(env: NodeJS.ProcessEnv = process.env): KnifeVolDecayConfig {
  const metricRaw = String(env.KNIFE_VOL_DECAY_METRIC ?? 'vol5m').trim().toLowerCase();
  const metric: VolDecayMetric = metricRaw === 'vol1h' ? 'vol1h' : 'vol5m';
  return {
    enabled: envBool(env.KNIFE_VOL_DECAY_EXIT_ENABLED, true),
    /** Scalp default: 5 min straight decline; tune to 10 via env if needed. */
    consecutiveMin: Math.round(envNum(env.KNIFE_VOL_DECAY_CONSECUTIVE_MIN, 5)),
    sampleMs: Math.round(envNum(env.KNIFE_VOL_DECAY_SAMPLE_SEC, 60) * 1000),
    metric,
  };
}

export function minuteBucketMs(tsMs: number): number {
  return Math.floor(tsMs / 60_000) * 60_000;
}

/** Count minute-over-minute declines from the latest sample backward. */
export function countConsecutiveVolDecline(samples: VolMinuteSample[]): number {
  if (samples.length < 2) return 0;
  let count = 0;
  for (let i = samples.length - 1; i >= 1; i -= 1) {
    if (samples[i]!.volUsd < samples[i - 1]!.volUsd) count += 1;
    else break;
  }
  return count;
}

export function volDecayExitTriggered(samples: VolMinuteSample[], consecutiveMin: number): boolean {
  return countConsecutiveVolDecline(samples) >= consecutiveMin;
}

/**
 * Append or replace the current minute bucket; returns updated samples + live decline count.
 */
export function recordVolDeclineSample(
  samples: VolMinuteSample[],
  volUsd: number,
  tsMs: number,
  maxSamples = 64,
): { samples: VolMinuteSample[]; consecutiveDecline: number } {
  const bucket = minuteBucketMs(tsMs);
  const vol = Number(volUsd);
  if (!(vol >= 0) || !Number.isFinite(vol)) {
    return { samples, consecutiveDecline: countConsecutiveVolDecline(samples) };
  }

  let next: VolMinuteSample[];
  const last = samples[samples.length - 1];
  if (last && last.bucketMs === bucket) {
    next = [...samples.slice(0, -1), { bucketMs: bucket, volUsd: vol }];
  } else {
    next = [...samples, { bucketMs: bucket, volUsd: vol }];
  }
  if (next.length > maxSamples) next = next.slice(-maxSamples);
  return { samples: next, consecutiveDecline: countConsecutiveVolDecline(next) };
}

export async function fetchKnifeLatestVolumeUsd(
  mint: string,
  metric: VolDecayMetric,
): Promise<number | null> {
  const col = metric === 'vol5m' ? 'volume_5m' : 'volume_1h';
  const rows = (await db.execute(dsql.raw(`
    SELECT COALESCE(${col}, 0)::float AS vol_usd
    FROM pumpswap_pair_snapshots
    WHERE base_mint = '${mint.replace(/'/g, "''")}'
      AND COALESCE(${col}, 0) > 0
    ORDER BY ts DESC
    LIMIT 1
  `))) as unknown as Array<{ vol_usd?: number }>;
  const vol = rows[0]?.vol_usd;
  return vol != null && Number.isFinite(Number(vol)) && Number(vol) > 0 ? Number(vol) : null;
}
