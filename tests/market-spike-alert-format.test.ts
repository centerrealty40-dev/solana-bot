import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.SPIKE_ALERT_SKIP_MAIN = '1';
  process.env.SPIKE_ALERT_TELEGRAM_BOT_TOKEN = '';
  process.env.SPIKE_ALERT_TELEGRAM_CHAT_ID = '';
  process.env.SPIKE_ALERT_DISPLAY_TZ = 'Europe/Moscow';
});

describe('market-spike alert format — compact Telegram', () => {
  it('dump: headline + Пролив + mcap + GMGN only', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const row = {
      base_mint: '6ehEcTMCc85aNF4x9CWx8HuvWGhxQtvKdhKVf2HDpump',
      symbol: 'TOESCOIN',
      token_name: 'TOES',
      dex: 'pumpswap',
      pct: -30.29,
      windowLabel: 'мин. 19:32 МСК→19:33 МСК',
      signalKind: 'consecutive' as const,
      anchorPx: 0.00959,
      anchorTs: new Date('2026-05-22T16:32:00.000Z'),
      anchorMcapUsd: 9_590_000,
      nowMcapUsd: 6_690_000,
      px_now: 0.006685,
      ts_now: new Date('2026-05-22T16:33:00.000Z'),
      pair_address: 'pair',
      holder_count: null,
      liq_usd: 219768,
      tierName: 'tier3(7M+)',
    };

    const plain = mod.buildAlertPlain(row);
    expect(plain).toContain('TOESCOIN — TOES Пролив -30.29%');
    expect(plain).toContain('Δ mcap');
    expect(plain).toContain('$9.59M → $6.69M');
    expect(plain).toContain('GMGN (https://gmgn.ai/sol/token/6ehEcTMCc85aNF4x9CWx8HuvWGhxQtvKdhKVf2HDpump)');
    expect(plain).not.toContain('[spike_dump]');
    expect(plain).not.toContain('tier:');
    expect(plain).not.toContain('holders');
    expect(plain).not.toContain('liq');

    const html = mod.buildAlertHtml(row);
    expect(html).toContain('TOESCOIN');
    expect(html).toContain('Пролив');
    expect(html).toContain('Δ mcap');
    expect(html).toContain('GMGN</a>');
    expect(html).not.toContain('[spike_dump]');
    expect(html).not.toContain('tier:');
    expect(html).not.toContain('holders');
  });

  it('update: «Вот уже N%» follow-up после первого алерта', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const row = {
      base_mint: '6ehEcTMCc85aNF4x9CWx8HuvWGhxQtvKdhKVf2HDpump',
      symbol: 'TOESCOIN',
      token_name: 'TOES',
      dex: 'pumpswap',
      pct: -15,
      windowLabel: 'мин. 19:35 МСК→19:36 МСК',
      signalKind: 'consecutive' as const,
      anchorPx: 0.00959,
      anchorTs: new Date('2026-05-22T16:32:00.000Z'),
      anchorMcapUsd: 9_590_000,
      nowMcapUsd: 8_150_000,
      px_now: 0.00815,
      ts_now: new Date('2026-05-22T16:36:00.000Z'),
      pair_address: 'pair',
      isUpdate: true,
      prevPct: -10,
    };

    expect(mod.formatEscalationAlreadyLabel(-15)).toBe('Вот уже 15%');
    const plain = mod.buildAlertPlain(row);
    expect(plain).toContain('TOESCOIN — TOES · Вот уже 15%');
    expect(plain).not.toContain('Пролив (UPDATE)');
    expect(plain).not.toContain('[spike_dump');
  });
});
