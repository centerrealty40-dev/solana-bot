import { describe, expect, it } from 'vitest';
import {
  bumpEnrichOverBudget,
  bumpProcessStart,
  bumpTickError,
  bumpWsClosed,
  bumpWsOpen,
  bumpWsReconnectBackoff,
  mildDipRuntimeMetrics,
} from '../../src/milddip/runtime-metrics.js';

describe('mildDipRuntimeMetrics', () => {
  it('counts ws 1006 vs other and tick codes', () => {
    const before = mildDipRuntimeMetrics();
    bumpProcessStart();
    bumpWsOpen();
    bumpWsClosed(1006);
    bumpWsReconnectBackoff();
    bumpEnrichOverBudget();
    bumpTickError(Object.assign(new Error("Cannot find package '/x/undici/index.js'"), { code: 'ERR_MODULE_NOT_FOUND' }));
    const m = mildDipRuntimeMetrics();
    expect(m.processStartCount).toBe(before.processStartCount + 1);
    expect(m.wsOpenCount).toBe(before.wsOpenCount + 1);
    expect(m.wsClose1006Count).toBe(before.wsClose1006Count + 1);
    expect(m.wsReconnectBackoffCount).toBe(before.wsReconnectBackoffCount + 1);
    expect(m.enrichOverBudgetCount).toBe(before.enrichOverBudgetCount + 1);
    expect(m.tickErrorCount).toBe(before.tickErrorCount + 1);
    expect(m.tickErrorsByCode.ERR_MODULE_NOT_FOUND).toBeGreaterThan(0);
  });
});
