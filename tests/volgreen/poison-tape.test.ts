import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPoisonTapeForTests,
  defaultPoisonTapeGates,
  evaluatePoisonTape,
  isPoisoned,
  notePoisonFromLeaderTapeReject,
} from '../../src/volgreen/poison-tape.js';

describe('poison-tape', () => {
  beforeEach(() => {
    __resetPoisonTapeForTests();
  });

  it('bans mint after violent bar and remembers after soft tip', () => {
    const nowMs = 1_700_000_000_000;
    const gates = defaultPoisonTapeGates({
      MILD_DIP_POISON_TAPE: '1',
      MILD_DIP_POISON_TAPE_BAN_MS: String(45 * 60_000),
      MILD_DIP_POISON_TAPE_ABS_BAR_PC: '40',
      MILD_DIP_POISON_TAPE_MAX_G_PC: '40',
      MILD_DIP_POISON_TAPE_RUNUP_PC: '80',
    });
    const mint = 'PoisonMint111111111111111111111111111111111';
    // Nuke candle then soft tip (Fvav pattern).
    const samples: Array<{ tsMs: number; priceUsd: number }> = [];
    const path = [1.0, 1.01, 8.5, 1.2, 1.22, 1.23];
    for (let i = 0; i < path.length; i++) {
      const t = nowMs - (path.length - i) * 60_000;
      samples.push({ tsMs: t + 5_000, priceUsd: path[i]! });
      samples.push({ tsMs: t + 40_000, priceUsd: path[i]! });
    }
    const hit = evaluatePoisonTape(mint, samples, gates, nowMs);
    expect(hit.poisoned).toBe(true);
    expect(hit.reasons.some((r) => r.startsWith('poison_tape:'))).toBe(true);

    // Later soft samples only — still banned.
    const soft = [
      { tsMs: nowMs + 10 * 60_000, priceUsd: 1.2 },
      { tsMs: nowMs + 10 * 60_000 + 30_000, priceUsd: 1.25 },
      { tsMs: nowMs + 11 * 60_000, priceUsd: 1.26 },
      { tsMs: nowMs + 12 * 60_000, priceUsd: 1.27 },
    ];
    const later = isPoisoned(mint, nowMs + 12 * 60_000);
    expect(later.poisoned).toBe(true);
    const softEval = evaluatePoisonTape(mint, soft, gates, nowMs + 12 * 60_000);
    expect(softEval.poisoned).toBe(true);
  });

  it('marks poison from leader_tape reject reasons', () => {
    const gates = defaultPoisonTapeGates({ MILD_DIP_POISON_TAPE: '1' });
    const mint = 'PoisonTapeReject11111111111111111111111111';
    const nowMs = Date.now();
    notePoisonFromLeaderTapeReject(
      mint,
      ['leader_tape_maxG=744.1>40', 'leader_tape_runup=959.5>80'],
      gates,
      nowMs,
    );
    expect(isPoisoned(mint, nowMs).poisoned).toBe(true);
  });
});
