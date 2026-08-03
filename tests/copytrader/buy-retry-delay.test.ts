import { describe, expect, it } from 'vitest';
import { resolveBuyRetryDelayMs } from '../../src/copytrader/buy-retry-delay.js';

describe('resolveBuyRetryDelayMs', () => {
  it('returns 0 when base is 0', () => {
    expect(resolveBuyRetryDelayMs(0, '0x1771')).toBe(0);
  });

  it('fast-path slippage / 0x1771 to ≤500ms', () => {
    expect(
      resolveBuyRetryDelayMs(
        1000,
        'rpc_error:Transaction simulation failed: custom program error: 0x1771',
      ),
    ).toBe(500);
  });

  it('fast-path BlockhashNotFound to ≤250ms', () => {
    expect(
      resolveBuyRetryDelayMs(1000, 'rpc_error:Transaction simulation failed: Blockhash not found:BlockhashNotFound'),
    ).toBe(250);
  });

  it('backs off qn_rate to ≥2s', () => {
    expect(resolveBuyRetryDelayMs(500, 'qn_rate:Too Many Requests')).toBe(2000);
  });

  it('uses base for unknown reasons', () => {
    expect(resolveBuyRetryDelayMs(1000, 'other_fail')).toBe(1000);
  });
});
