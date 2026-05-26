import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.SPIKE_ALERT_SKIP_MAIN = '1';
  process.env.SPIKE_ALERT_CANONICAL_POOL_BY_MAX_LIQ = '1';
  process.env.SPIKE_ALERT_TELEGRAM_BOT_TOKEN = '';
  process.env.SPIKE_ALERT_TELEGRAM_CHAT_ID = '';
});

function meta(mint: string, pair: string, liq: number) {
  return {
    base_mint: mint,
    pair_address: pair,
    px_now: 0.01,
    ts_now: new Date(),
    symbol: 'TEST',
    token_name: 'Test',
    holder_count: 5000,
    liq_usd: liq,
    token_fdv_usd: 5_000_000,
  };
}

describe('canonical pool selection (max liq)', () => {
  it('Goblin-like: picks pumpswap over dead meteora — dead pool never analyzed', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const map = mod.buildMintCanonicalPoolMap([
      {
        table: 'meteora_pair_snapshots',
        rows: [meta('GoblinMint', 'CK71dead', 38_000)],
      },
      {
        table: 'pumpswap_pair_snapshots',
        rows: [meta('GoblinMint', 'LivePump', 553_000)],
      },
    ]);
    const entry = map.get('GoblinMint');
    expect(entry?.meta.pair_address).toBe('LivePump');
    expect(entry?.table).toBe('pumpswap_pair_snapshots');
    expect(entry?.liq).toBe(553_000);
  });

  it('real dump on best pool is still the detection source', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const map = mod.buildMintCanonicalPoolMap([
      {
        table: 'raydium_pair_snapshots',
        rows: [meta('DumpMint', 'RayPair', 400_000)],
      },
      {
        table: 'meteora_pair_snapshots',
        rows: [meta('DumpMint', 'MetPair', 120_000)],
      },
    ]);
    expect(map.get('DumpMint')?.meta.pair_address).toBe('RayPair');
  });

  it('buildMintMaxLiqFromLatestRows — max across pairs', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const map = mod.buildMintMaxLiqFromLatestRows([
      { base_mint: 'mintA', liq_usd: 38_000 },
      { base_mint: 'mintA', liq_usd: 553_000 },
      { base_mint: 'mintB', liq_usd: 10_000 },
    ]);
    expect(map.get('mintA')).toBe(553_000);
    expect(map.get('mintB')).toBe(10_000);
  });
});

describe('live_daily_summary JSONL schema', () => {
  it('parses live_daily_summary event body', async () => {
    const { safeParseLiveEventBody } = await import('../src/live/events.js');
    const r = safeParseLiveEventBody({
      kind: 'live_daily_summary',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_086_400_000,
      evals: 100,
      passes: 5,
      buyAttempts: 2,
      buyConfirmed: 1,
      sellConfirmed: 1,
      closedPositions: 1,
      netPnlUsd: -12.5,
      simErrCount: 0,
      stagedCooldownRearms: 0,
      autoDenylistAdds: 0,
      priorityFeeBoosts: 0,
      topBlockers: [{ reason: 'dip_no_window_pass', count: 80 }],
    });
    expect(r.success).toBe(true);
  });
});
