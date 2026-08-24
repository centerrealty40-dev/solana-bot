import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  checkMildDipDiskSpace,
  rotateMildDipJournal,
  runMildDipDataRetention,
} from '../../src/milddip/disk-hygiene.js';

describe('mild-dip disk hygiene', () => {
  it('compresses old telemetry while leaving fresh files alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-retention-'));
    const old = path.join(dir, 'custom-feed-20200101.jsonl');
    const fresh = path.join(dir, 'leader-observer-20990101.jsonl');
    fs.writeFileSync(old, '{"kind":"old"}\n');
    fs.writeFileSync(fresh, '{"kind":"fresh"}\n');
    fs.utimesSync(old, new Date(0), new Date(0));
    const journal = path.join(dir, 'journal.jsonl');
    runMildDipDataRetention({
      dataDirs: [dir],
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

  it('rotates an oversized journal into a gzipped sibling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-rotation-'));
    const journal = path.join(dir, 'journal.jsonl');
    fs.writeFileSync(journal, 'x'.repeat(32));
    expect(rotateMildDipJournal(journal, 8)).toBe(true);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.endsWith('.jsonl.gz'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs emergency retention when space is low and journals recovery', () => {
    const statfs = vi.spyOn(fs, 'statfsSync');
    statfs.mockReturnValue({
      bavail: 1n,
      bsize: 1n,
      blocks: 100n,
    } as unknown as fs.StatsFs);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-disk-'));
    const cfg = {
      dataDirs: [dir],
      journalPath: path.join(dir, 'journal.jsonl'),
      compressAfterDays: 2,
      deleteAfterDays: 14,
      deleteEnabled: false,
      minFreeBytes: 10,
      minFreePct: 5,
      guardEnabled: true,
    };
    expect(checkMildDipDiskSpace(cfg).freeBytes).toBe(1);
    statfs.mockReturnValueOnce({
      bavail: 100n,
      bsize: 1n,
      blocks: 100n,
    } as unknown as fs.StatsFs);
    expect(checkMildDipDiskSpace(cfg).freeBytes).toBe(100);
    expect(fs.readFileSync(cfg.journalPath, 'utf8')).toContain('mild_dip_disk_recovered');
    statfs.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
