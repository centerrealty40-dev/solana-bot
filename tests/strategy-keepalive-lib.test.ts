import { describe, expect, it, vi } from 'vitest';
import { ensurePm2App, getPm2StatusMap } from '../scripts-tmp/strategy-keepalive-lib.mjs';

describe('strategy-keepalive-lib', () => {
  it('parses pm2 jlist into status map', () => {
    const execSyncFn = vi.fn(() =>
      JSON.stringify([
        { name: 'copy-trader-8zkg', pm2_env: { status: 'online' } },
        { name: 'copy-trader-8zkg-mirror', pm2_env: { status: 'stopped' } },
      ]),
    );
    const map = getPm2StatusMap('/opt/solana-alpha', execSyncFn);
    expect(map.get('copy-trader-8zkg')).toBe('online');
    expect(map.get('copy-trader-8zkg-mirror')).toBe('stopped');
  });

  it('starts from ecosystem when app is missing', () => {
    const calls = [];
    const execSyncFn = vi.fn((cmd) => {
      calls.push(String(cmd));
      return '';
    });
    // ecosystem exists in this repo
    const r = ensurePm2App({
      root: process.cwd(),
      pm2Name: 'copy-trader-8zkg',
      status: 'missing',
      execSyncFn,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('start');
    expect(calls[0]).toContain('pm2 start ecosystem.config.cjs --only copy-trader-8zkg');
  });

  it('restarts when stopped', () => {
    const execSyncFn = vi.fn(() => '');
    const r = ensurePm2App({
      root: process.cwd(),
      pm2Name: 'copy-trader-8zkg',
      status: 'stopped',
      execSyncFn,
    });
    expect(r.action).toBe('restart');
    expect(String(execSyncFn.mock.calls[0][0])).toContain('pm2 restart copy-trader-8zkg');
  });
});
