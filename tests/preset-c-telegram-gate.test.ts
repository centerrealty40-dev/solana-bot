import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('preset C telegram gate', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-c-tg-gate-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'data/live'), { recursive: true });
    process.env.PRESET_C_TELEGRAM_GATE_ENABLED = '1';
    process.env.PRESET_C_TELEGRAM_GATE_SOURCES = 'pullback,retrace';
    process.env.PRESET_C_TELEGRAM_GATE_MAX_AGE_MS = '3600000';
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    delete process.env.PRESET_C_TELEGRAM_GATE_ENABLED;
    delete process.env.PRESET_C_TELEGRAM_GATE_SOURCES;
    delete process.env.PRESET_C_TELEGRAM_GATE_MAX_AGE_MS;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeStore(body: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(tmpDir, 'data/live/telegram-retrace-pullback-dedupe.json'),
      `${JSON.stringify(body)}\n`,
      'utf8',
    );
  }

  it('blocks when mint has no channel alert in dedupe store', async () => {
    writeStore({});
    const { presetCTelegramGateReasons } = await import('../src/preset-c/telegram-gate.js');
    expect(presetCTelegramGateReasons('MintNoAlert1111111111111111111111111111111')).toEqual([
      'preset_c_telegram_gate_no_channel_alert',
    ]);
  });

  it('passes when mint was sent recently via pullback', async () => {
    const mint = 'ACpzkGJV3DDU8HXy8yjab7RL9qNmDGym2GwLkzNppump';
    writeStore({
      [`${mint}|1980250`]: { peakBucket: 1980250, sentAtMs: Date.now() - 60_000, source: 'pullback' },
    });
    const { presetCTelegramGateReasons } = await import('../src/preset-c/telegram-gate.js');
    expect(presetCTelegramGateReasons(mint)).toEqual([]);
  });

  it('blocks stale channel alerts outside max age', async () => {
    const mint = 'EaxAUcXxNnVwcqm2BBocbows7D1XVY2Q63V38NEypump';
    writeStore({
      [`${mint}|1980246`]: {
        peakBucket: 1980246,
        sentAtMs: Date.now() - 2 * 3600_000,
        source: 'retrace',
      },
    });
    const { presetCTelegramGateReasons } = await import('../src/preset-c/telegram-gate.js');
    expect(presetCTelegramGateReasons(mint)).toEqual(['preset_c_telegram_gate_no_channel_alert']);
  });

  it('evaluatePresetCCandidate applies telegram gate', async () => {
    process.env.PULLBACK_ALERT_SKIP_MAIN = '1';
    const mint = '9VY2rDbtsBmTsBxoRF8hWSEUKGqnoQoe9V6W3JnjNgfm';
    writeStore({});
    const { evaluatePresetCCandidate } = await import('../src/preset-c/discovery.js');
    const decision = evaluatePresetCCandidate(
      { strategyId: 'live-oscar-preset-c' } as import('../src/papertrader/config.js').PaperTraderConfig,
      {
        dex: 'meteora',
        mint,
        pair: 'EcL9YDP3PsViKs2aDzDeTYdNXUCPLDodcKTbS4ayqf4N',
        symbol: 'JTVO',
        tokenAgeMin: 52000,
        holderCount: 5000,
        liqUsd: 200000,
        refMcapUsd: 2_000_000,
        priceUsd: 0.002,
        pick: {
          anchorTs: new Date(),
          peakTs: new Date(),
          lastTs: new Date(),
          anchorPx: 0.0022,
          peakPx: 0.0024,
          lastPx: 0.002,
          risePct: 10,
          retraceFromPeakPct: 12,
          anchorMcapUsd: 2_000_000,
          peakMcapUsd: 2_200_000,
          lastMcapUsd: 2_000_000,
        },
      },
    );
    expect(decision.pass).toBe(false);
    expect(decision.reasons).toContain('preset_c_telegram_gate_no_channel_alert');
  });
});
