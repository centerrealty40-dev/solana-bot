import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { tryAcquireMildDipInstanceLock } from '../../src/milddip/instance-lock.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('tryAcquireMildDipInstanceLock', () => {
  it('allows only one live holder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-lock-'));
    tmpDirs.push(dir);
    const lockPath = path.join(dir, 'mild-dip-bot.lock');
    const a = tryAcquireMildDipInstanceLock(lockPath);
    expect(a).not.toBeNull();
    const b = tryAcquireMildDipInstanceLock(lockPath);
    expect(b).toBeNull();
    a!.release();
    const c = tryAcquireMildDipInstanceLock(lockPath);
    expect(c).not.toBeNull();
    c!.release();
  });

  it('replaces stale lock from a dead pid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-lock-'));
    tmpDirs.push(dir);
    const lockPath = path.join(dir, 'mild-dip-bot.lock');
    fs.writeFileSync(lockPath, '999999999\n2020-01-01T00:00:00.000Z\n', 'utf8');
    const a = tryAcquireMildDipInstanceLock(lockPath);
    expect(a).not.toBeNull();
    const body = fs.readFileSync(lockPath, 'utf8');
    expect(body.startsWith(`${process.pid}\n`)).toBe(true);
    a!.release();
  });

  it('reclaims an old empty lock after finding no live instance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-lock-empty-'));
    tmpDirs.push(dir);
    const lockPath = path.join(dir, 'mild-dip-bot.lock');
    fs.writeFileSync(lockPath, '', 'utf8');
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    const a = tryAcquireMildDipInstanceLock(lockPath);
    expect(a).not.toBeNull();
    a!.release();
  });

  it('refuses a fresh empty lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-lock-fresh-'));
    tmpDirs.push(dir);
    const lockPath = path.join(dir, 'mild-dip-bot.lock');
    fs.writeFileSync(lockPath, '', 'utf8');
    expect(tryAcquireMildDipInstanceLock(lockPath)).toBeNull();
  });

  it('refuses an old empty lock when another mild-dip process is live', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-lock-live-'));
    tmpDirs.push(dir);
    const lockPath = path.join(dir, 'mild-dip-bot.lock');
    fs.writeFileSync(lockPath, '', 'utf8');
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'mild-dip-bot'], {
      cwd: dir,
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(tryAcquireMildDipInstanceLock(lockPath)).toBeNull();
    } finally {
      child.kill();
    }
  });

  it('reclaims an old empty lock when a different instance is live', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-lock-other-'));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-lock-other-live-'));
    tmpDirs.push(dir, otherDir);
    const lockPath = path.join(dir, 'mild-dip-bot.lock');
    fs.writeFileSync(lockPath, '', 'utf8');
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'mild-dip-bot'], {
      cwd: otherDir,
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const lock = tryAcquireMildDipInstanceLock(lockPath);
      expect(lock).not.toBeNull();
      lock?.release();
    } finally {
      child.kill();
    }
  });
});
