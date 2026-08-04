import { describe, expect, it } from 'vitest';
import { extractSignature, resolveLeaderStreamWsUrl } from '../../src/copytrader/leader-stream-ws.js';

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

describe('extractSignature', () => {
  const sig = '5ST7iyCu8sFsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('reads top-level signature', () => {
    expect(extractSignature({ signature: sig })).toBe(sig);
  });

  it('reads Helius transaction.signatures[0]', () => {
    expect(
      extractSignature({
        transaction: { transaction: { signatures: [sig] } },
      }),
    ).toBe(sig);
  });

  it('reads logsNotification value.signature', () => {
    expect(extractSignature({ value: { signature: sig } })).toBe(sig);
  });

  it('returns null for short junk', () => {
    expect(extractSignature({ signature: 'too-short' })).toBeNull();
  });
});
