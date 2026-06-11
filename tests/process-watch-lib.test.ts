import { describe, expect, it } from 'vitest';

import {
  assessProcessHealth,
  defaultStrategyWatchTargets,
  parseHeartbeatJson,
  parseWatchTargetsJson,
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

  it('default targets include four live bots', () => {
    const t = defaultStrategyWatchTargets('/opt/solana-alpha');
    expect(t.map((x) => x.pm2)).toEqual([
      'hl-twap-telegram-watch',
      'live-oscar',
      'copy-trader',
      'pumpswap-combo-follow-live',
    ]);
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
