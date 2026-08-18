import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const ecosystem = createRequire(import.meta.url)('../../ecosystem.config.cjs') as {
  apps: Array<{ name: string; env: Record<string, string> }>;
};
const ecosystemSource = readFileSync(
  new URL('../../ecosystem.config.cjs', import.meta.url),
  'utf8',
);

const mirrorApps = ecosystem.apps.filter((app) =>
  ['mild-dip-mirror', 'mild-dip-mirror2'].includes(app.name),
);

describe('mirror PM2 apps', () => {
  it('keeps mirror definitions in history but excludes both from exported apps', () => {
    expect(mirrorApps).toEqual([]);
    expect(ecosystemSource).toContain("name: 'mild-dip-mirror'");
    expect(ecosystemSource).toContain("name: 'mild-dip-mirror2'");
    expect(ecosystemSource).toContain("dataDir: 'data/milddip-mirror'");
    expect(ecosystemSource).toContain("dataDir: 'data/milddip-mirror2'");
    expect(ecosystemSource).toContain("walletSecret: 'data/live/mcs-wallet.json'");
    expect(ecosystemSource).toContain(
      "walletSecret: 'data/live/copy-8zkg.keypair.json'",
    );
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_POSITION_USD: '30'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MAX_OPEN: '8'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT: '3'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_MIN_LIQUIDITY_USD: '8000'");
    expect(ecosystemSource).toContain("MILD_DIP_MIRROR_LEADER_SELL_ONLY: '1'");
    expect(ecosystemSource).toContain(
      "MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS: '86400000'",
    );
    expect(ecosystemSource).toContain("'mild-dip-mirror',");
    expect(ecosystemSource).toContain("'mild-dip-mirror2',");
  });

  it('keeps both mirror lanes in the Oscar VPS exclusion list', () => {
    const excludedAppsBlock = ecosystemSource.match(
      /const OSCAR_VPS_EXCLUDED_APPS = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1];
    expect(excludedAppsBlock).toContain("'mild-dip-mirror',");
    expect(excludedAppsBlock).toContain("'mild-dip-mirror2',");
  });
});
