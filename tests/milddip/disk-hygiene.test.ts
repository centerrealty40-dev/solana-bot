import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  checkMildDipDiskSpace,
  isMildDipVerboseTelemetryEnabled,
  runMildDipDataRetention,
} from '../../src/milddip/disk-hygiene.js';

describe('mild-dip disk hygiene', () => {
  it('compresses old telemetry while leaving fresh files alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-retention-'));
    const old = path.join(dir, 'leader-dense-20200101.jsonl');
    const fresh = path.join(dir, 'leader-observer-20990101.jsonl');
    fs.writeFileSync(old, '{"kind":"old"}\n');
    fs.writeFileSync(fresh, '{"kind":"fresh"}\n');
    fs.utimesSync(old, new Date(0), new Date(0));
    const journal = path.join(dir, 'journal.jsonl');
    runMildDipDataRetention({
      dataDir: dir,
      journalPath: journal,
      compressAfterDays: 2,
      deleteAfterDays: 14,
      deleteEnabled: true,
      minFreeBytes: 0,
      minFreePct: 0,
      guardEnabled: false,
    });
    expect(fs.existsSync(`${old}.gz`)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.readFileSync(journal, 'utf8')).toContain('mild_dip_data_compressed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes verbose telemetry state without affecting state or trade journals', () => {
    const statfs = vi.spyOn(fs, 'statfsSync');
    statfs.mockReturnValueOnce({
      bavail: 1n,
      bsize: 1n,
      blocks: 100n,
    } as unknown as fs.StatsFs);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-disk-'));
    const cfg = {
      dataDir: dir,
      journalPath: path.join(dir, 'journal.jsonl'),
      compressAfterDays: 2,
      deleteAfterDays: 14,
      deleteEnabled: false,
      minFreeBytes: 10,
      minFreePct: 5,
      guardEnabled: true,
    };
    expect(checkMildDipDiskSpace(cfg).verboseTelemetryEnabled).toBe(false);
    expect(isMildDipVerboseTelemetryEnabled()).toBe(false);
    statfs.mockReturnValueOnce({
      bavail: 100n,
      bsize: 1n,
      blocks: 100n,
    } as unknown as fs.StatsFs);
    expect(checkMildDipDiskSpace(cfg).verboseTelemetryEnabled).toBe(true);
    expect(fs.readFileSync(cfg.journalPath, 'utf8')).toContain('mild_dip_disk_telemetry');
    statfs.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
