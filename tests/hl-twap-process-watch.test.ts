import { describe, expect, it } from 'vitest';

import {
  assessHlTwapHealth,
  parseHeartbeatJson,
  parseHeartbeatLogLine,
} from '../scripts-tmp/hl-twap-watch-lib.mjs';

describe('parseHeartbeatLogLine', () => {
  it('parses heartbeat console line', () => {
    const line =
      '[hl-twap-telegram-watch] heartbeat active_twaps=3 pending_live=1 live_opens=2';
    expect(parseHeartbeatLogLine(line)).toEqual({
      activeTwaps: 3,
      pendingLive: 1,
      liveOpens: 2,
    });
  });
});

describe('parseHeartbeatJson', () => {
  it('reads ts from heartbeat file', () => {
    const hb = parseHeartbeatJson('{"ts":1000,"active_twaps":1}\n');
    expect(hb?.ts).toBe(1000);
  });
});

describe('assessHlTwapHealth', () => {
  it('ok when online and fresh heartbeat', () => {
    expect(
      assessHlTwapHealth({
        status: 'online',
        heartbeatAgeMs: 30_000,
        heartbeatMaxStaleMs: 300_000,
      }).ok,
    ).toBe(true);
  });

  it('flags stopped pm2', () => {
    const r = assessHlTwapHealth({
      status: 'stopped',
      heartbeatAgeMs: 30_000,
      heartbeatMaxStaleMs: 300_000,
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toBe('pm2_status_stopped');
  });

  it('flags stale heartbeat while online', () => {
    const r = assessHlTwapHealth({
      status: 'online',
      heartbeatAgeMs: 600_000,
      heartbeatMaxStaleMs: 300_000,
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/^heartbeat_stale_/);
  });
});
