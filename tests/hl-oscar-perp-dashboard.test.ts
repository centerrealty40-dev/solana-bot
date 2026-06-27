import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hlOscarExitReasonForMetrics,
  hlOscarHyperliquidTradeUrl,
  loadHlOscarPerpForDashboard,
} from '../scripts-tmp/hl-oscar-perp-dashboard.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

describe('hlOscarExitReasonForMetrics', () => {
  it('maps HL Oscar reasons to dashboard buckets', () => {
    expect(hlOscarExitReasonForMetrics('KILL')).toBe('SL');
    expect(hlOscarExitReasonForMetrics('STAGED_KILL')).toBe('SL');
    expect(hlOscarExitReasonForMetrics('TIME_STOP')).toBe('TIMEOUT');
    expect(hlOscarExitReasonForMetrics('TP')).toBe('TP');
    expect(hlOscarExitReasonForMetrics('TRAIL')).toBe('TRAIL');
  });
});

describe('loadHlOscarPerpForDashboard', () => {
  it('builds open/close rows and timeline from journal', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-oscar-dash-'));
    const fp = path.join(tmpDir, 'live.jsonl');
    const t0 = Date.now() - 7200_000;
    const posId = 'pos-btc-1';
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          kind: 'open',
          ts: t0,
          id: posId,
          coin: 'BTC',
          displaySymbol: 'BTC',
          legIndex: 1,
          signalPrice: 95000,
          fillPx: 94800,
          grossUsd: 15,
          marginUsd: 7.5,
          dipPct: -12,
          impulsePct: 15,
          windowMin: 120,
          mode: 'live',
        }),
        JSON.stringify({
          kind: 'add_leg',
          ts: t0 + 600_000,
          id: posId,
          coin: 'BTC',
          legIndex: 2,
          fillPx: 92000,
          grossUsd: 15,
          marginUsd: 7.5,
          avgEntryPx: 93400,
          mode: 'live',
        }),
        JSON.stringify({
          kind: 'partial_exit',
          ts: t0 + 1200_000,
          id: posId,
          coin: 'BTC',
          reason: 'TP',
          fraction: 0.5,
          fillPx: 98000,
          notionalUsd: 25,
          pnlUsd: 2.5,
          remainingFraction: 0.5,
          mode: 'live',
        }),
        JSON.stringify({
          kind: 'close',
          ts: t0 + 1800_000,
          id: posId,
          coin: 'BTC',
          reason: 'TIME_STOP',
          exitPx: 96000,
          pnlUsd: 1.2,
          pnlPct: 2.4,
          holdHours: 0.5,
          mode: 'live',
        }),
        JSON.stringify({
          kind: 'heartbeat',
          ts: Date.now(),
          openCount: 0,
          mode: 'live',
          universeSize: 120,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const load = loadHlOscarPerpForDashboard(fp);
    expect(load.open).toHaveLength(0);
    expect(load.closed).toHaveLength(1);
    expect(load.closed[0]!.symbol).toBe('BTC');
    expect(load.closed[0]!.exitReason).toBe('TIMEOUT');
    const tl = load.closed[0]!.__timeline as { kind: string; label: string }[];
    expect(tl.some((e) => e.kind === 'open')).toBe(true);
    expect(tl.some((e) => e.kind === 'scale_in_add')).toBe(true);
    expect(tl.some((e) => e.kind === 'partial_sell' && e.label.includes('profit'))).toBe(true);
    expect(tl.some((e) => e.kind === 'close')).toBe(true);
    expect(load.hlOscar?.mode).toBe('live');
    expect(load.hlOscar?.liveDryRun).toBe(false);
  });
});

describe('hlOscarHyperliquidTradeUrl', () => {
  it('builds trade page URL', () => {
    expect(hlOscarHyperliquidTradeUrl('btc')).toBe('https://app.hyperliquid.xyz/trade/BTC');
  });
});
