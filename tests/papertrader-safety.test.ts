import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/core/rpc/qn-client.js', () => ({
  qnBatchCall: vi.fn(),
}));

import { qnBatchCall } from '../src/core/rpc/qn-client.js';
import { evaluateMintSafety } from '../src/papertrader/safety/index.js';

const mockBatch = vi.mocked(qnBatchCall);

const baseOpts = {
  topHolderMaxPct: 40,
  requireMintAuthorityNull: true,
  requireFreezeAuthorityNull: true,
  treatAsAmm: false,
  timeoutMs: 2000,
};

beforeEach(() => mockBatch.mockReset());
afterEach(() => mockBatch.mockReset());

describe('evaluateMintSafety', () => {
  it('ok when authorities revoked + top1<=40%', async () => {
    mockBatch.mockResolvedValue({
      ok: true,
      value: [
        {
          value: {
            data: {
              parsed: {
                info: {
                  mintAuthority: null,
                  freezeAuthority: null,
                  decimals: 6,
                  supply: '1000000000',
                },
              },
            },
          },
        },
        { value: [{ address: 'a', amount: '300000000', uiAmount: 300 }] },
      ],
    });
    const r = await evaluateMintSafety('mint', baseOpts);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.ok).toBe(true);
  });

  it('rejects when mint_authority not revoked', async () => {
    mockBatch.mockResolvedValue({
      ok: true,
      value: [
        {
          value: {
            data: {
              parsed: {
                info: {
                  mintAuthority: 'AuthOwnerXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                  freezeAuthority: null,
                  decimals: 6,
                  supply: '1000000000',
                },
              },
            },
          },
        },
        { value: [{ address: 'a', amount: '100000000', uiAmount: 100 }] },
      ],
    });
    const r = await evaluateMintSafety('mint', baseOpts);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') {
      expect(r.verdict.ok).toBe(false);
      expect(r.verdict.reasons.some((x) => x.startsWith('mint_authority='))).toBe(true);
    }
  });

  it('rejects when top1 > threshold and not amm', async () => {
    mockBatch.mockResolvedValue({
      ok: true,
      value: [
        {
          value: {
            data: {
              parsed: {
                info: {
                  mintAuthority: null,
                  freezeAuthority: null,
                  decimals: 6,
                  supply: '1000000000',
                },
              },
            },
          },
        },
        { value: [{ address: 'a', amount: '600000000', uiAmount: 600 }] },
      ],
    });
    const r = await evaluateMintSafety('mint', baseOpts);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') {
      expect(r.verdict.ok).toBe(false);
      expect(r.verdict.reasons.some((x) => x.startsWith('top1='))).toBe(true);
    }
  });

  it('skips top1 when treatAsAmm=true', async () => {
    mockBatch.mockResolvedValue({
      ok: true,
      value: [
        {
          value: {
            data: {
              parsed: {
                info: {
                  mintAuthority: null,
                  freezeAuthority: null,
                  decimals: 6,
                  supply: '1000000000',
                },
              },
            },
          },
        },
        { value: [{ address: 'a', amount: '900000000', uiAmount: 900 }] },
      ],
    });
    const r = await evaluateMintSafety('mint', { ...baseOpts, treatAsAmm: true });
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.ok).toBe(true);
  });

  it('skipped when QN budget exhausted', async () => {
    mockBatch.mockResolvedValue({ ok: false, reason: 'budget' });
    const r = await evaluateMintSafety('mint', baseOpts);
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toBe('budget');
  });
});
