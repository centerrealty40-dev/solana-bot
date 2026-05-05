import { describe, it, expect } from 'vitest';
import { classifyRegime } from '../src/papertrader/pricing/tp-regime.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';

const base = {
  tpRegimeMinSamples: 3,
  tpRegimeDownNetPct: -15,
  tpRegimeUpNetPct: 5,
  tpRegimeSidewaysAbsNetPct: 12,
  tpRegimeSidewaysMinRangePct: 15,
} as const satisfies Pick<
  PaperTraderConfig,
  | 'tpRegimeMinSamples'
  | 'tpRegimeDownNetPct'
  | 'tpRegimeUpNetPct'
  | 'tpRegimeSidewaysAbsNetPct'
  | 'tpRegimeSidewaysMinRangePct'
>;

describe('classifyRegime (TP path)', () => {
  it('treats ~−10% drift in a wide range as sideways (chop), not down', () => {
    const r = classifyRegime({
      cfg: { ...base } as PaperTraderConfig,
      netMovePct: -9.7,
      rangePct: 38,
      n: 100,
    });
    expect(r).toBe('sideways');
  });

  it('still labels a deep net slide as down', () => {
    const r = classifyRegime({
      cfg: { ...base } as PaperTraderConfig,
      netMovePct: -22,
      rangePct: 30,
      n: 100,
    });
    expect(r).toBe('down');
  });

  it('mild positive drift in range is sideways, strong pump is up', () => {
    const sidewaysMild = classifyRegime({
      cfg: { ...base } as PaperTraderConfig,
      netMovePct: 3,
      rangePct: 20,
      n: 10,
    });
    expect(sidewaysMild).toBe('sideways');

    const up = classifyRegime({
      cfg: { ...base } as PaperTraderConfig,
      netMovePct: 8,
      rangePct: 10,
      n: 10,
    });
    expect(up).toBe('up');
  });
});
