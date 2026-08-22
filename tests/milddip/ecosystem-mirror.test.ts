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

const mirrorApps = ecosystem.apps.filter((app) =>
  ['mild-dip-mirror', 'mild-dip-mirror2'].includes(app.name),
);
const mirror = mirrorApps.find((app) => app.name === 'mild-dip-mirror');
const mirror2 = mirrorApps.find((app) => app.name === 'mild-dip-mirror2');

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
    expect(mirror2?.env.MILD_DIP_MIRROR_MAX_ENTRY_PC5M_PCT).toBe('0');
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
      'MILD_DIP_MIRROR_MIN_LIQUIDITY_USD',
      'MILD_DIP_MIRROR_MIN_PAIR_AGE_HOURS',
      'MILD_DIP_MIRROR_MIN_MCAP_USD',
      'MILD_DIP_MIRROR_MAX_OPEN',
      'MILD_DIP_MIRROR_MAX_QUOTE_MINTS',
      'MILD_DIP_MIRROR_TICK_INTERVAL_MS',
      'MILD_DIP_MIRROR_STRUCTURAL_GAP_MS',
      'MILD_DIP_MIRROR_MAX_PREMIUM_PCT',
      'MILD_DIP_MIRROR_RETRY_WHILE_LEADER_HOLDS',
      'MILD_DIP_MIRROR_AVERAGE_ENABLED',
      'MILD_DIP_MIRROR_AVERAGE_WINDOWS_MS',
      'MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS',
      'MILD_DIP_MIRROR_AVERAGE_MIN_DISCOUNT_PCT',
      'MILD_DIP_MIRROR_AVERAGE_NEXT_DISCOUNT_PCT',
      'MILD_DIP_MIRROR_AVERAGE_MIN_HOLD_MS',
    ]) {
      expect(mirror?.env[key]).toBe(mirror2?.env[key]);
    }
    expect(mirror?.env.MILD_DIP_MIRROR_QUOTE_INTERVAL_MS).toBe('1000');
    expect(mirror?.env.MILD_DIP_MIRROR_TICK_INTERVAL_MS).toBe('1000');
    expect(mirror?.env.MILD_DIP_MIRROR_QUOTE_MAX_AGE_MS).toBe('4000');
    expect(mirror?.env.MILD_DIP_MIRROR_STRUCTURAL_GAP_MS).toBe('2000');
    expect(mirror?.env.MILD_DIP_MIRROR_MAX_QUOTE_MINTS).toBe('0');
    expect(ecosystemSource).toContain("name: 'mild-dip-mirror'");
    expect(ecosystemSource).toContain("name: 'mild-dip-mirror2'");
    expect(ecosystemSource).toContain("dataDir: 'data/milddip-mirror'");
    expect(ecosystemSource).toContain("dataDir: 'data/milddip-mirror2'");
    expect(ecosystemSource).toContain("walletSecret: 'data/live/mcs-wallet.json'");
    expect(ecosystemSource).toContain(
      "walletSecret: 'data/live/copy-8zkg.keypair.json'",
    );
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_POSITION_USD: '30'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_USD: '20'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MAX_TIMES: '2'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_NEXT_DISCOUNT_PCT: '15'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LADDER_DUST_USD: '1'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_OPEN: '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_QUOTE_MINTS: '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT: '3'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_REQUIRE_DIP_CANDLE: '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LEADER_FILL_GRACE_MS: '60000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_LEADER_SIZE_USD: '20'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MIN_DISCOUNT_PCT: '15'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MIN_HOLD_MS: '120000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_WINDOWS_MS:");
    expect(ecosystemSource).toContain("'3600000,7200000,10800000,14400000,21600000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS:");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS: '120000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_LIQUIDITY_USD: '4000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LEADER_SELL_ONLY: '1'");
    expect(ecosystemSource).toContain(
      "MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS: '86400000'",
    );
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_MCAP_USD: '50000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_PREMIUM_PCT: '-1'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_OBSERVE_MS: '86400000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_PAIR_AGE_HOURS: '1'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_ENTRY_PC5M_PCT: '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_ENTRY_GRACE_MS: '60000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_ENTRY_GRACE_MAX_PREMIUM_PCT: '1'");
    expect(mirror?.env.MILD_DIP_MIRROR_OWN_EXIT_ENABLED).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_EXIT_ARM_PCT).toBe('2');
    expect(mirror?.env.MILD_DIP_MIRROR_EXIT_TRAIL_PCT).toBe('0');
    expect(mirror?.env.MILD_DIP_MIRROR_OWN_EXIT_TIME_STOP_MS).toBe('0');
    expect(mirror2?.env.MILD_DIP_MIRROR_OWN_EXIT_ENABLED).toBe('1');
    expect(mirror2?.env.MILD_DIP_MIRROR_EXIT_ARM_PCT).toBe('5');
    expect(mirror2?.env.MILD_DIP_MIRROR_EXIT_TRAIL_PCT).toBe('3');
    expect(mirror2?.env.MILD_DIP_MIRROR_OWN_EXIT_TIME_STOP_MS).toBe('3600000');
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_OWN_EXIT_ENABLED: ownExitEnabled ? '1' : '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_OWN_EXIT_TIME_STOP_MS: ownExitTimeStopMs");
    expect(ecosystemSource).toContain("'mild-dip-mirror2',");
    expect(ecosystemSource).toContain("'mild-dip-mirror2',");
  });

  it('does not exclude either mirror from the Oscar VPS export', () => {
    const excludedAppsBlock = ecosystemSource.match(
      /const OSCAR_VPS_EXCLUDED_APPS = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1];
    expect(excludedAppsBlock).not.toContain("'mild-dip-mirror',");
    expect(excludedAppsBlock).not.toContain("'mild-dip-mirror2',");
  });

  it('keeps the disabled dip bot definition for internal consumers only', () => {
    expect(ecosystem.apps.some((app) => app.name === 'mild-dip-bot')).toBe(false);
    expect(ecosystem.allApps.some((app) => app.name === 'mild-dip-bot')).toBe(true);
    expect(ecosystem.apps.some((app) => app.name === 'mild-dip-mirror')).toBe(true);
    expect(ecosystem.apps.some((app) => app.name === 'mild-dip-mirror2')).toBe(true);
  });
});
