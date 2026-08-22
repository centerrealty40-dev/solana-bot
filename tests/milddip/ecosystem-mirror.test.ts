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

describe('mirror PM2 apps', () => {
  it('exports the primary mirror and keeps mirror2 disabled', () => {
    expect(mirrorApps.map((app) => app.name)).toEqual(['mild-dip-mirror']);
    expect(ecosystemSource).toContain("name: 'mild-dip-mirror'");
    expect(ecosystemSource).toContain("name: 'mild-dip-mirror2'");
    expect(ecosystemSource).toContain("dataDir: 'data/milddip-mirror'");
    expect(ecosystemSource).toContain("dataDir: 'data/milddip-mirror2'");
    expect(ecosystemSource).toContain("walletSecret: 'data/live/mcs-wallet.json'");
    expect(ecosystemSource).toContain(
      "walletSecret: 'data/live/copy-8zkg.keypair.json'",
    );
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_POSITION_USD: name === 'mild-dip-mirror' ? '30' : '30'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_USD: '20'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MAX_TIMES: '2'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_NEXT_DISCOUNT_PCT: name === 'mild-dip-mirror' ? '15' : '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LADDER_DUST_USD: '1'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_OPEN: '8'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_QUOTE_MINTS: name === 'mild-dip-mirror' ? '0' : '8'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT: '3'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_REQUIRE_DIP_CANDLE: name === 'mild-dip-mirror' ? '0' : '1'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LEADER_FILL_GRACE_MS: name === 'mild-dip-mirror' ? '60000' : '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_LEADER_SIZE_USD: name === 'mild-dip-mirror' ? '20' : '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MIN_DISCOUNT_PCT: name === 'mild-dip-mirror' ? '10' : '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_MIN_HOLD_MS: name === 'mild-dip-mirror' ? '120000' : '0'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_WINDOWS_MS:");
    expect(ecosystemSource).toContain("'3600000,7200000,10800000,14400000,21600000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS:");
    expect(ecosystemSource).toContain("name === 'mild-dip-mirror' ? '120000' : '900000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_LIQUIDITY_USD: '8000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LEADER_SELL_ONLY: '1'");
    expect(ecosystemSource).toContain(
      "MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS: '86400000'",
    );
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_MCAP_USD: name === 'mild-dip-mirror' ? '120000' : '5000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_PREMIUM_PCT: name === 'mild-dip-mirror' ? '-1' : '2'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_OBSERVE_MS: name === 'mild-dip-mirror' ? '86400000' : '45000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_PAIR_AGE_HOURS: name === 'mild-dip-mirror' ? '4' : '0.5'");
    expect(ecosystemSource).toContain("'mild-dip-mirror2',");
    expect(ecosystemSource).toContain("'mild-dip-mirror2',");
  });

  it('keeps only mirror2 in the Oscar VPS exclusion list', () => {
    const excludedAppsBlock = ecosystemSource.match(
      /const OSCAR_VPS_EXCLUDED_APPS = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1];
    expect(excludedAppsBlock).not.toContain("'mild-dip-mirror',");
    expect(excludedAppsBlock).toContain("'mild-dip-mirror2',");
  });

  it('keeps the disabled dip bot definition for internal consumers only', () => {
    expect(ecosystem.apps.some((app) => app.name === 'mild-dip-bot')).toBe(false);
    expect(ecosystem.allApps.some((app) => app.name === 'mild-dip-bot')).toBe(true);
    expect(ecosystem.apps.some((app) => app.name === 'mild-dip-mirror')).toBe(true);
  });
});
