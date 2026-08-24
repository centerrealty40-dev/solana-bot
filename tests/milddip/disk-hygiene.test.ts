import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  checkMildDipDiskSpace,
  rotateMildDipJournal,
  runMildDipEmergencyRetention,
  runMildDipDataRetention,
} from '../../src/milddip/disk-hygiene.js';
import { appendMildDipJournal } from '../../src/milddip/state.js';

describe('mild-dip disk hygiene', () => {
  it('compresses old telemetry while leaving fresh files alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-retention-'));
    const old = path.join(dir, 'custom-feed-20200101.jsonl');
    const fresh = path.join(dir, 'leader-observer-20990101.jsonl');
    fs.writeFileSync(old, '{"kind":"old"}\n');
    fs.writeFileSync(fresh, '{"kind":"fresh"}\n');
    fs.utimesSync(old, new Date(0), new Date(0));
    const journal = path.join(dir, 'journal.jsonl');
    const readFile = vi.spyOn(fs, 'readFileSync');
    await runMildDipDataRetention({
      dataDirs: [dir],
      journalPath: journal,
      compressAfterDays: 2,
      deleteAfterDays: 14,
      deleteEnabled: true,
      minFreeBytes: 0,
      minFreePct: 0,
      guardEnabled: false,
      emergencyEnabled: false,
      emergencyKeepDays: 2,
    });
    expect(fs.existsSync(`${old}.gz`)).toBe(true);
    expect(readFile.mock.calls.some(([file]) => file === old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.readFileSync(journal, 'utf8')).toContain('mild_dip_data_compressed');
    readFile.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotates an oversized journal into a gzipped sibling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-rotation-'));
    const journal = path.join(dir, 'journal.jsonl');
    fs.writeFileSync(journal, 'x'.repeat(32));
    expect(rotateMildDipJournal(journal, 8)).toBe(true);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.endsWith('.jsonl'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not stat the live journal on every append', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-append-'));
    const journal = path.join(dir, 'journal.jsonl');
    const stat = vi.spyOn(fs, 'statSync');
    appendMildDipJournal(journal, { kind: 'one' });
    const afterFirst = stat.mock.calls.length;
    appendMildDipJournal(journal, { kind: 'two' });
    appendMildDipJournal(journal, { kind: 'three' });
    expect(stat.mock.calls.length).toBe(afterFirst);
    stat.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs emergency retention when space is low and journals recovery', async () => {
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
      emergencyEnabled: false,
      emergencyKeepDays: 2,
    };
    expect((await checkMildDipDiskSpace(cfg)).freeBytes).toBe(1);
    statfs.mockReturnValueOnce({
      bavail: 100n,
      bsize: 1n,
      blocks: 100n,
    } as unknown as fs.StatsFs);
    expect((await checkMildDipDiskSpace(cfg)).freeBytes).toBe(100);
    expect(fs.readFileSync(cfg.journalPath, 'utf8')).toContain('mild_dip_disk_recovered');
    statfs.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes oldest eligible files until the emergency free-space threshold is met', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-emergency-'));
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-emergency-'));
    const oldest = path.join(dir, 'leader-20200101.jsonl');
    const next = path.join(secondDir, 'observer-20200102.jsonl.gz');
    const fresh = path.join(dir, 'leader-20990101.jsonl');
    fs.writeFileSync(oldest, 'oldest');
    fs.writeFileSync(next, 'next');
    fs.writeFileSync(fresh, 'fresh');
    fs.utimesSync(oldest, new Date(0), new Date(0));
    fs.utimesSync(next, new Date(86_400_000), new Date(86_400_000));
    const statfs = vi.spyOn(fs, 'statfsSync');
    statfs
      .mockReturnValueOnce({ bavail: 1n, bsize: 1n, blocks: 100n } as unknown as fs.StatsFs)
      .mockReturnValueOnce({ bavail: 1n, bsize: 1n, blocks: 100n } as unknown as fs.StatsFs)
      .mockReturnValue({ bavail: 100n, bsize: 1n, blocks: 100n } as unknown as fs.StatsFs);
    const journal = path.join(dir, 'journal.jsonl');
    const result = await runMildDipEmergencyRetention({
      dataDirs: [dir, secondDir],
      journalPath: journal,
      compressAfterDays: 2,
      deleteAfterDays: 14,
      deleteEnabled: true,
      minFreeBytes: 10,
      minFreePct: 5,
      guardEnabled: true,
      emergencyEnabled: true,
      emergencyKeepDays: 2,
    });
    expect(result).toEqual({ deleted: 2, freedBytes: 10 });
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(next)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.readFileSync(journal, 'utf8')).toContain('mild_dip_data_emergency_deleted');
    expect(fs.readFileSync(journal, 'utf8')).toContain('mild_dip_emergency_retention');
    statfs.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(secondDir, { recursive: true, force: true });
  });

  it('never deletes protected state, journal, trades, lock, or temporary files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-emergency-protected-'));
    const names = ['state.json', 'journal.jsonl', 'trades.jsonl', 'worker.lock', 'hot-mints.json.tmp'];
    for (const name of names) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, 'protected');
      fs.utimesSync(file, new Date(0), new Date(0));
    }
    const statfs = vi.spyOn(fs, 'statfsSync').mockReturnValue({
      bavail: 1n,
      bsize: 1n,
      blocks: 100n,
    } as unknown as fs.StatsFs);
    const cfg = {
      dataDirs: [dir],
      journalPath: path.join(dir, 'journal.jsonl'),
      compressAfterDays: 2,
      deleteAfterDays: 14,
      deleteEnabled: true,
      minFreeBytes: 10,
      minFreePct: 5,
      guardEnabled: true,
      emergencyEnabled: true,
      emergencyKeepDays: 2,
    };
    expect(await runMildDipEmergencyRetention(cfg)).toEqual({ deleted: 0, freedBytes: 0 });
    for (const name of names) expect(fs.existsSync(path.join(dir, name))).toBe(true);
    statfs.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when emergency retention is disabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-emergency-disabled-'));
    const file = path.join(dir, 'leader-20200101.jsonl');
    fs.writeFileSync(file, 'old');
    fs.utimesSync(file, new Date(0), new Date(0));
    const result = await runMildDipEmergencyRetention({
      dataDirs: [dir],
      journalPath: path.join(dir, 'journal.jsonl'),
      compressAfterDays: 2,
      deleteAfterDays: 14,
      deleteEnabled: true,
      minFreeBytes: 10,
      minFreePct: 5,
      guardEnabled: true,
      emergencyEnabled: false,
      emergencyKeepDays: 2,
    });
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
