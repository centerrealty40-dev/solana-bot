import { describe, expect, it } from 'vitest';
import {
  DETECTIVE_DATA_PLANE_PILOT_PRESETS,
  pilotSlotCeilingCredits,
} from '../src/intel/wallet-backfill-cron-presets.js';

describe('DETECTIVE_DATA_PLANE_PILOT_PRESETS', () => {
  it('matches install-detective cron ceilings at 30 credits/RPC', () => {
    const cp = 30;
    const [am, pm] = DETECTIVE_DATA_PLANE_PILOT_PRESETS;
    expect(am.maxWallets).toBe(160);
    expect(am.sigPagesMax).toBe(3);
    expect(am.maxTxPerWallet).toBe(32);
    expect(pilotSlotCeilingCredits(am, cp)).toBe(160 * 35 * 30);

    expect(pm.maxWallets).toBe(120);
    expect(pm.maxTxPerWallet).toBe(28);
    expect(pilotSlotCeilingCredits(pm, cp)).toBe(120 * 31 * 30);

    const sum = DETECTIVE_DATA_PLANE_PILOT_PRESETS.reduce((a, s) => a + pilotSlotCeilingCredits(s, cp), 0);
    expect(sum).toBe(168000 + 111600);
  });
});
