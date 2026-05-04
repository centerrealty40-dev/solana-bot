import { describe, expect, it } from 'vitest';
import {
  matchLaneDex,
  basePagesForJobType,
  pagesForLaneJob,
  geckoPathForJobType,
  geckoDexPoolSlugsForLane,
  fireSlotKey,
  isMinuteAlignedForJob,
  computeOrchestratorJobRpcCap,
} from '../scripts-tmp/wallet-orchestrator-lib.mjs';

describe('wallet-orchestrator-lib', () => {
  it('matchLaneDex raydium', () => {
    const ray = { relationships: { dex: { data: { id: 'raydium' } } }, attributes: {} };
    expect(matchLaneDex(ray, 'raydium')).toBe(true);
    expect(matchLaneDex(ray, 'orca')).toBe(false);
  });

  it('pagesForLaneJob pumpswap bonus', () => {
    expect(pagesForLaneJob('new_pools', 'pumpswap', 2)).toBe(4);
    expect(pagesForLaneJob('new_pools', 'raydium', 2)).toBe(2);
  });

  it('isMinuteAlignedForJob new_pools after phase same hour', () => {
    const ok = new Date(Date.UTC(2026, 4, 4, 14, 18, 0));
    expect(isMinuteAlignedForJob({ laneIdx: 2, jobType: 'new_pools', now: ok, dailyDeepHourUtc: 3 })).toBe(true);
    const tooEarly = new Date(Date.UTC(2026, 4, 4, 14, 17, 0));
    expect(isMinuteAlignedForJob({ laneIdx: 2, jobType: 'new_pools', now: tooEarly, dailyDeepHourUtc: 3 })).toBe(false);
    const catchUp = new Date(Date.UTC(2026, 4, 4, 14, 45, 0));
    expect(isMinuteAlignedForJob({ laneIdx: 2, jobType: 'new_pools', now: catchUp, dailyDeepHourUtc: 3 })).toBe(true);
  });

  it('fireSlotKey', () => {
    expect(fireSlotKey('2026-05-04', 'new_pools', 'orca', 7)).toContain('h7');
  });

  it('computeOrchestratorJobRpcCap lane vs global', () => {
    expect(
      computeOrchestratorJobRpcCap('lane', {
        maxPerJob: 1200,
        effectiveDayCapRemaining: 500,
        laneRemaining: 10_000,
      }),
    ).toBe(500);
    expect(
      computeOrchestratorJobRpcCap('lane', {
        maxPerJob: 1200,
        effectiveDayCapRemaining: 500,
        laneRemaining: 100,
      }),
    ).toBe(100);
    expect(
      computeOrchestratorJobRpcCap('global', {
        maxPerJob: 1200,
        effectiveDayCapRemaining: 500,
        laneRemaining: 0,
      }),
    ).toBe(500);
  });

  it('geckoPathForJobType', () => {
    expect(geckoPathForJobType('trending_pools')).toBe('trending_pools');
    expect(basePagesForJobType('daily_deep')).toBe(8);
  });

  it('geckoDexPoolSlugsForLane', () => {
    expect(geckoDexPoolSlugsForLane('pumpswap')).toBeNull();
    expect(geckoDexPoolSlugsForLane('meteora')).toEqual(['meteora', 'meteora-dbc', 'meteora-damm-v2']);
    expect(geckoDexPoolSlugsForLane('orca')).toEqual(['orca']);
    expect(geckoDexPoolSlugsForLane('moonshot')).toEqual(['moonshot']);
    expect(geckoDexPoolSlugsForLane('raydium')?.length).toBe(3);
  });
});
