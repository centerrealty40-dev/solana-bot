import { describe, expect, it } from 'vitest';

import {
  assessLiveOscarProcessSingleton,
  assessProcessHealth,
  defaultStrategyWatchTargets,
  parseHeartbeatJson,
  parseProcEnvironKey,
  parseWatchTargetsJson,
  readExpectedLiveOscarEntrySplitLegUsd,
} from '../scripts-tmp/process-watch-lib.mjs';

describe('process-watch-lib', () => {
  it('parses heartbeat json', () => {
    expect(parseHeartbeatJson('{"ts":1000}\n')?.ts).toBe(1000);
  });

  it('assesses stopped pm2', () => {
    const r = assessProcessHealth({
      status: 'stopped',
      heartbeatAgeMs: 1000,
      heartbeatMaxStaleMs: 300_000,
    });
    expect(r.ok).toBe(false);
  });

  it('default targets are mild-dip only (8zkg twins retired)', () => {
    const t = defaultStrategyWatchTargets('/opt/solana-alpha');
    expect(t.map((x) => x.pm2)).toEqual(['mild-dip-bot']);
  });

  it('assessLiveOscarProcessSingleton rejects duplicate and wrong user', () => {
    const r = assessLiveOscarProcessSingleton(
      [
        { pid: 1, user: 'root', entrySplitLegUsd: '300', firstProbeEnabled: '1' },
        { pid: 2, user: 'salpha', entrySplitLegUsd: '1000', firstProbeEnabled: '0' },
      ],
      { expectedEntrySplitLegUsd: '1000' },
    );
    expect(r.ok).toBe(false);
    expect(r.issues).toContain('live_oscar_script_duplicate_2');
    expect(r.issues).toContain('live_oscar_wrong_user_root');
    expect(r.issues).toContain('live_oscar_env_leg_mismatch_300_not_1000');
    expect(r.issues).toContain('live_oscar_first_probe_enabled_on_process');
  });

  it('assessLiveOscarProcessSingleton ok for single salpha process', () => {
    const r = assessLiveOscarProcessSingleton(
      [{ pid: 9, user: 'salpha', entrySplitLegUsd: '1000', firstProbeEnabled: '0' }],
      { expectedEntrySplitLegUsd: '1000' },
    );
    expect(r.ok).toBe(true);
  });

  it('reads expected split leg from ecosystem snippet', () => {
    const leg = readExpectedLiveOscarEntrySplitLegUsd(
      "PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD: '1000',",
    );
    expect(leg).toBe('1000');
  });

  it('parseProcEnvironKey reads split leg from environ buffer', () => {
    const buf = Buffer.from(
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD=1000\0LIVE_MINT_FIRST_PROBE_ENABLED=0\0',
      'binary',
    );
    expect(parseProcEnvironKey(buf, 'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD')).toBe('1000');
  });

  it('parses custom targets json', () => {
    const t = parseWatchTargetsJson(
      JSON.stringify([{ pm2: 'copy-trader', heartbeatPath: 'data/x.json', staleMs: 120000 }]),
      '/root',
    );
    expect(t?.[0].heartbeatPath).toBe('/root/data/x.json');
    expect(t?.[0].staleMs).toBe(120_000);
  });
});
