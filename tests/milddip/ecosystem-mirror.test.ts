import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const ecosystem = createRequire(import.meta.url)('../../ecosystem.config.cjs') as {
  apps: Array<{ name: string; env: Record<string, string> }>;
  allApps: Array<{ name: string; env: Record<string, string> }>;
};
const ecosystemSource = readFileSync(
  new URL('../../ecosystem.config.cjs', import.meta.url),
  'utf8',
);

const mirrorApps = ecosystem.allApps.filter((app) =>
  ['mild-dip-mirror', 'mild-dip-mirror2'].includes(app.name),
);
const mirror = mirrorApps.find((app) => app.name === 'mild-dip-mirror');
const mirror2 = mirrorApps.find((app) => app.name === 'mild-dip-mirror2');
const mildDip = ecosystem.allApps.find((app) => app.name === 'mild-dip-bot');

describe('mirror PM2 apps', () => {
  it('exports both mirror processes with independent leaders and shared strategy', () => {
    expect(mirrorApps.map((app) => app.name)).toEqual([
      'mild-dip-mirror',
      'mild-dip-mirror2',
    ]);
    expect(mirror).toBeDefined();
    expect(mirror2).toBeDefined();
    expect(mirror?.env.MILD_DIP_MIRROR_LEADERS).toBe(
      '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
    );
    expect(mirror2?.env.MILD_DIP_MIRROR_LEADERS).toBe(
      '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5',
    );
    expect(mirror?.env.MILD_DIP_MIRROR_MAX_ENTRY_PC5M_PCT).toBe('1000');
    expect(mirror2?.env.MILD_DIP_MIRROR_MAX_ENTRY_PC5M_PCT).toBe('1000');
    expect(mirror?.env.MILD_DIP_MIRROR_GREEN_INSTANT_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_GREEN_INSTANT_ENABLED).toBe('0');
    expect(mirror?.env.MILD_DIP_WALLET_PUBKEY).not.toBe(
      mirror2?.env.MILD_DIP_WALLET_PUBKEY,
    );
    for (const key of [
      'MILD_DIP_MIRROR_GREEN_COPY_ENABLED',
      'MILD_DIP_MIRROR_REQUIRE_DIP_CANDLE',
      'MILD_DIP_MIRROR_OBSERVE_MS',
      'MILD_DIP_MIRROR_LEADER_FILL_GRACE_MS',
      'MILD_DIP_MIRROR_MIN_LEADER_SIZE_USD',
      'MILD_DIP_MIRROR_QUOTE_INTERVAL_MS',
      'MILD_DIP_MIRROR_QUOTE_MAX_AGE_MS',
      'MILD_DIP_MIRROR_MAX_OPEN',
      'MILD_DIP_MIRROR_MAX_QUOTE_MINTS',
      'MILD_DIP_MIRROR_FUNDING_PARK_ENABLED',
      'MILD_DIP_MIRROR_FUNDING_PARK_RETRY_MS',
      'MILD_DIP_MIRROR_FUNDING_PARK_MAX',
      'MILD_DIP_MIRROR_TIER_PARK_ENABLED',
      'MILD_DIP_MIRROR_TIER_MAX_OPEN',
      'MILD_DIP_MIRROR_TICK_INTERVAL_MS',
      'MILD_DIP_MIRROR_STRUCTURAL_GAP_MS',
      'MILD_DIP_MIRROR_KNIFE_WAIT_ENABLED',
      'MILD_DIP_MIRROR_KNIFE_WAIT_PC5M_PCT',
      'MILD_DIP_MIRROR_KNIFE_WAIT_DISCOUNT_PCT',
      'MILD_DIP_MIRROR_KNIFE_WAIT_WINDOW_MS',
      'MILD_DIP_MIRROR_KNIFE_WAIT_QUOTE_SLOTS',
      'MILD_DIP_MAX_CHASE_PCT',
      'MILD_DIP_MIRROR_RETRY_WHILE_LEADER_HOLDS',
      'MILD_DIP_MIRROR_AVERAGE_ENABLED',
      'MILD_DIP_MIRROR_AVERAGE_WINDOWS_MS',
      'MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS',
      'MILD_DIP_MIRROR_AVERAGE_NEXT_DISCOUNT_PCT',
      'MILD_DIP_MIRROR_AVERAGE_MIN_HOLD_MS',
      'MILD_DIP_DUST_BURN_ENABLED',
      'MILD_DIP_DUST_BURN_MAX_USD',
      'MILD_DIP_DUST_BURN_MAX_PER_PASS',
      'MILD_DIP_DUST_BURN_MIN_AGE_MS',
      'MILD_DIP_DUST_BURN_SETTLE_MS',
      'MILD_DIP_DUST_BURN_INTERVAL_MS',
    ]) {
      expect(mirror?.env[key]).toBe(mirror2?.env[key]);
    }
    expect(mirror?.env.MILD_DIP_MIRROR_QUOTE_INTERVAL_MS).toBe('1000');
    expect(mirror?.env.MILD_DIP_MIRROR_STRUCTURAL_GATES_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_MIN_LIQUIDITY_USD).toBe('12000');
    expect(mirror?.env.MILD_DIP_MIRROR_MIN_PAIR_AGE_HOURS).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_MIN_MCAP_USD).toBe('50000');
    expect(mirror?.env.MILD_DIP_MIRROR_MAX_VOL5M_TO_LIQ).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_MAX_VOL5M_TO_LIQ).toBe('2');
    expect(mirror?.env.MILD_DIP_MIRROR_STALE_QUOTE_INTERVAL_MS).toBe('5000');
    expect(mirror?.env.MILD_DIP_MIRROR_MAX_QUOTE_MINTS).toBe('8');
    expect(mirror2?.env.MILD_DIP_MIRROR_STALE_QUOTE_INTERVAL_MS).toBe('5000');
    expect(mirror2?.env.MILD_DIP_MIRROR_MAX_QUOTE_MINTS).toBe('8');
    expect(mirror?.env.MILD_DIP_MIRROR_FUNDING_PARK_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_FUNDING_PARK_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_FUNDING_PARK_RETRY_MS).toBe('30000');
    expect(mirror2?.env.MILD_DIP_MIRROR_FUNDING_PARK_RETRY_MS).toBe('30000');
    expect(mirror?.env.MILD_DIP_MIRROR_FUNDING_PARK_MAX).toBe('10');
    expect(mirror2?.env.MILD_DIP_MIRROR_FUNDING_PARK_MAX).toBe('10');
    expect(mirror?.env.MILD_DIP_MIRROR_TIER_PARK_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_TIER_PARK_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_TIER_MAX_OPEN).toBe('12');
    expect(mirror2?.env.MILD_DIP_MIRROR_TIER_MAX_OPEN).toBe('12');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_LIQ_COEF).toBe('0.008749');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_LIQ_EXP).toBe('0.866');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_MIN_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_MAX_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_MAX_POOL_SHARE_PCT).toBe('0.15');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_MIN_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_MAX_USD).toBe('50');
    expect(mirror2?.env.MILD_DIP_MIRROR_SIZE_LIQ_COEF).toBe('0.001094');
    expect(mirror2?.env.MILD_DIP_MIRROR_SIZE_LIQ_EXP).toBe('0.866');
    expect(mirror2?.env.MILD_DIP_MIRROR_SIZE_MIN_USD).toBe('10');
    expect(mirror2?.env.MILD_DIP_MIRROR_SIZE_MAX_USD).toBe('30');
    expect(mirror2?.env.MILD_DIP_MIRROR_SIZE_MAX_POOL_SHARE_PCT).toBe('0.15');
    expect(mirror?.env.MILD_DIP_MIRROR_TICK_INTERVAL_MS).toBe('1000');
    expect(mirror?.env.MILD_DIP_MIRROR_QUOTE_MAX_AGE_MS).toBe('4000');
    expect(mirror?.env.MILD_DIP_MIRROR_STRUCTURAL_GAP_MS).toBe('2000');
    expect(mirror?.env.MILD_DIP_MIRROR_KNIFE_WAIT_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_KNIFE_WAIT_PC5M_PCT).toBe('-10');
    expect(mirror?.env.MILD_DIP_MIRROR_KNIFE_WAIT_DISCOUNT_PCT).toBe('2');
    expect(mirror2?.env.MILD_DIP_MIRROR_KNIFE_WAIT_DISCOUNT_PCT).toBe('2');
    expect(mirror?.env.MILD_DIP_MIRROR_KNIFE_WAIT_WINDOW_MS).toBe('600000');
    expect(mirror?.env.MILD_DIP_MIRROR_KNIFE_WAIT_QUOTE_SLOTS).toBe('3');
    expect(mirror?.env.MILD_DIP_MIRROR_MAX_QUOTE_MINTS).toBe('8');
    expect(ecosystemSource).toContain("name: 'mild-dip-mirror'");
    expect(ecosystemSource).toContain("name: 'mild-dip-mirror2'");
    expect(ecosystemSource).toContain("dataDir: 'data/milddip-mirror'");
    expect(ecosystemSource).toContain("dataDir: 'data/milddip-mirror2'");
    expect(ecosystemSource).toContain("walletSecret: 'data/live/mcs-wallet.json'");
    expect(ecosystemSource).toContain(
      "walletSecret: 'data/live/copy-8zkg.keypair.json'",
    );
    expect(mirror?.env.MILD_DIP_MIRROR_AVERAGE_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_AVERAGE_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_LOSS_CAP_USD).toBe('150');
    expect(mirror2?.env.MILD_DIP_MIRROR_LOSS_CAP_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_FIRST_TOUCH_POSITION_USD).toBe('0');
    expect(mirror2?.env.MILD_DIP_FIRST_TOUCH_POSITION_USD).toBe('10');
    expect(mildDip?.env.MILD_DIP_FIRST_TOUCH_POSITION_USD).toBe('10');
    expect(mirror?.env.MILD_DIP_MIRROR_LOSS_CAP_FLATTEN).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_LOSS_CAP_FLATTEN).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_LOSS_CAP_DAILY_RESET).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_LOSS_CAP_RESET_TZ_OFFSET_MIN).toBe('180');
    expect(mirror2?.env.MILD_DIP_MIRROR_LOSS_CAP_DAILY_RESET).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_AVERAGE_MAX_TIMES).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_AVERAGE_MAX_TIMES).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_AVERAGE_TOLERANCE_PCT).toBe('2');
    expect(mirror2?.env.MILD_DIP_MIRROR_AVERAGE_TOLERANCE_PCT).toBe('2');
    expect(mirror?.env.MILD_DIP_MIRROR_AVERAGE_DEEP_DISCOUNT_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_AVERAGE_DEEP_DISCOUNT_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_AVERAGE_MAX_PRICE_IMPACT_PCT).toBe('5');
    expect(mirror2?.env.MILD_DIP_MIRROR_AVERAGE_MAX_PRICE_IMPACT_PCT).toBe('5');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_LEADERS).toBe(
      '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5',
    );
    expect(mirror2?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_LEADERS).toBe(
      '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
    );
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_USD).toBe('50');
    expect(mirror2?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_USD).toBe('10');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_STEPS_ENABLED).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_STEPS_ENABLED).toBe('1');
    for (const key of [
      'MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_AGE_MS',
      'MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_START_FRACTION',
      'MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_FULL_DISCOUNT_PCT',
      'MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_TOTAL_FRACTION',
      'MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_LEADER_SIZE_USD',
      'MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_STEP_USD',
    ]) {
      expect(mirror?.env[key]).toBe(mirror2?.env[key]);
    }
    expect(mirror?.env.MILD_DIP_MIRROR_MIN_VOL5M_USD).toBe('500');
    expect(mirror2?.env.MILD_DIP_MIRROR_MIN_VOL5M_USD).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_AVERAGE_MIN_DISCOUNT_PCT).toBe('50');
    expect(mirror2?.env.MILD_DIP_MIRROR_AVERAGE_MIN_DISCOUNT_PCT).toBe('30');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_DISCOUNT_PCT).toBe('50');
    expect(mirror2?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_DISCOUNT_PCT).toBe('15');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_START_FRACTION).toBe('0.3');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_FULL_DISCOUNT_PCT).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_TOTAL_FRACTION).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_TIMES).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_TIMES).toBe('3');
    expect(mirror?.env.MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_STEP_USD).toBe('3');
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MAX_TIMES: '1'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_NEXT_DISCOUNT_PCT: '15'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LADDER_DUST_USD: '1'");
    expect(mirror?.env.MILD_DIP_MIRROR_LADDER_STEP_PCT).toBe('8');
    expect(mirror?.env.MILD_DIP_MIRROR_LADDER_STEP_AFTER_AVG_PCT).toBe('16');
    expect(mirror?.env.MILD_DIP_MIRROR_LADDER_SELL_FRACTION).toBe('0.5');
    expect(mirror?.env.MILD_DIP_MIRROR_LADDER_ENABLED).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_LADDER_MAX_RUNGS).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_LADDER_STEP_PCT).toBe('5');
    expect(mirror2?.env.MILD_DIP_MIRROR_LADDER_STEP_AFTER_AVG_PCT).toBe('10');
    expect(mirror2?.env.MILD_DIP_MIRROR_LADDER_SELL_FRACTION).toBe('0.2');
    expect(mirror2?.env.MILD_DIP_MIRROR_LADDER_ENABLED).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_LADDER_MAX_RUNGS).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_LADDER_MIN_SETTLE_SEC).toBe('45');
    expect(mirror2?.env.MILD_DIP_MIRROR_LADDER_MIN_SETTLE_SEC).toBe('45');
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LADDER_MIN_SETTLE_SEC: '45'");
    expect(mirror?.env.MILD_DIP_MIRROR_POSITION_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_STRUCTURAL_GATES_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_FRACTION).toBe('0.25');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_MIN_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_MAX_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_SMALL_MCAP_USD).toBe('40000');
    expect(mirror?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_SMALL_CLIP_USD).toBe('50');
    expect(mirror2?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_SMALL_MCAP_USD).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_SIZE_FROM_LEADER_SMALL_CLIP_USD).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_AVERAGE_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_TIER_ENABLED).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_TIER_IGNORE_FLOORS).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_TIER_POSITION_USD).toBe('10');
    expect(mirror?.env.MILD_DIP_MIRROR_TIER_MAX_OPEN).toBe('12');
    expect(mirror?.env.MILD_DIP_MIRROR_LOSS_CAP_USD).toBe('150');
    expect(mirror?.env.MILD_DIP_MIRROR_DUST_CLOSE_USD).toBe('2');
    expect(mirror?.env.MILD_DIP_MIRROR_FIRST_CLIP_LEGS).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_FIRST_CLIP_LEGS).toBe('2');
    expect(mirror2?.env.MILD_DIP_MIRROR_POSITION_USD).toBe('10');
    expect(mirror2?.env.MILD_DIP_MIRROR_AVERAGE_USD).toBe('7');
    expect(mirror2?.env.MILD_DIP_MIRROR_TIER_ENABLED).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_TIER_IGNORE_FLOORS).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_LOSS_CAP_USD).toBe('50');
    expect(mirror2?.env.MILD_DIP_MIRROR_DUST_CLOSE_USD).toBe('3');
    expect(mirror?.env.MILD_DIP_DUST_BURN_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_DUST_BURN_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_DUST_BURN_MAX_USD).toBe('0.5');
    expect(mirror2?.env.MILD_DIP_DUST_BURN_MAX_USD).toBe('0.5');
    expect(mirror?.env.MILD_DIP_DUST_BURN_MAX_PER_PASS).toBe('20');
    expect(mirror2?.env.MILD_DIP_DUST_BURN_MAX_PER_PASS).toBe('20');
    expect(mirror?.env.MILD_DIP_DUST_BURN_MIN_AGE_MS).toBe('21600000');
    expect(mirror2?.env.MILD_DIP_DUST_BURN_MIN_AGE_MS).toBe('21600000');
    expect(mirror?.env.MILD_DIP_DUST_BURN_SETTLE_MS).toBe('600000');
    expect(mirror2?.env.MILD_DIP_DUST_BURN_SETTLE_MS).toBe('600000');
    expect(mirror?.env.MILD_DIP_DUST_BURN_INTERVAL_MS).toBe('21600000');
    expect(mirror2?.env.MILD_DIP_DUST_BURN_INTERVAL_MS).toBe('21600000');
    expect(mirror?.env.MILD_DIP_DATA_MIN_FREE_BYTES).toBe('8589934592');
    expect(mirror2?.env.MILD_DIP_DATA_MIN_FREE_BYTES).toBe('8589934592');
    expect(mirror?.env.MILD_DIP_DATA_MIN_FREE_PCT).toBe('10');
    expect(mirror2?.env.MILD_DIP_DATA_MIN_FREE_PCT).toBe('10');
    expect(mirror?.env.MILD_DIP_DATA_EMERGENCY_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_DATA_EMERGENCY_ENABLED).toBe('1');
    expect(mirror?.env.MILD_DIP_DATA_EMERGENCY_KEEP_DAYS).toBe('2');
    expect(mirror2?.env.MILD_DIP_DATA_EMERGENCY_KEEP_DAYS).toBe('2');
    expect(ecosystemSource).toContain("MILD_DIP_DUST_BURN_ENABLED: '1'");
    expect(ecosystemSource).toContain("MILD_DIP_DATA_MIN_FREE_BYTES: '8589934592'");
    expect(ecosystemSource).toContain("MILD_DIP_DATA_MIN_FREE_PCT: '10'");
    expect(ecosystemSource).toContain("MILD_DIP_DATA_EMERGENCY_ENABLED: '1'");
    expect(ecosystemSource).toContain("MILD_DIP_DATA_EMERGENCY_KEEP_DAYS: '2'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_OPEN: '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_QUOTE_MINTS: '8'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT: '3'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_REQUIRE_DIP_CANDLE: '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LEADER_FILL_GRACE_MS: '60000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_LEADER_SIZE_USD: '20'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MIN_DISCOUNT_PCT: averageMinDiscountPct");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MIN_HOLD_MS: '120000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_WINDOWS_MS:");
    expect(ecosystemSource).toContain("'3600000,7200000,10800000,14400000,21600000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS:");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS: '120000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_LIQUIDITY_USD: '4000'");
    expect(mirror?.env.MILD_DIP_MIRROR_MIN_LIQUIDITY_USD).toBe('12000');
    expect(mirror2?.env.MILD_DIP_MIRROR_MIN_LIQUIDITY_USD).toBe('40000');
    expect(mirror?.env.MILD_DIP_MIRROR_MIN_PC1H_PCT).toBe('-1000');
    expect(mirror?.env.MILD_DIP_MIRROR_MIN_PC5M_PCT).toBe('-1000');
    expect(mirror2?.env.MILD_DIP_MIRROR_MIN_PC1H_PCT).toBe('-1000');
    expect(mirror2?.env.MILD_DIP_MIRROR_MIN_PC5M_PCT).toBe('-10');
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LEADER_SELL_ONLY: '1'");
    expect(mirror?.env.MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT).toBe('2');
    expect(mirror2?.env.MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT).toBe('2');
    expect(ecosystemSource).toContain("MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT: '2'");
    expect(ecosystemSource).toContain(
      "MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_INTERVAL_MS: '30000'",
    );
    expect(ecosystemSource).toContain(
      "MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_WINDOW_MS: '3600000'",
    );
    expect(ecosystemSource).toContain(
      "MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_TAIL_BYTES: '2097152'",
    );
    expect(ecosystemSource).toContain(
      "MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS: '86400000'",
    );
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_MCAP_USD: '50000'");
    expect(mirror2?.env.MILD_DIP_MIRROR_MAX_PREMIUM_PCT).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_MAX_PREMIUM_PCT).toBe('-0.5');
    expect(mirror?.env.MILD_DIP_MIRROR_GREEN_MAX_PREMIUM_PCT).toBe('10');
    expect(mirror2?.env.MILD_DIP_MIRROR_GREEN_MAX_PREMIUM_PCT).toBe('-1000');
    expect(mirror?.env.MILD_DIP_MIRROR_EXEC_START_SLIPPAGE_BPS).toBe('400');
    expect(mirror2?.env.MILD_DIP_MIRROR_EXEC_START_SLIPPAGE_BPS).toBe('0');
    expect(mirror?.env.MILD_DIP_MAX_CHASE_PCT).toBe('6');
    expect(mirror2?.env.MILD_DIP_MAX_CHASE_PCT).toBe('6');
    expect(ecosystemSource).toContain("maxPremiumPct = '1'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_OBSERVE_MS: '86400000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_PAIR_AGE_HOURS: '1'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_ENTRY_PC5M_PCT: '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_ENTRY_GRACE_MS: '60000'");
    expect(mirror?.env.MILD_DIP_MIRROR_ENTRY_GRACE_MAX_PREMIUM_PCT).toBe('-0.5');
    expect(mirror2?.env.MILD_DIP_MIRROR_ENTRY_GRACE_MAX_PREMIUM_PCT).toBe('1');
    expect(mirror?.env.MILD_DIP_MIRROR_OWN_EXIT_ENABLED).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_EXIT_ARM_PCT).toBe('2');
    expect(mirror?.env.MILD_DIP_MIRROR_EXIT_TRAIL_PCT).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_OWN_EXIT_TIME_STOP_MS).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_OWN_EXIT_ENABLED).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_EXIT_ARM_PCT).toBe('2');
    expect(mirror2?.env.MILD_DIP_MIRROR_EXIT_TRAIL_PCT).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_OWN_EXIT_TIME_STOP_MS).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_POSITION_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_AVERAGE_USD).toBe('50');
    expect(mirror?.env.MILD_DIP_MIRROR_OWN_STRUCTURAL_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_OWN_STRUCTURAL_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_POSITION_USD).toBe('10');
    expect(mirror2?.env.MILD_DIP_MIRROR_AVERAGE_USD).toBe('7');
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_OWN_EXIT_ENABLED: ownExitEnabled ? '1' : '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_OWN_EXIT_TIME_STOP_MS: ownExitTimeStopMs");
    expect(ecosystemSource).toContain("'mild-dip-mirror2',");
    expect(ecosystemSource).toContain("'mild-dip-mirror2',");
  });

  it('keeps mirror1 in the Oscar VPS export and excludes the stopped mirror2', () => {
    const excludedAppsBlock = ecosystemSource.match(
      /const OSCAR_VPS_EXCLUDED_APPS = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1];
    expect(excludedAppsBlock).not.toContain("'mild-dip-mirror',");
    expect(excludedAppsBlock).toContain("'mild-dip-mirror2',");
  });

  it('keeps the watchdog off the stopped mirror2', () => {
    const watchdog = ecosystem.apps.find((app) => app.name === 'mild-dip-watchdog');
    expect(watchdog?.env.MILD_DIP_WATCHDOG_INSTANCES).toBe(
      'mild-dip-mirror:data/milddip-mirror',
    );
  });

  it('keeps the disabled dip bot definition for internal consumers only', () => {
    expect(ecosystem.apps.some((app) => app.name === 'mild-dip-bot')).toBe(false);
    expect(ecosystem.allApps.some((app) => app.name === 'mild-dip-bot')).toBe(true);
    expect(ecosystem.apps.some((app) => app.name === 'mild-dip-mirror')).toBe(true);
    expect(ecosystem.apps.some((app) => app.name === 'mild-dip-mirror2')).toBe(false);
    expect(ecosystem.allApps.some((app) => app.name === 'mild-dip-mirror2')).toBe(true);
  });
});
