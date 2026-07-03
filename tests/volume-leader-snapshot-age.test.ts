import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import { resolveVolumeLeaderMinTokenAgeMin } from '../src/papertrader/discovery/snapshot.js';

describe('volume-leader snapshot min token age', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      'PAPER_STRATEGY_ID',
      'PAPER_MIN_TOKEN_AGE_MIN',
      'PAPER_DIP_MIN_AGE_MIN',
      'PAPER_POST_MIN_AGE_MIN',
      'PAPER_VOLUME_LEADER_MIN_TOKEN_AGE_MIN',
      'PAPER_RUNNER_PROBE_ENABLED',
      'PAPER_RUNNER_PROBE_MIN_AGE_MIN',
      'PAPER_RUNNER_PROBE_MAX_AGE_MIN',
    ]) {
      envBackup[k] = process.env[k];
    }
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to 720 min (12h), not global 48h gates', () => {
    process.env.PAPER_MIN_TOKEN_AGE_MIN = '2880';
    process.env.PAPER_DIP_MIN_AGE_MIN = '2880';
    process.env.PAPER_POST_MIN_AGE_MIN = '2880';
    delete process.env.PAPER_VOLUME_LEADER_MIN_TOKEN_AGE_MIN;

    const cfg = loadPaperTraderConfig();
    expect(cfg.globalMinTokenAgeMin).toBe(2880);
    expect(cfg.volumeLeaderMinTokenAgeMin).toBe(720);
    expect(resolveVolumeLeaderMinTokenAgeMin(cfg)).toBe(720);
  });

  it('respects PAPER_VOLUME_LEADER_MIN_TOKEN_AGE_MIN override', () => {
    process.env.PAPER_VOLUME_LEADER_MIN_TOKEN_AGE_MIN = '1440';
    process.env.PAPER_MIN_TOKEN_AGE_MIN = '2880';

    const cfg = loadPaperTraderConfig();
    expect(resolveVolumeLeaderMinTokenAgeMin(cfg)).toBe(1440);
  });

  it('12–48h band passes volume-leader floor while prod gates stay 48h', () => {
    process.env.PAPER_VOLUME_LEADER_MIN_TOKEN_AGE_MIN = '720';
    process.env.PAPER_MIN_TOKEN_AGE_MIN = '2880';
    process.env.PAPER_RUNNER_PROBE_ENABLED = '1';
    process.env.PAPER_RUNNER_PROBE_MIN_AGE_MIN = '720';
    process.env.PAPER_RUNNER_PROBE_MAX_AGE_MIN = '2880';

    const cfg = loadPaperTraderConfig();
    const floor = resolveVolumeLeaderMinTokenAgeMin(cfg);
    const ages = [700, 720, 1500, 2879];
    expect(ages.filter((a) => a >= floor)).toEqual([720, 1500, 2879]);
    expect(ages.filter((a) => a >= cfg.globalMinTokenAgeMin)).toEqual([]);
  });
});
