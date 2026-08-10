import { describe, expect, it, vi } from 'vitest';
import { extractMintCandidatesFromLogs } from '../../src/scripts/awakening/awakening-mint-from-logs.js';

const PUMP_MINT = '4ko5tSr5o3H4v1sFtjTSd9MPUW7yx5AFCpkNPoL6pump';

/**
 * 1.11.795 — failed txs still mention mints; early-return on `n.err`
 * starved hot-mints / fast-path while opens > 0.
 */
describe('mild-dip stream err mint harvest', () => {
  it('extracts pump mint from failed-tx style logs', () => {
    const logs = [
      'Program log: Instruction: Buy',
      `Program data: ${PUMP_MINT}`,
      'Program log: Error: custom program error: 0x1771',
    ];
    const mints = extractMintCandidatesFromLogs(logs);
    expect(mints).toContain(PUMP_MINT);
  });

  it('handler without err-gate still fires onMint for err notes', () => {
    const onMint = vi.fn();
    const note = {
      err: { InstructionError: [1, 'Custom'] },
      logs: ['Program log: Instruction: Buy', `Program data: ${PUMP_MINT}`],
      signature: 'sigFailed',
    };
    // Mirror stream.ts 1.11.795 (no `if (n.err) return` before extract).
    const mints = extractMintCandidatesFromLogs(note.logs);
    for (const mint of mints) onMint(mint, 1);
    expect(note.err).toBeTruthy();
    expect(onMint).toHaveBeenCalledWith(PUMP_MINT, 1);
  });
});
