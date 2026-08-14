import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.841 — a wait-dip seat qualifies once and fires minutes later on the metrics
 * captured at parking time, so a coin that decayed in between got bought on a
 * stale qualification.
 *
 * Live case: the floors refused the mint ~10 times as it died (liq $19.1k →
 * $13.1k, vol5m $4 415 → $181), then a seat parked at 19:15 fired at 19:22 with
 * liq $2 484 and mcap $2 620 against $5 000 floors, and it rugged. Over 4h, 6 of
 * 156 filled buys violated a floor and all 6 came through this path.
 */
describe('wait-dip structural re-check', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('re-reads structure before firing a parked seat', () => {
    expect(loop).toContain('const freshStruct = await loadStructural(mint, cfg, nowMs);');
    expect(loop).toContain('metricsHotDeepDumpOk(cfg, freshStruct.metrics, streamDump)');
    expect(loop).toContain('structuralOk(freshStruct.metrics, cfg, leaderSeen, leaderFreshBuy, hotDeepDump)');
  });

  it('drops the seat on refloor skip when not a hot deep dump', () => {
    expect(loop).toContain("kind: 'mild_dip_wait_dip_refloor_skip'");
    expect(loop).toContain('if (!hardOk || !hotDeepDump)');
    expect(loop).toContain("delete state.waitDipWatch![mint];");
  });

  it('fires on the fresh snapshot, not the parked one', () => {
    expect(loop).toContain('metrics: freshStruct?.metrics ?? watch.metrics,');
  });

  it('records what decayed, so the cost of the gate stays auditable', () => {
    for (const field of ['parkedLiq', 'parkedVol5m']) {
      expect(loop).toContain(field);
    }
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
