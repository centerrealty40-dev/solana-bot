import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});
