import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  entrySplitLeg2TimelineLabel,
  legTimelineLabelFromLeg,
  liveStagedOpenLabelRuFromCfg,
  stagedAvgTimelineLabel,
} from '../src/papertrader/executor/live-staged-entry-labels.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';

function miniCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    liveStagedEntryEntrySplitLegUsd: 500,
    liveStagedEntryEntrySplitDelayMs: 10_000,
    liveStagedEntryEntrySplitMaxUpPct: 3,
    liveStagedEntryEntrySplitMaxDownPct: 10,
    liveStagedEntrySecondLegUsd: 150,
    liveStagedEntrySecondDropPct: 7,
    liveStagedEntryThirdLegUsd: 150,
    liveStagedEntryThirdDropPct: 14,
    liveStagedEntryAvgCooldownMs: 180_000,
    liveStagedEntryAvgSecondCooldownMs: 300_000,
    ...over,
  } as PaperTraderConfig;
}

describe('live-staged-entry-labels', () => {
  it('open label mentions split leg 1 and planned avg legs', () => {
    const s = liveStagedOpenLabelRuFromCfg(miniCfg());
    assert.match(s, /1-я нога сплита/);
    assert.match(s, /2-я нога сплита/);
    assert.match(s, /1-е усреднение/);
    assert.match(s, /2-е усреднение/);
  });

  it('leg labels distinguish split vs avg', () => {
    assert.match(entrySplitLeg2TimelineLabel(500, 2.5), /2-я нога сплита/);
    assert.match(
      stagedAvgTimelineLabel({ which: 1, usd: 150, signalDropPct: -8, drop7: 7, drop14: 14 }),
      /Усреднение · 1-е/,
    );
    const leg2 = legTimelineLabelFromLeg(
      { reason: 'entry_split', sizeUsd: 500, triggerPct: 0.02 },
      { liveStagedEntry: { entrySplitV2: true } },
    );
    assert.ok(leg2?.includes('сплита'));
  });
});
