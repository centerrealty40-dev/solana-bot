/**
 * Sidecar snapshot of live-oscar open positions for dashboard (avoids tail-only JSONL replay gaps).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OpenTrade } from '../papertrader/types.js';
import { serializeOpenTrade } from './strategy-snapshot.js';

export const LIVE_OPEN_SNAPSHOT_VERSION = 1;

export type LiveOpenSnapshotPosition = {
  mint: string;
  openTrade: Record<string, unknown>;
};

export type LiveOpenSnapshot = {
  version: number;
  strategyId: string;
  updatedAtMs: number;
  openCount: number;
  positions: LiveOpenSnapshotPosition[];
};

const POSITION_UPDATE_KINDS = new Set([
  'live_position_open',
  'live_position_scale_in',
  'live_position_dca',
  'live_position_partial_sell',
]);

let configured: { path: string; strategyId: string } | null = null;

export function configureLiveOpenSnapshot(opts: { path: string; strategyId: string }): void {
  configured = opts;
}

export function liveOpenSnapshotPathFromEnv(liveTradesPath: string): string {
  const p = process.env.LIVE_OPEN_SNAPSHOT_PATH?.trim();
  if (p) return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return path.resolve(path.dirname(liveTradesPath), 'live-oscar-open-snapshot.json');
}

export function emptyLiveOpenSnapshot(strategyId = 'live-oscar'): LiveOpenSnapshot {
  return {
    version: LIVE_OPEN_SNAPSHOT_VERSION,
    strategyId,
    updatedAtMs: Date.now(),
    openCount: 0,
    positions: [],
  };
}

export function readLiveOpenSnapshot(filePath?: string): LiveOpenSnapshot | null {
  const fp = filePath ?? configured?.path;
  if (!fp) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as LiveOpenSnapshot;
    if (raw.version !== LIVE_OPEN_SNAPSHOT_VERSION) return null;
    if (!Array.isArray(raw.positions)) return null;
    return {
      ...raw,
      openCount: raw.positions.length,
    };
  } catch {
    return null;
  }
}

function writeLiveOpenSnapshotFile(snapshot: LiveOpenSnapshot, filePath: string): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const payload: LiveOpenSnapshot = {
    ...snapshot,
    openCount: snapshot.positions.length,
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

export function writeLiveOpenSnapshotFromMap(
  open: ReadonlyMap<string, OpenTrade>,
  filePath?: string,
): void {
  const fp = filePath ?? configured?.path;
  if (!fp) return;
  const strategyId = configured?.strategyId ?? 'live-oscar';
  const positions: LiveOpenSnapshotPosition[] = [...open.values()].map((ot) => ({
    mint: ot.mint,
    openTrade: serializeOpenTrade(ot),
  }));
  positions.sort(
    (a, b) => Number(b.openTrade.entryTs ?? 0) - Number(a.openTrade.entryTs ?? 0),
  );
  writeLiveOpenSnapshotFile(
    {
      version: LIVE_OPEN_SNAPSHOT_VERSION,
      strategyId,
      updatedAtMs: Date.now(),
      openCount: positions.length,
      positions,
    },
    fp,
  );
}

export function applyLiveOpenSnapshotEvent(
  event: Record<string, unknown>,
  filePath?: string,
): void {
  const kind = String(event.kind ?? '');
  const fp = filePath ?? configured?.path;
  if (!fp) return;

  const mint = String(event.mint ?? '').trim();
  if (!mint) return;

  if (kind === 'live_position_close') {
    const snap = readLiveOpenSnapshot(fp) ?? emptyLiveOpenSnapshot(configured?.strategyId);
    snap.positions = snap.positions.filter((p) => p.mint !== mint);
    snap.updatedAtMs = Date.now();
    writeLiveOpenSnapshotFile(snap, fp);
    return;
  }

  if (!POSITION_UPDATE_KINDS.has(kind)) return;
  const ot = event.openTrade;
  if (!ot || typeof ot !== 'object') return;

  const snap = readLiveOpenSnapshot(fp) ?? emptyLiveOpenSnapshot(configured?.strategyId);
  const row: LiveOpenSnapshotPosition = { mint, openTrade: ot as Record<string, unknown> };
  const idx = snap.positions.findIndex((p) => p.mint === mint);
  if (idx >= 0) snap.positions[idx] = row;
  else snap.positions.push(row);
  snap.positions.sort(
    (a, b) => Number(b.openTrade.entryTs ?? 0) - Number(a.openTrade.entryTs ?? 0),
  );
  snap.updatedAtMs = Date.now();
  writeLiveOpenSnapshotFile(snap, fp);
}

export function isLiveOpenSnapshotFresh(
  snapshot: LiveOpenSnapshot,
  maxAgeMs: number,
  nowMs = Date.now(),
): boolean {
  if (!(maxAgeMs > 0)) return true;
  return nowMs - snapshot.updatedAtMs <= maxAgeMs;
}
