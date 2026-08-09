import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrapVolGreenEnv,
  VOL_GREEN_DEFAULT_WALLET_PUBKEY,
} from '../../src/volgreen/bootstrap-env.js';

const KEYS = [
  'MILD_DIP_ENTRY_MODE',
  'MILD_DIP_WALLET_PUBKEY',
  'MILD_DIP_JOURNAL_PATH',
  'MILD_DIP_MIN_DIP_PCT',
  'MILD_DIP_MAX_DIP_PCT',
  'MILD_DIP_EXIT_ARM_PCT',
  'MILD_DIP_EXIT_GIVEBACK_PCT',
  'MILD_DIP_EXIT_PARTIAL_SELL_FRACTION',
  'MILD_DIP_EXIT_SECOND_GIVEBACK_PCT',
  'MILD_DIP_QUOTE_PREMIUM_GUARD_PCT',
  'LIVE_BUY_MAX_PRICE_IMPACT_PCT',
  'MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS',
  'MILD_DIP_EXIT_NEVER_ARM_STALE_MAX_MFE_PCT',
  'MILD_DIP_EXIT_MAX_HOLD_MS',
  'MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS',
  'MILD_DIP_EXIT_MIN_MFE_BEFORE_TRAIL_PCT',
  'MILD_DIP_FORCE_ENRICH_FIRST_SEEN_PER_MIN',
  'MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN',
  'MILD_DIP_STREAM',
  'MILD_DIP_STREAM_PRICE_SAMPLE',
  'MILD_DIP_STREAM_PROGRAM_IDS',
  'MILD_DIP_DISCOVER_SOURCES',
  'MILD_DIP_STREAM_IMPULSE_ONLY',
  'VOL_GREEN_STREAM_IMPULSE_ONLY',
  'VOL_GREEN_LEADER_WATCH',
  'VOL_GREEN_LEADER_WATCH_WALLETS',
  'MILD_DIP_LEADER_RESOLVE_MAX_PER_MIN',
  'MILD_DIP_GREEN_SHORT_RED_WINDOW_MS',
  'MILD_DIP_GREEN_FIRST_STRONG_MIN_PC',
  'MILD_DIP_GREEN_TRIPLE_SMALL_MAX_PC',
  'MILD_DIP_EXIT_MFE_BANK',
  'MILD_DIP_MAX_CHASE_PCT',
  'MILD_DIP_GREEN_TRIPLE_ONLY',
  'MILD_DIP_GREEN_TRIPLE_HUGE_MIN_PC',
  'MILD_DIP_GREEN_MIN_MCAP_USD',
  'MILD_DIP_GREEN_IMPULSE_MIN_PC5M_PCT',
  'MILD_DIP_GREEN_LIQUID_MIN_PC5M_PCT',
  'MILD_DIP_GREEN_EARLY_MIN_PC5M_PCT',
  'MILD_DIP_GREEN_ROCKET_MIN_PC5M_PCT',
  'MILD_DIP_GREEN_LIQUID_TAPE_MIN_LIQUIDITY_USD',
  'MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS',
  'MILD_DIP_GREEN_MAX_PAIR_AGE_HOURS',
  'MILD_DIP_MAX_ENRICH',
  'MILD_DIP_PROBE_ENRICH_MAX',
  'MILD_DIP_ENRICH_CONCURRENCY',
  'MILD_DIP_ENRICH_BUDGET_MS',
  'MILD_DIP_SCAN_INTERVAL_MS',
  'DEXSCREENER_GLOBAL_MAX_RPM',
  'DEXSCREENER_MAX_RPM',
  'VOL_GREEN_POSITION_USD',
  'MILD_DIP_POSITION_USD',
  'VOL_GREEN_ENTRY_MODE',
];

describe('bootstrapVolGreenEnv', () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
      delete saved[k];
    }
  });

  function stash(k: string): void {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }

  it('defaults to triple_green-only entry + FxQf + exit widths', () => {
    for (const k of KEYS) stash(k);
    bootstrapVolGreenEnv(process.env);
    expect(process.env.MILD_DIP_ENTRY_MODE).toBe('green_tape');
    expect(process.env.MILD_DIP_WALLET_PUBKEY).toBe(VOL_GREEN_DEFAULT_WALLET_PUBKEY);
    expect(process.env.MILD_DIP_JOURNAL_PATH).toContain('volgreen');
    expect(process.env.MILD_DIP_GREEN_TRIPLE_ONLY).toBe('1');
    expect(process.env.MILD_DIP_GREEN_TRIPLE_HUGE_MIN_PC).toBe('10');
    expect(process.env.MILD_DIP_GREEN_TRIPLE_SMALL_MAX_PC).toBe('18');
    expect(process.env.MILD_DIP_GREEN_IMPULSE_MIN_PC5M_PCT).toBe('0');
    expect(process.env.MILD_DIP_STREAM).toBe('1');
    expect(process.env.MILD_DIP_STREAM_PRICE_SAMPLE).toBe('1');
    expect(process.env.MILD_DIP_STREAM_PROGRAM_IDS).toContain('pAMMBay');
    expect(process.env.MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN).toBe('40');
    expect(process.env.MILD_DIP_STREAM_IMPULSE_ONLY).toBe('1');
    expect(process.env.MILD_DIP_DISCOVER_SOURCES).toBe('stream');
    expect(process.env.VOL_GREEN_LEADER_WATCH).toBe('0');
    expect(process.env.VOL_GREEN_LEADER_WATCH_WALLETS).toContain('7BNaxx');
    expect(process.env.VOL_GREEN_LEADER_WATCH_WALLETS).toContain('8zkgFG');
    expect(process.env.MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS).toBe('0.15');
    expect(process.env.MILD_DIP_GREEN_MIN_MCAP_USD).toBe('12000');
    expect(process.env.MILD_DIP_EXIT_MFE_BANK).toBe('1');
    expect(process.env.MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS).toBe('0');
    expect(process.env.MILD_DIP_MAX_ENRICH).toBe('1');
    expect(process.env.MILD_DIP_PROBE_ENRICH_MAX).toBe('1');
    expect(process.env.MILD_DIP_SCAN_INTERVAL_MS).toBe('1000');
    expect(process.env.MILD_DIP_MAX_CHASE_PCT).toBe('12');
    expect(process.env.DEXSCREENER_GLOBAL_MAX_RPM).toBe('60');
  });

  it('maps VOL_GREEN_POSITION_USD into MILD_DIP_POSITION_USD', () => {
    for (const k of KEYS) stash(k);
    process.env.VOL_GREEN_POSITION_USD = '5';
    bootstrapVolGreenEnv(process.env);
    expect(process.env.MILD_DIP_POSITION_USD).toBe('5');
  });
});
