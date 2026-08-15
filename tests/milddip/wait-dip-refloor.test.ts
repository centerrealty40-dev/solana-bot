import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.928 — refloor kill removed: a ready wait-dip seat fires even when live
 * Dex decays after parking (leader co-buy path must not lose the fill).
 */
describe('wait-dip fill path', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('re-reads structure for the candidate snapshot but does not refloor-kill', () => {
    expect(loop).toContain('const freshStruct = await loadStructural(mint, cfg, nowMs);');
    expect(loop).not.toContain("kind: 'mild_dip_wait_dip_refloor_skip'");
  });

  it('fires on the fresh snapshot, not the parked one', () => {
    expect(loop).toContain('metrics: freshStruct?.metrics ?? watch.metrics,');
  });
});

describe('dust close only touches remnants', () => {
  const eng = readFileSync(resolve('src/milddip/exit-engine.ts'), 'utf8');

  it('requires a bank or scale-out before calling a bag dust', () => {
    expect(eng).toContain(
      'const isRemnant = pos.scaleOutDone === true || mfeBankStage >= 1;',
    );
    expect(eng).toContain('isRemnant &&');
  });
});
