import { describe, expect, it } from 'vitest';
import { lamportsFromGetBalanceResult } from '../src/core/rpc/qn-client.js';

describe('lamportsFromGetBalanceResult', () => {
  it('parses bare number', () => {
    expect(lamportsFromGetBalanceResult(115_490_123)).toBe(115490123n);
  });

  it('parses decimal string', () => {
    expect(lamportsFromGetBalanceResult('115490123')).toBe(115490123n);
  });

  it('parses QuickNode nested { context, value }', () => {
    expect(
      lamportsFromGetBalanceResult({
        context: { apiVersion: '3.1.13', slot: 1 },
        value: 115_490_123,
      }),
    ).toBe(115490123n);
  });

  it('returns null for garbage', () => {
    expect(lamportsFromGetBalanceResult(null)).toBe(null);
    expect(lamportsFromGetBalanceResult({})).toBe(null);
    expect(lamportsFromGetBalanceResult(NaN)).toBe(null);
  });
});
