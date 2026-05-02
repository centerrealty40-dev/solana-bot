import { describe, it, expect } from 'vitest';
import {
  confirmationMeetsRequirement,
  isLiveSendRetryableRpcMessage,
} from '../src/live/phase6-send.js';

describe('Phase 6 send helpers (W8.0-p6)', () => {
  it('confirmationMeetsRequirement ranks statuses', () => {
    expect(confirmationMeetsRequirement(undefined, 'processed')).toBe(false);
    expect(confirmationMeetsRequirement('processed', 'processed')).toBe(true);
    expect(confirmationMeetsRequirement('processed', 'confirmed')).toBe(false);
    expect(confirmationMeetsRequirement('confirmed', 'confirmed')).toBe(true);
    expect(confirmationMeetsRequirement('confirmed', 'finalized')).toBe(false);
    expect(confirmationMeetsRequirement('finalized', 'finalized')).toBe(true);
    expect(confirmationMeetsRequirement('finalized', 'confirmed')).toBe(true);
    expect(confirmationMeetsRequirement('finalized', 'processed')).toBe(true);
  });

  it('isLiveSendRetryableRpcMessage detects transport-ish errors', () => {
    expect(isLiveSendRetryableRpcMessage('HTTP 429 Too Many Requests')).toBe(true);
    expect(isLiveSendRetryableRpcMessage('blockhash not found')).toBe(true);
    expect(isLiveSendRetryableRpcMessage('timeout')).toBe(true);
    expect(isLiveSendRetryableRpcMessage('InstructionError')).toBe(false);
  });
});
