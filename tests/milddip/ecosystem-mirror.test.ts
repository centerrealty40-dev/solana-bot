import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const ecosystem = createRequire(import.meta.url)('../../ecosystem.config.cjs') as {
  apps: Array<{ name: string; env: Record<string, string> }>;
};

const mirrorApps = ecosystem.apps.filter((app) =>
  ['mild-dip-mirror', 'mild-dip-mirror2'].includes(app.name),
);

describe('mirror PM2 apps', () => {
  it('exports two isolated mirror processes with shared read-only leader inputs', () => {
    expect(mirrorApps.map((app) => app.name)).toEqual([
      'mild-dip-mirror',
      'mild-dip-mirror2',
    ]);
    const [first, second] = mirrorApps;
    expect(first.env.MILD_DIP_WALLET_PUBKEY).not.toBe(second.env.MILD_DIP_WALLET_PUBKEY);
    expect(first.env.MILD_DIP_WALLET_SECRET).not.toBe(second.env.MILD_DIP_WALLET_SECRET);
    expect(first.env.MILD_DIP_MIRROR_LEADERS).not.toBe(second.env.MILD_DIP_MIRROR_LEADERS);
    for (const key of [
      'MILD_DIP_JOURNAL_PATH',
      'MILD_DIP_TRADES_PATH',
      'MILD_DIP_STATE_PATH',
      'MILD_DIP_HOT_MINTS_PATH',
      'MILD_DIP_PRICE_RING_PATH',
    ]) {
      expect(first.env[key]).not.toBe(second.env[key]);
    }
    expect(first.env.MILD_DIP_LEADER_SEED_PATH).toBe(second.env.MILD_DIP_LEADER_SEED_PATH);
    expect(first.env.MILD_DIP_MIRROR_LEADER_SELL_TRADES_PATH).toBe(
      second.env.MILD_DIP_MIRROR_LEADER_SELL_TRADES_PATH,
    );
    expect(first.env.MILD_DIP_MIRROR_POSITION_USD).toBe('50');
    expect(second.env.MILD_DIP_MIRROR_POSITION_USD).toBe('50');
    expect(first.env.MILD_DIP_MIRROR_MAX_OPEN).toBe('8');
    expect(second.env.MILD_DIP_MIRROR_MAX_OPEN).toBe('8');
    expect(first.env.MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT).toBe('3');
    expect(second.env.MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT).toBe('3');
    expect(first.env.MILD_DIP_MIRROR_MIN_LIQUIDITY_USD).toBe('8000');
    expect(second.env.MILD_DIP_MIRROR_MIN_LIQUIDITY_USD).toBe('8000');
    expect(first.env.MILD_DIP_MIRROR_LEADER_SELL_ONLY).toBe('1');
    expect(second.env.MILD_DIP_MIRROR_LEADER_SELL_ONLY).toBe('1');
    expect(first.env.MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS).toBe('86400000');
    expect(second.env.MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS).toBe('86400000');
  });

  it('keeps the second mirror out of the legacy excluded app list', () => {
    expect(mirrorApps.some((app) => app.name === 'mild-dip-mirror2')).toBe(true);
  });
});
