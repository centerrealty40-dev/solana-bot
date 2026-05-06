import { describe, it, expect } from 'vitest';
import { LIVE_SCHEMA_V1 } from '../src/live/events.js';
import {
  extractDipBotJournalAnchors,
  extractLiveOscarOpenAnchors,
  extractPaperOscarOpenAnchors,
  loadDipBotEnv,
} from '../src/intel/dip-bot-intel.js';

describe('dip-bot-intel', () => {
  it('extractLiveOscarOpenAnchors parses live_position_open envelope', () => {
    const line = JSON.stringify({
      ts: 1_700_000_000_000,
      strategyId: 'live-oscar',
      channel: 'live',
      liveSchema: LIVE_SCHEMA_V1,
      kind: 'live_position_open',
      mint: 'Mint111111111111111111111111111111111111111',
      openTrade: {
        mint: 'Mint111111111111111111111111111111111111111',
        entryTs: 1_700_000_100_000,
        symbol: 'X',
        lane: 'post_migration',
        metricType: 'mc',
        dex: 'raydium',
        legs: [],
        partialSells: [],
        totalInvestedUsd: 10,
        avgEntry: 1,
        avgEntryMarket: 1,
        remainingFraction: 1,
        entryMcUsd: 1,
        peakMcUsd: 1,
        peakPnlPct: 0,
        trailingArmed: false,
        entryMetrics: {
          uniqueBuyers: 0,
          uniqueSellers: 0,
          sumBuySol: 0,
          sumSellSol: 0,
          topBuyerShare: 0,
          bcProgress: 0,
        },
      },
    });
    const a = extractLiveOscarOpenAnchors(line, ['live-oscar']);
    expect(a).not.toBeNull();
    expect(a!.mint).toBe('Mint111111111111111111111111111111111111111');
    expect(a!.entryTsMs).toBe(1_700_000_100_000);
  });

  it('extractLiveOscarOpenAnchors ignores wrong strategy', () => {
    const line = JSON.stringify({
      ts: 1,
      strategyId: 'pt1-oscar',
      channel: 'live',
      liveSchema: LIVE_SCHEMA_V1,
      kind: 'live_position_open',
      mint: 'M',
      openTrade: { entryTs: 100 },
    });
    expect(extractLiveOscarOpenAnchors(line, ['live-oscar'])).toBeNull();
  });

  it('extractPaperOscarOpenAnchors parses paper journal kind open', () => {
    const line = JSON.stringify({
      ts: 1,
      strategyId: 'pt1-oscar',
      kind: 'open',
      mint: 'Mint333333333333333333333333333333333333333',
      entryTs: 1234567890,
      symbol: 'X',
    });
    const a = extractPaperOscarOpenAnchors(line, ['pt1-oscar']);
    expect(a).not.toBeNull();
    expect(a!.mint).toBe('Mint333333333333333333333333333333333333333');
    expect(a!.entryTsMs).toBe(1234567890);
    expect(extractDipBotJournalAnchors(line, ['pt1-oscar'])!.mint).toBe(a!.mint);
  });

  it('extractLiveOscarOpenAnchors accepts pt1-oscar when in allowlist', () => {
    const line = JSON.stringify({
      ts: 1,
      strategyId: 'pt1-oscar',
      channel: 'live',
      liveSchema: LIVE_SCHEMA_V1,
      kind: 'live_position_open',
      mint: 'Mint222222222222222222222222222222222222222',
      openTrade: {
        mint: 'Mint222222222222222222222222222222222222222',
        entryTs: 999,
      },
    });
    expect(extractLiveOscarOpenAnchors(line, ['live-oscar', 'pt1-oscar'])!.mint).toBe(
      'Mint222222222222222222222222222222222222222',
    );
    expect(extractLiveOscarOpenAnchors(line, ['live-oscar'])).toBeNull();
  });

  it('loadDipBotEnv reads defaults', () => {
    const e = loadDipBotEnv();
    expect(e.strategyIds).toContain('live-oscar');
    expect(e.strategyIds).toContain('pt1-oscar');
    expect(e.tPreMs).toBeGreaterThanOrEqual(60_000);
    expect(e.maxAnchorsPerRun).toBeGreaterThan(0);
  });
});
