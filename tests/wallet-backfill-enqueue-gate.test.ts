import { describe, expect, it } from 'vitest';
import { computeEnqueueBatchSize, parseOptionalPositiveIntEnv } from '../src/intel/wallet-backfill-enqueue-gate.js';

describe('parseOptionalPositiveIntEnv', () => {
  it('returns null for empty', () => {
    expect(parseOptionalPositiveIntEnv(undefined)).toBeNull();
    expect(parseOptionalPositiveIntEnv('')).toBeNull();
    expect(parseOptionalPositiveIntEnv('  ')).toBeNull();
  });
  it('parses non-negative int', () => {
    expect(parseOptionalPositiveIntEnv('1500')).toBe(1500);
    expect(parseOptionalPositiveIntEnv('0')).toBe(0);
  });
});

describe('computeEnqueueBatchSize', () => {
  it('passes full batch when no gate and no soft cap', () => {
    const r = computeEnqueueBatchSize({
      pendingCount: 100,
      requested: 500,
      gatePendingMax: null,
      softCap: null,
    });
    expect(r.effectiveN).toBe(500);
    expect(r.skipped).toBe(false);
    expect(r.reason).toBe('ok');
  });

  it('blocks when gate on and no soft cap', () => {
    const r = computeEnqueueBatchSize({
      pendingCount: 1600,
      requested: 500,
      gatePendingMax: 1500,
      softCap: null,
    });
    expect(r.effectiveN).toBe(0);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('gate_pending_over_max_no_soft_cap');
  });

  it('limits by soft cap headroom when gate off', () => {
    const r = computeEnqueueBatchSize({
      pendingCount: 1800,
      requested: 500,
      gatePendingMax: null,
      softCap: 2000,
    });
    expect(r.effectiveN).toBe(200);
    expect(r.skipped).toBe(false);
    expect(r.reason).toBe('limited_by_soft_cap_headroom');
  });

  it('when gate on with soft cap uses headroom', () => {
    const r = computeEnqueueBatchSize({
      pendingCount: 1600,
      requested: 500,
      gatePendingMax: 1500,
      softCap: 2000,
    });
    expect(r.effectiveN).toBe(400);
    expect(r.skipped).toBe(false);
    expect(r.reason).toBe('gate_active_limited_by_soft_cap_headroom');
  });

  it('gate on with soft cap but zero headroom', () => {
    const r = computeEnqueueBatchSize({
      pendingCount: 2000,
      requested: 500,
      gatePendingMax: 1500,
      softCap: 2000,
    });
    expect(r.effectiveN).toBe(0);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('gate_pending_over_max_zero_headroom');
  });

  it('pending exactly at gate max still allows enqueue without soft cap', () => {
    const r = computeEnqueueBatchSize({
      pendingCount: 1500,
      requested: 100,
      gatePendingMax: 1500,
      softCap: null,
    });
    expect(r.effectiveN).toBe(100);
    expect(r.skipped).toBe(false);
  });
});
