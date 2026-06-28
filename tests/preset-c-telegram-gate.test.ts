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
    process.env.PRESET_C_TELEGRAM_GATE_SOURCES = 'pullback,retrace,spike';
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

  function writeConsumed(body: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(tmpDir, 'data/live/preset-c-tg-consumed.json'),
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

  it('passes when mint was sent recently via spike dump', async () => {
    const mint = 'BCdwQBAn8dYB5YjTsoB6TdHAWokxv28k2oZUodERpump';
    process.env.PRESET_C_TELEGRAM_GATE_SOURCES = 'pullback,retrace,spike';
    writeStore({
      [`${mint}|1980277`]: {
        peakBucket: 1980277,
        sentAtMs: Date.now() - 60_000,
        source: 'spike',
        spikeDumpPct: 9.45,
        refMcapUsd: 26_490_000,
      },
    });
    const { presetCTelegramGateReasons } = await import('../src/preset-c/telegram-gate.js');
    expect(presetCTelegramGateReasons(mint)).toEqual([]);
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

  it('blocks when fresh alert dedupe key was already traded', async () => {
    const mint = 'EaxAUcXxNnVwcqm2BBocbows7D1XVY2Q63V38NEypump';
    const key = `${mint}|1980246`;
    writeStore({
      [key]: { peakBucket: 1980246, sentAtMs: Date.now() - 60_000, source: 'retrace' },
    });
    writeConsumed({ [key]: { consumedAtMs: Date.now() - 30_000, peakBucket: 1980246 } });
    const { presetCTelegramGateReasons } = await import('../src/preset-c/telegram-gate.js');
    expect(presetCTelegramGateReasons(mint)).toEqual(['preset_c_telegram_gate_signal_already_traded']);
  });

  it('passes when consumed key expired (24h TTL)', async () => {
    const mint = 'EaxAUcXxNnVwcqm2BBocbows7D1XVY2Q63V38NEypump';
    const key = `${mint}|1980246`;
    writeStore({
      [key]: { peakBucket: 1980246, sentAtMs: Date.now() - 60_000, source: 'retrace' },
    });
    writeConsumed({
      [key]: { consumedAtMs: Date.now() - 25 * 60 * 60_000, peakBucket: 1980246 },
    });
    const { presetCTelegramGateReasons, isConsumed } = await import('../src/preset-c/telegram-gate.js');
    expect(isConsumed(key)).toBe(false);
    expect(presetCTelegramGateReasons(mint)).toEqual([]);
  });

  it('passes on new peak bucket while old bucket key remains consumed', async () => {
    const mint = 'EaxAUcXxNnVwcqm2BBocbows7D1XVY2Q63V38NEypump';
    const oldKey = `${mint}|1980246`;
    const newKey = `${mint}|1980247`;
    writeStore({
      [oldKey]: { peakBucket: 1980246, sentAtMs: Date.now() - 3_600_000, source: 'retrace' },
      [newKey]: { peakBucket: 1980247, sentAtMs: Date.now() - 30_000, source: 'pullback' },
    });
    writeConsumed({ [oldKey]: { consumedAtMs: Date.now() - 60_000, peakBucket: 1980246 } });
    const { presetCTelegramGateReasons } = await import('../src/preset-c/telegram-gate.js');
    expect(presetCTelegramGateReasons(mint)).toEqual([]);
  });

  it('spike geometry bypass accepts dump pct when PG retrace differs', async () => {
    const mint = 'BCdwQBAn8dYB5YjTsoB6TdHAWokxv28k2oZUodERpump';
    const key = `${mint}|1980250`;
    writeStore({
      [key]: {
        peakBucket: 1980250,
        sentAtMs: Date.now() - 60_000,
        source: 'spike',
        spikeDumpPct: 9.45,
      },
    });
    const gate = await import('../src/preset-c/telegram-gate.js');
    const reasons = gate.presetCApplySpikeGeometryRetraceBypass(
      mint,
      5,
      ['preset_c_retrace_outside_9_30pct'],
    );
    expect(reasons).toEqual([]);
    expect(gate.presetCFreshSpikeDumpPct(mint)).toBe(9.45);
  });

  it('MANIFEST-like: $26M mcap and spike 9.45% pass geometry with PG retrace below 9%', async () => {
    process.env.PULLBACK_ALERT_SKIP_MAIN = '1';
    const mint = 'BCdwQBAn8dYB5YjTsoB6TdHAWokxv28k2oZUodERpump';
    const key = `${mint}|1980277`;
    writeStore({
      [key]: {
        peakBucket: 1980277,
        sentAtMs: Date.now() - 60_000,
        source: 'spike',
        spikeDumpPct: 9.45,
        refMcapUsd: 26_490_000,
      },
    });
    const { evaluatePresetCCandidate } = await import('../src/preset-c/discovery.js');
    const decision = evaluatePresetCCandidate(
      { strategyId: 'live-oscar-preset-c' } as import('../src/papertrader/config.js').PaperTraderConfig,
      {
        dex: 'pumpswap',
        mint,
        pair: 'EcL9YDP3PsViKs2aDzDeTYdNXUCPLDodcKTbS4ayqf4N',
        symbol: 'MANIFEST',
        tokenAgeMin: 52000,
        holderCount: 5000,
        liqUsd: 200000,
        refMcapUsd: 26_490_000,
        priceUsd: 0.002,
        pick: {
          anchorTs: new Date(),
          peakTs: new Date(),
          lastTs: new Date(),
          anchorPx: 0.0022,
          peakPx: 0.0024,
          lastPx: 0.00218,
          risePct: 10,
          retraceFromPeakPct: 5,
          anchorMcapUsd: 26_000_000,
          peakMcapUsd: 28_000_000,
          lastMcapUsd: 26_490_000,
        },
      },
    );
    expect(decision.reasons).not.toContain('preset_c_mcap_above_30m');
    expect(decision.reasons).not.toContain('preset_c_retrace_outside_9_30pct');
    expect(decision.reasons).not.toContain('preset_c_telegram_gate_no_channel_alert');
  });

  it('markConsumedKeys records keys and blocks subsequent gate pass', async () => {
    const mint = 'ACpzkGJV3DDU8HXy8yjab7RL9qNmDGym2GwLkzNppump';
    const key = `${mint}|1980250`;
    writeStore({
      [key]: { peakBucket: 1980250, sentAtMs: Date.now() - 60_000, source: 'pullback' },
    });
    const gate = await import('../src/preset-c/telegram-gate.js');
    expect(gate.presetCTelegramGateReasons(mint)).toEqual([]);
    gate.markConsumedKeys([key]);
    expect(gate.isConsumed(key)).toBe(true);
    expect(gate.presetCTelegramGateReasons(mint)).toEqual([
      'preset_c_telegram_gate_signal_already_traded',
    ]);
  });

  it('markPresetCTelegramGateConsumedOnFullClose uses stamped open keys', async () => {
    const mint = 'ACpzkGJV3DDU8HXy8yjab7RL9qNmDGym2GwLkzNppump';
    const key = `${mint}|1980250`;
    const staleKey = `${mint}|1980245`;
    writeStore({
      [key]: { peakBucket: 1980250, sentAtMs: Date.now() - 60_000, source: 'pullback' },
      [staleKey]: { peakBucket: 1980245, sentAtMs: Date.now() - 30_000, source: 'pullback' },
    });
    const gate = await import('../src/preset-c/telegram-gate.js');
    gate.markPresetCTelegramGateConsumedOnFullClose('live-oscar-preset-c', {
      mint,
      presetCTgDedupeKeys: [key],
    } as import('../src/papertrader/types.js').OpenTrade);
    expect(gate.isConsumed(key)).toBe(true);
    expect(gate.isConsumed(staleKey)).toBe(false);
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
        refMcapUsd: 5_000_000,
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
          anchorMcapUsd: 5_000_000,
          peakMcapUsd: 5_500_000,
          lastMcapUsd: 5_000_000,
        },
      },
    );
    expect(decision.pass).toBe(false);
    expect(decision.reasons).toContain('preset_c_telegram_gate_no_channel_alert');
  });
});
