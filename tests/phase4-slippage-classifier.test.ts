/**
 * 1.11.230 — slippage-class sim_err classifier unit tests (A.2).
 *
 * Проверяем, что `isSlippageClassSimError` корректно распознаёт реальные форматы
 * ошибок Jupiter, которые мы наблюдаем в `pt1-oscar-live.jsonl`:
 *   - InstructionError[N,{"Custom":1}] (Jupiter swap, поведение пула)
 *   - 0x1771 = 6001 (Jupiter v6 SlippageToleranceExceeded)
 *   - "Slippage tolerance exceeded"
 */
import { describe, expect, it } from 'vitest';

import { isSlippageClassSimError } from '../src/live/phase4-execution.js';

describe('isSlippageClassSimError', () => {
  it('matches Jupiter "Custom":1 pool/route errors', () => {
    expect(
      isSlippageClassSimError('sim_failed:{"InstructionError":[3,{"Custom":1}]}'),
    ).toBe(true);
    expect(
      isSlippageClassSimError('sim_failed:{"InstructionError":[5,{"Custom":1}]}'),
    ).toBe(true);
    expect(
      isSlippageClassSimError('sim_failed:{"InstructionError":[2,{"Custom": 1}]}'),
    ).toBe(true);
  });

  it('matches Jupiter v6 0x1771 SlippageToleranceExceeded', () => {
    expect(
      isSlippageClassSimError(
        'sim_failed:Program log: Error: 0x1771 — slippage tolerance exceeded',
      ),
    ).toBe(true);
    expect(isSlippageClassSimError('chain_err:custom program error: 0x1771')).toBe(true);
  });

  it('matches explicit Slippage tolerance exceeded text', () => {
    expect(isSlippageClassSimError('sim_failed:Slippage tolerance exceeded')).toBe(true);
    expect(
      isSlippageClassSimError('chain_err:Program log: Error: Slippage tolerance exceeded'),
    ).toBe(true);
  });

  it('matches generic "slippage" mention (defensive)', () => {
    expect(isSlippageClassSimError('Slippage too tight')).toBe(true);
    expect(isSlippageClassSimError('sim_failed:slippage_pool_full')).toBe(true);
  });

  it('does NOT match non-slippage Jupiter errors', () => {
    expect(
      isSlippageClassSimError('sim_failed:{"InstructionError":[0,{"Custom":6010}]}'),
    ).toBe(false);
    expect(isSlippageClassSimError('sim_failed:InsufficientFundsForRent')).toBe(false);
    expect(isSlippageClassSimError('chain_err:AccountNotFound')).toBe(false);
    expect(isSlippageClassSimError('confirm_timeout')).toBe(false);
    expect(isSlippageClassSimError('send_failed:429:rate_limited')).toBe(false);
    expect(isSlippageClassSimError('')).toBe(false);
  });
});
