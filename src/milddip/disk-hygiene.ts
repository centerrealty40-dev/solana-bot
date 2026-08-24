import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { appendMildDipJournal } from './state.js';

let verboseTelemetryEnabled = true;

export function isMildDipVerboseTelemetryEnabled(): boolean {
  return verboseTelemetryEnabled;
}

export type MildDipDiskHygieneConfig = {
  dataDir: string;
  journalPath: string;
  compressAfterDays: number;
  deleteAfterDays: number;
  deleteEnabled: boolean;
  minFreeBytes: number;
  minFreePct: number;
  guardEnabled: boolean;
};

function datedTelemetry(name: string): boolean {
  return /^(leader-dense|leader-observer)-\d{8}\.jsonl$/.test(name);
}

function setTelemetryMode(cfg: MildDipDiskHygieneConfig, enabled: boolean, freeBytes: number, freePct: number): void {
  if (enabled === verboseTelemetryEnabled) return;
  verboseTelemetryEnabled = enabled;
  const kind = enabled ? 'mild_dip_disk_telemetry_resumed' : 'mild_dip_disk_telemetry_throttled';
  console.error(
    `[mild-dip] ${kind} freeBytes=${freeBytes} freePct=${freePct.toFixed(2)} dataDir=${cfg.dataDir}`,
  );
  appendMildDipJournal(cfg.journalPath, {
    kind,
    freeBytes,
    freePct,
    dataDir: cfg.dataDir,
  });
}

export function checkMildDipDiskSpace(cfg: MildDipDiskHygieneConfig): {
  freeBytes: number;
  freePct: number;
  verboseTelemetryEnabled: boolean;
} {
  if (!cfg.guardEnabled) return { freeBytes: Number.POSITIVE_INFINITY, freePct: 100, verboseTelemetryEnabled: true };
  try {
    const stats = fs.statfsSync(cfg.dataDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freePct = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
    const low = freeBytes < cfg.minFreeBytes || freePct < cfg.minFreePct;
    setTelemetryMode(cfg, !low, freeBytes, freePct);
    return { freeBytes, freePct, verboseTelemetryEnabled: !low };
  } catch (err) {
    console.warn(`[mild-dip] disk space check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { freeBytes: 0, freePct: 0, verboseTelemetryEnabled };
  }
}

export function runMildDipDataRetention(cfg: MildDipDiskHygieneConfig): {
  compressed: number;
  deleted: number;
} {
  let compressed = 0;
  let deleted = 0;
  const nowMs = Date.now();
  try {
    for (const name of fs.readdirSync(cfg.dataDir)) {
      const full = path.join(cfg.dataDir, name);
      const stat = fs.statSync(full);
      const ageDays = (nowMs - stat.mtimeMs) / 86_400_000;
      if (datedTelemetry(name) && ageDays > cfg.compressAfterDays) {
        const target = `${full}.gz`;
        if (!fs.existsSync(target)) {
          fs.writeFileSync(target, zlib.gzipSync(fs.readFileSync(full)));
          fs.utimesSync(target, stat.atime, stat.mtime);
          fs.unlinkSync(full);
          compressed += 1;
          appendMildDipJournal(cfg.journalPath, {
            kind: 'mild_dip_data_compressed',
            file: name,
            ageDays: +ageDays.toFixed(2),
          });
        }
      } else if (name.endsWith('.jsonl.gz') && cfg.deleteEnabled && ageDays > cfg.deleteAfterDays) {
        fs.unlinkSync(full);
        deleted += 1;
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_data_deleted',
          file: name,
          ageDays: +ageDays.toFixed(2),
        });
      }
    }
  } catch (err) {
    console.warn(`[mild-dip] data retention failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { compressed, deleted };
}
