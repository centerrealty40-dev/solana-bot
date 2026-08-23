import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { burnDustOrphans } from '../../src/milddip/dust-burn.js';

const mint = 'So11111111111111111111111111111111111111113';
const nowMs = 10_000_000;
const signer = Keypair.generate();

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    executionMode: 'live',
    dustBurnEnabled: true,
    dustBurnMaxUsd: 0.5,
    dustBurnMaxPerPass: 20,
    dustBurnMinAgeMs: 6 * 3_600_000,
    dustBurnSettleMs: 10 * 60_000,
    rpcUrl: 'https://example.invalid',
    walletSecret: 'wallet.json',
    walletPubkeyExpected: signer.publicKey.toBase58(),
    journalPath: '/tmp/dust-burn-test.jsonl',
    statePath: '/tmp/dust-burn-state.json',
    recentEntryMsByMint: {},
    lastExitByMint: {},
    leaderMirrorWatches: {},
    open: {},
    ...overrides,
  } as never;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint,
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    amountRaw: '100000',
    lamports: 2_000_000,
    decimals: 6,
    uiAmount: 0.1,
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    open: {},
    cooldownUntilMs: {},
    recentEntryMsByMint: {},
    lastExitByMint: {},
    leaderMirrorWatches: {},
    updatedAtMs: nowMs,
    ...overrides,
  } as never;
}

function deps(rows = [row()], quoteUsd: number | null = 0.1) {
  return {
    signer: () => signer,
    list: async () => rows,
    quote: async () =>
      quoteUsd == null
        ? { kind: 'unknown' as const, quoteUsd: null }
        : { kind: 'ok' as const, quoteUsd },
    burn: async () => ({ signature: 'sig', reclaimedLamports: 2_000_000 }),
  };
}

describe('dust burn', () => {
  it('is disabled by default', async () => {
    const result = await burnDustOrphans({
      cfg: cfg({ dustBurnEnabled: false }),
      state: state(),
      nowMs,
      deps: deps(),
    });
    expect(result.burned).toBe(0);
    expect(result.candidates).toBe(0);
  });

  it('skips an open position', async () => {
    const result = await burnDustOrphans({
      cfg: cfg(),
      state: state({ open: { [mint]: { mint } } }),
      nowMs,
      deps: deps(),
    });
    expect(result.skipped).toBe(1);
    expect(result.burned).toBe(0);
  });

  it('skips a fresh entry and recent exit', async () => {
    const fresh = await burnDustOrphans({
      cfg: cfg(),
      state: state({ recentEntryMsByMint: { [mint]: [nowMs - 1] } }),
      nowMs,
      deps: deps(),
    });
    expect(fresh.skipped).toBe(1);
    const recentExit = await burnDustOrphans({
      cfg: cfg(),
      state: state({ lastExitByMint: { [mint]: { atMs: nowMs - 1 } } }),
      nowMs,
      deps: deps(),
    });
    expect(recentExit.skipped).toBe(1);
  });

  it('skips values above the threshold and unknown quote failures', async () => {
    const expensive = await burnDustOrphans({
      cfg: cfg(),
      state: state(),
      nowMs,
      deps: deps([row()], 0.5),
    });
    expect(expensive.burned).toBe(0);
    expect(expensive.skipped).toBe(1);
    const failed = await burnDustOrphans({
      cfg: cfg(),
      state: state(),
      nowMs,
      deps: deps([row()], null),
    });
    expect(failed.burned).toBe(0);
    expect(failed.skipped).toBe(1);
    const timedOut = await burnDustOrphans({
      cfg: cfg(),
      state: state(),
      nowMs,
      deps: {
        ...deps(),
        quote: async () => {
          throw new Error('timeout');
        },
      },
    });
    expect(timedOut.burned).toBe(0);
    expect(timedOut.skipped).toBe(1);
  });

  it('burns unroutable and below-threshold balances', async () => {
    const unroutable = await burnDustOrphans({
      cfg: cfg(),
      state: state(),
      nowMs,
      deps: {
        ...deps(),
        quote: async () => ({ kind: 'unroutable' as const, quoteUsd: null }),
      },
    });
    expect(unroutable.burned).toBe(1);
    const cheap = await burnDustOrphans({
      cfg: cfg(),
      state: state(),
      nowMs,
      deps: deps([row()], 0.49),
    });
    expect(cheap.burned).toBe(1);
  });

  it('confirms skipped no-route twice before burning', async () => {
    const verdicts = [
      { kind: 'skipped' as const, reason: 'no-route' as const, ts: 1 },
      { kind: 'skipped' as const, reason: 'no-route' as const, ts: 2 },
    ];
    const result = await burnDustOrphans({
      cfg: cfg(),
      state: state(),
      nowMs,
      deps: {
        ...deps(),
        quote: undefined,
        sleep: async () => {},
        jupiterQuote: async () => verdicts.shift()!,
      },
    });
    expect(result.burned).toBe(1);
  });

  it('does not burn when no-route confirmation is not also no-route', async () => {
    let okCalls = 0;
    const result = await burnDustOrphans({
      cfg: cfg(),
      state: state(),
      nowMs,
      deps: {
        ...deps(),
        quote: undefined,
        sleep: async () => {},
        jupiterQuote: async () => {
          okCalls += 1;
          if (okCalls === 1) {
            return { kind: 'skipped' as const, reason: 'no-route' as const, ts: 1 };
          }
          return {
            kind: 'ok' as const,
            jupiterPriceUsd: 10,
            snapshotPriceUsd: 1,
            slipPct: 0,
            priceImpactPct: 0,
            routeHops: 1,
            source: 'jupiter' as const,
            ageMs: 1,
            ts: 2,
          };
        },
      },
    });
    let calls = 0;
    const transportError = await burnDustOrphans({
      cfg: cfg(),
      state: state(),
      nowMs,
      deps: {
        ...deps(),
        quote: undefined,
        sleep: async () => {},
        jupiterQuote: async () => {
          calls += 1;
          if (calls === 1) {
            return { kind: 'skipped' as const, reason: 'no-route' as const, ts: 1 };
          }
          throw new Error('transport');
        },
      },
    });
    expect(result.burned).toBe(0);
    expect(transportError.burned).toBe(0);
    expect(transportError.skipped).toBe(1);
  });

  it('honors the per-pass cap', async () => {
    const rows = [row(), row(), row(), row(), row()];
    const journalPath = `/tmp/dust-burn-cap-${Date.now()}-${Math.random()}.jsonl`;
    const result = await burnDustOrphans({
      cfg: cfg({ dustBurnMaxPerPass: 2, journalPath }),
      state: state(),
      nowMs,
      deps: deps(rows, 0.1),
    });
    expect(result.burned).toBe(2);
    expect(result.skipped).toBe(3);
    const entries = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const capEntries = entries.filter(
      (entry) =>
        entry.kind === 'mild_dip_dust_burn_skip' && entry.reason === 'max_per_pass',
    );
    expect(capEntries).toHaveLength(1);
    expect(capEntries[0].skipped).toBe(3);
  });
});
