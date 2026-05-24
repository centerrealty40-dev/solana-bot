import { describe, it, expect } from 'vitest';

import {
  buildDipsCompactAlertHtml,
  buildDipsCompactAlertPlain,
} from '../src/scripts/market-dips-compact-telegram-format.js';

describe('market-dips compact Telegram format', () => {
  const row = {
    mint: 'BCdwQBAn8dYB5YjTsoB6TdHAWokxv28k2oZUodERpump',
    symbol: 'MANIFEST',
    token_name: 'Manifesting',
    retraceFromPeakPct: 10.91,
    peakTs: new Date('2026-05-22T14:01:00.000Z'),
    peakMcapUsd: 26_890_000,
    troughTs: new Date('2026-05-22T15:11:00.000Z'),
    troughMcapUsd: 23_960_000,
    refMcap: 23_960_000,
    displayTz: 'Europe/Moscow',
  };

  it('plain: headline + GMGN + 2 mcap lines + ref (no mint/dex/holders)', () => {
    const plain = buildDipsCompactAlertPlain(row);
    expect(plain).toContain('MANIFEST — Manifesting откат -10.91%');
    expect(plain).toContain('GMGN (https://gmgn.ai/sol/token/BCdwQBAn8dYB5YjTsoB6TdHAWokxv28k2oZUodERpump)');
    expect(plain).toContain('mcap $26.89M');
    expect(plain).toContain('mcap $23.96M');
    expect(plain).toContain('Ref mcap/fdv (текущая оценка) ≈ $23.96M');
    expect(plain).not.toContain('[MARKET]');
    expect(plain).not.toContain('[RETRACE]');
    expect(plain).not.toContain('Mint:');
    expect(plain).not.toContain('holders');
    expect(plain).not.toContain('price_usd');
    expect(plain).not.toContain('Локальный лой');
  });

  it('html: compact 5 lines with GMGN link', () => {
    const html = buildDipsCompactAlertHtml(row);
    expect(html).toContain('<b>MANIFEST</b> — Manifesting');
    expect(html).toContain('откат -10.91%');
    expect(html).toContain('GMGN</a>');
    expect(html).toContain('$26.89M');
    expect(html).toContain('$23.96M');
    expect(html).not.toContain('[pullback]');
    expect(html).not.toContain('Mint:');
  });
});
