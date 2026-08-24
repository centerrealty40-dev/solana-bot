import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { appendMildDipJournal } from './state.js';
export { rotateMildDipJournal } from './journal-rotation.js';

let diskLow = false;
let lastLowWarningAtMs = 0;
let retentionInFlight = false;

export type MildDipDiskHygieneConfig = {
  dataDirs: string[];
  journalPath: string;
  tradesPath?: string;
  compressAfterDays: number;
  deleteAfterDays: number;
  deleteEnabled: boolean;
  minFreeBytes: number;
  minFreePct: number;
  guardEnabled: boolean;
};

function isDatedJsonl(name: string): boolean {
  return /^[^/]+-\d{8}\.jsonl$/.test(name) || /^[^/]+\.jsonl\.\d{8}\.\d+\.jsonl$/.test(name);
}

function isProtected(name: string): boolean {
  return (
    name === 'state.json' ||
    name === 'trades.jsonl' ||
    name === 'journal.jsonl' ||
    name === 'hot-mints.json' ||
    name === 'price-ring.json' ||
    name.endsWith('.lock') ||
    name.endsWith('.tmp')
  );
}

function journal(h: MildDipDiskHygieneConfig, event: Record<string, unknown>): void {
  appendMildDipJournal(h.journalPath, event);
}

function diskStats(dataDir: string): { freeBytes: number; freePct: number } {
  const stats = fs.statfsSync(dataDir);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return { freeBytes, freePct: totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0 };
}

export async function checkMildDipDiskSpace(cfg: MildDipDiskHygieneConfig): Promise<{
  freeBytes: number;
  freePct: number;
}> {
  if (!cfg.guardEnabled) return { freeBytes: Number.POSITIVE_INFINITY, freePct: 100 };
  try {
    const first = diskStats(cfg.dataDirs[0] ?? '.');
    const low = first.freeBytes < cfg.minFreeBytes || first.freePct < cfg.minFreePct;
    if (low) {
      await runMildDipDataRetention(cfg);
      const after = diskStats(cfg.dataDirs[0] ?? '.');
      const stillLow = after.freeBytes < cfg.minFreeBytes || after.freePct < cfg.minFreePct;
      if (!diskLow || Date.now() - lastLowWarningAtMs >= 60_000) {
        lastLowWarningAtMs = Date.now();
        console.error(
          `[mild-dip] DISK LOW freeBytes=${after.freeBytes} freePct=${after.freePct.toFixed(2)} ` +
            `retention=${stillLow ? 'insufficient' : 'recovered'}`,
        );
        journal(cfg, {
          kind: 'mild_dip_disk_low',
          freeBytes: after.freeBytes,
          freePct: after.freePct,
          retentionInsufficient: stillLow,
        });
      }
      diskLow = stillLow;
      return after;
    }
    if (diskLow) {
      console.warn(`[mild-dip] disk recovered freeBytes=${first.freeBytes} freePct=${first.freePct.toFixed(2)}`);
      journal(cfg, {
        kind: 'mild_dip_disk_recovered',
        freeBytes: first.freeBytes,
        freePct: first.freePct,
      });
    }
    diskLow = false;
    return first;
  } catch (err) {
    console.warn(`[mild-dip] disk space check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { freeBytes: 0, freePct: 0 };
  }
}

async function compressFile(source: string, target: string, stat: fs.Stats): Promise<void> {
  try {
    await pipeline(
      fs.createReadStream(source),
      zlib.createGzip(),
      fs.createWriteStream(target, { flags: 'wx' }),
    );
    fs.utimesSync(target, stat.atime, stat.mtime);
    fs.unlinkSync(source);
  } catch (err) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* Partial output may already be gone. */
    }
    throw err;
  }
}

export async function runMildDipDataRetention(cfg: MildDipDiskHygieneConfig): Promise<{
  compressed: number;
  deleted: number;
}> {
  if (retentionInFlight) return { compressed: 0, deleted: 0 };
  retentionInFlight = true;
  let compressed = 0;
  let deleted = 0;
  const nowMs = Date.now();
  try {
  for (const dataDir of [...new Set(cfg.dataDirs.map((dir) => path.resolve(dir)))]) {
    let names: string[];
    try {
      names = fs.readdirSync(dataDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (isProtected(name)) continue;
      const full = path.join(dataDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const ageDays = (nowMs - stat.mtimeMs) / 86_400_000;
      if (isDatedJsonl(name) && ageDays > Math.max(2, cfg.compressAfterDays)) {
        const target = `${full}.gz`;
        if (fs.existsSync(target)) continue;
        try {
          await compressFile(full, target, stat);
          compressed += 1;
          journal(cfg, { kind: 'mild_dip_data_compressed', file: full, ageDays: +ageDays.toFixed(2) });
        } catch (err) {
          console.warn(`[mild-dip] compress failed file=${full}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (name.endsWith('.jsonl.gz') && cfg.deleteEnabled && ageDays > cfg.deleteAfterDays) {
        try {
          fs.unlinkSync(full);
          deleted += 1;
          journal(cfg, { kind: 'mild_dip_data_deleted', file: full, ageDays: +ageDays.toFixed(2) });
        } catch {
          /* Best effort maintenance. */
        }
      }
    }
  }
  }
  finally {
    retentionInFlight = false;
  }
  return { compressed, deleted };
}
