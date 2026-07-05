import { describe, expect, it } from 'vitest';
import {
  LERA_DASHBOARD_STRATEGY_ID,
  leraDashboardJsonlPath,
  pickLeraStrategyRowFromApiPayload,
} from '../scripts-tmp/lera-dashboard.js';

describe('lera-dashboard', () => {
  it('defaults journal path under data/lera', () => {
    const prev = process.env.DASHBOARD_LERA_JSONL;
    delete process.env.DASHBOARD_LERA_JSONL;
    delete process.env.LERA_LIVE_JOURNAL_PATH;
    const p = leraDashboardJsonlPath();
    expect(p.replace(/\\/g, '/')).toMatch(/data\/lera\/pt1-lera-live\.jsonl$/);
    if (prev) process.env.DASHBOARD_LERA_JSONL = prev;
  });

  it('picks live-lera row from remote api payload', () => {
    const row = pickLeraStrategyRowFromApiPayload({
      strategies: [
        { strategyId: 'live-oscar', openCount: 1 },
        { strategyId: LERA_DASHBOARD_STRATEGY_ID, openCount: 3, evals1h: 10, passed1h: 2 },
      ],
    });
    expect(row?.strategyId).toBe(LERA_DASHBOARD_STRATEGY_ID);
    expect(row?.openCount).toBe(3);
    expect(row?.evals1h).toBe(10);
  });
});
