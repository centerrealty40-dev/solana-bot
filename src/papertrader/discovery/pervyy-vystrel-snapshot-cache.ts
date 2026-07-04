/**
 * File cache for PR2 batch materialized snapshots (tick read, TTL 120s per spec §6.4.3).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ClusterDumpShadowEval } from './mint-early-cluster-map.js';
import type { EarlyClusterMapSnapshot } from './mint-early-cluster-map.js';
import type { OrganicFlowSnapshot } from './mint-organic-flow-gate.js';
import type { VolumeAuthenticitySnapshot } from './mint-volume-authenticity.js';

export interface PervyyVystrelMintMaterialized {
  volAuth: VolumeAuthenticitySnapshot | null;
  organicFlow: OrganicFlowSnapshot | null;
  clusterMap: EarlyClusterMapSnapshot | null;
  clusterDumpShadow: ClusterDumpShadowEval | null;
}

export interface PervyyVystrelMaterializedCacheFile {
  computedAtMs: number;
  ttlSec: number;
  mints: Record<string, PervyyVystrelMintMaterialized>;
}

const DEFAULT_TTL_SEC = 120;

export function pervyyVystrelCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PERVYY_VYSTREL_MATERIALIZE_CACHE_PATH?.trim() ||
    path.join('data', 'pervyy-vystrel', 'materialized-snapshots.json')
  );
}

export function readPervyyVystrelMaterializedCache(
  env: NodeJS.ProcessEnv = process.env,
): PervyyVystrelMaterializedCacheFile | null {
  const p = pervyyVystrelCachePath(env);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as PervyyVystrelMaterializedCacheFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.mints) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isPervyyVystrelCacheFresh(
  cache: PervyyVystrelMaterializedCacheFile | null,
  nowMs = Date.now(),
): boolean {
  if (!cache?.computedAtMs) return false;
  const ttlSec = cache.ttlSec > 0 ? cache.ttlSec : DEFAULT_TTL_SEC;
  return nowMs - cache.computedAtMs <= ttlSec * 1000;
}

export function readPervyyVystrelMintSnapshot(
  mint: string,
  env: NodeJS.ProcessEnv = process.env,
): PervyyVystrelMintMaterialized | null {
  const cache = readPervyyVystrelMaterializedCache(env);
  if (!isPervyyVystrelCacheFresh(cache)) return null;
  return cache?.mints[mint] ?? null;
}

export function writePervyyVystrelMaterializedCache(
  file: PervyyVystrelMaterializedCacheFile,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const p = pervyyVystrelCachePath(env);
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
