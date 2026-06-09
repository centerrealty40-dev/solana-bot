import { describe, expect, it } from 'vitest';
import { evaluateFlowEntryGate } from '../../src/pumpswap-combo-follow/entry-gate.js';

const baseCfg = {
  flowGateMinExtSellUsd: 300,
  flowGateMaxExtSellUsd: 2500,
  flowGateMaxLagSec: 0,
};

describe('evaluateFlowEntryGate', () => {
  it('passes when ext sell in band', () => {
    const v = evaluateFlowEntryGate(baseCfg, 'pool1', { usd: 800, lagSec: 0, signature: 's1' });
    expect(v.pass).toBe(true);
    expect(v.extSell?.usd).toBe(800);
  });

  it('blocks chase entry without ext sell', () => {
    const v = evaluateFlowEntryGate(baseCfg, 'pool1', null);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('no_ext_sell');
  });

  it('blocks when ext sell below min', () => {
    const v = evaluateFlowEntryGate(baseCfg, 'pool1', { usd: 100, lagSec: 0, signature: 's1' });
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('no_ext_sell');
  });

  it('blocks whale dump above max', () => {
    const v = evaluateFlowEntryGate(baseCfg, 'pool1', { usd: 4000, lagSec: 0, signature: 's1' });
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('whale_dump');
  });

  it('blocks when no pool', () => {
    const v = evaluateFlowEntryGate(baseCfg, null, { usd: 500, lagSec: 0, signature: 's1' });
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('no_pool');
  });

  it('optional lag filter', () => {
    const v = evaluateFlowEntryGate({ ...baseCfg, flowGateMaxLagSec: 5 }, 'pool1', {
      usd: 500,
      lagSec: 12,
      signature: 's1',
    });
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('lag_too_slow');
  });
});
