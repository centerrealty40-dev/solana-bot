import { describe, expect, it } from 'vitest';
import { resolveLeaderStreamWsUrl } from '../../src/copytrader/leader-stream-ws.js';

describe('resolveLeaderStreamWsUrl', () => {
  it('prefers explicit WS URL', () => {
    expect(
      resolveLeaderStreamWsUrl({
        COPY_TRADER_LEADER_STREAM_WS_URL: 'wss://example.test/ws',
        HELIUS_API_KEY: 'secret',
      } as NodeJS.ProcessEnv),
    ).toBe('wss://example.test/ws');
  });

  it('builds from HELIUS_API_KEY', () => {
    const url = resolveLeaderStreamWsUrl({ HELIUS_API_KEY: 'abc123' } as NodeJS.ProcessEnv);
    expect(url).toBe('wss://mainnet.helius-rpc.com/?api-key=abc123');
  });

  it('returns null when nothing configured', () => {
    expect(resolveLeaderStreamWsUrl({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
