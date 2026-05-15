import { describe, it, expect, beforeAll } from 'vitest';

/**
 * 1.11.169: Tier-логика (раздельные пороги consec/rolling) и эскалация повторного [UPDATE]-алерта
 * у `market-spike-telegram-watch`.
 *
 * Тесты — чистые функции без БД/HTTP. Импорт через динамический import после установки env,
 * чтобы константы модуля парсили env корректно (PUMP_MIN_PCT, DUMP_TIER*_MIN_PCT_*).
 */

beforeAll(() => {
  // Главное — не дать модулю на module-level запустить main() (PG/Telegram).
  process.env.SPIKE_ALERT_SKIP_MAIN = '1';
  // Стабильные дефолты под продовое поведение (см. ecosystem.market-spike-watch.cjs).
  process.env.SPIKE_ALERT_TIERED_BY_MCAP = '1';
  process.env.SPIKE_ALERT_PUMP_MIN_PCT = '30';
  process.env.SPIKE_ALERT_DUMP_TIER1_MCAP_USD = '1500000';
  process.env.SPIKE_ALERT_DUMP_TIER1_MIN_PCT = '14';
  process.env.SPIKE_ALERT_DUMP_TIER1_MIN_PCT_ROLLING = '15';
  process.env.SPIKE_ALERT_DUMP_TIER2_MCAP_USD = '3000000';
  process.env.SPIKE_ALERT_DUMP_TIER2_MIN_PCT = '11';
  process.env.SPIKE_ALERT_DUMP_TIER2_MIN_PCT_ROLLING = '12';
  process.env.SPIKE_ALERT_DUMP_TIER3_MCAP_USD = '7000000';
  process.env.SPIKE_ALERT_DUMP_TIER3_MIN_PCT = '8';
  process.env.SPIKE_ALERT_DUMP_TIER3_MIN_PCT_ROLLING = '10';
  // Telegram токены — пустые (тесты только импортируют чистые функции).
  process.env.SPIKE_ALERT_TELEGRAM_BOT_TOKEN = '';
  process.env.SPIKE_ALERT_TELEGRAM_CHAT_ID = '';
});

describe('tierRequiredMinAbsPct — раздельные пороги consec и rolling', () => {
  it('tier3 (≥$7M): consec=8%, rolling=10%', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.tierRequiredMinAbsPct(7_500_000, false, 'consecutive')).toBe(8);
    expect(mod.tierRequiredMinAbsPct(7_500_000, false, 'rolling')).toBe(10);
  });

  it('tier2 (≥$3M, <$7M): consec=11%, rolling=12%', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.tierRequiredMinAbsPct(5_000_000, false, 'consecutive')).toBe(11);
    expect(mod.tierRequiredMinAbsPct(5_000_000, false, 'rolling')).toBe(12);
  });

  it('tier1 (≥$1.5M, <$3M): consec=14%, rolling=15%', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.tierRequiredMinAbsPct(2_000_000, false, 'consecutive')).toBe(14);
    expect(mod.tierRequiredMinAbsPct(2_000_000, false, 'rolling')).toBe(15);
  });

  it('sub-tier (<$1.5M) — отбрасываем (null)', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.tierRequiredMinAbsPct(500_000, false, 'consecutive')).toBeNull();
    expect(mod.tierRequiredMinAbsPct(500_000, false, 'rolling')).toBeNull();
  });

  it('pump игнорирует mcap-tier — единый порог 30%', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.tierRequiredMinAbsPct(500_000, true, 'consecutive')).toBe(30);
    expect(mod.tierRequiredMinAbsPct(50_000_000, true, 'rolling')).toBe(30);
  });

  it('tierRank растёт с капой: <1.5M=0, 1.5-3M=1, 3-7M=2, ≥7M=3', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.tierRank(500_000)).toBe(0);
    expect(mod.tierRank(2_000_000)).toBe(1);
    expect(mod.tierRank(5_000_000)).toBe(2);
    expect(mod.tierRank(10_000_000)).toBe(3);
  });

  it('tierLabel возвращает «sub-tier(<1.5M)» для микрокапа и tier3(7M+) для крупного', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.tierLabel(800_000)).toContain('sub-tier');
    expect(mod.tierLabel(10_000_000)).toContain('tier3');
  });
});

describe('decideEscalation — повторный [UPDATE]-алерт при усилении пролива', () => {
  const baseArgs = {
    nowMs: 1_700_000_000_000,
    cooldownMs: 5 * 60_000,
    escalateEnabled: true,
    escalateDeltaPct: 5,
    escalateMinGapSec: 60,
    escalateMaxPerMint: 3,
    tierChangeForcesUpdate: true,
  };

  it('первый алерт: prev=null → kind=first', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: null,
      candidatePct: -10,
      candidateTierRank: 2,
    });
    expect(d.kind).toBe('first');
  });

  it('cooldown истёк → отправляем как первый алерт', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: {
        lastSentAbsPct: 9,
        lastWasPump: false,
        lastTierRank: 2,
        lastTierName: 'tier2',
        lastSentAtMs: baseArgs.nowMs - 6 * 60_000,
        updatesSent: 0,
      },
      candidatePct: -12,
      candidateTierRank: 2,
    });
    expect(d.kind).toBe('first');
  });

  it('усиление пролива на ≥ delta_pct → kind=update (delta_pct)', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: {
        lastSentAbsPct: 9,
        lastWasPump: false,
        lastTierRank: 2,
        lastTierName: 'tier2',
        lastSentAtMs: baseArgs.nowMs - 90_000,
        updatesSent: 0,
      },
      candidatePct: -16,
      candidateTierRank: 2,
    });
    expect(d.kind).toBe('update');
    if (d.kind === 'update') expect(d.reason).toBe('delta_pct');
  });

  it('переход в более жёсткий tier → kind=update (tier_change), даже при малой дельте', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: {
        lastSentAbsPct: 9,
        lastWasPump: false,
        lastTierRank: 3,
        lastTierName: 'tier3',
        lastSentAtMs: baseArgs.nowMs - 90_000,
        updatesSent: 0,
      },
      // tier3→tier2 (rank 3→2): tier стал жёстче, дельта только 2 п.п.
      candidatePct: -11.2,
      candidateTierRank: 2,
    });
    expect(d.kind).toBe('update');
    if (d.kind === 'update') expect(d.reason).toBe('tier_change');
  });

  it('усиление, но gap < min_gap → skip (gap_too_small)', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: {
        lastSentAbsPct: 9,
        lastWasPump: false,
        lastTierRank: 2,
        lastTierName: 'tier2',
        lastSentAtMs: baseArgs.nowMs - 30_000,
        updatesSent: 0,
      },
      candidatePct: -16,
      candidateTierRank: 2,
    });
    expect(d.kind).toBe('skip');
    if (d.kind === 'skip') expect(d.reason).toBe('gap_too_small');
  });

  it('лимит апдейтов исчерпан → skip (max_updates_reached)', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: {
        lastSentAbsPct: 16,
        lastWasPump: false,
        lastTierRank: 1,
        lastTierName: 'tier1',
        lastSentAtMs: baseArgs.nowMs - 90_000,
        updatesSent: 3, // уже 3 апдейта
      },
      candidatePct: -22,
      candidateTierRank: 1,
    });
    expect(d.kind).toBe('skip');
    if (d.kind === 'skip') expect(d.reason).toBe('max_updates_reached');
  });

  it('|new pct| ≤ |prev pct| → skip (pct_below_prev)', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: {
        lastSentAbsPct: 16,
        lastWasPump: false,
        lastTierRank: 1,
        lastTierName: 'tier1',
        lastSentAtMs: baseArgs.nowMs - 90_000,
        updatesSent: 0,
      },
      candidatePct: -10,
      candidateTierRank: 2,
    });
    expect(d.kind).toBe('skip');
    if (d.kind === 'skip') expect(d.reason).toBe('pct_below_prev');
  });

  it('разные стороны (был pump, теперь dump) → skip (wrong_side)', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: {
        lastSentAbsPct: 30,
        lastWasPump: true,
        lastTierRank: 2,
        lastTierName: 'tier2',
        lastSentAtMs: baseArgs.nowMs - 90_000,
        updatesSent: 0,
      },
      candidatePct: -20,
      candidateTierRank: 2,
    });
    expect(d.kind).toBe('skip');
    if (d.kind === 'skip') expect(d.reason).toBe('wrong_side');
  });

  it('эскалация выключена → внутри cooldown всегда skip (cooldown_no_escalation)', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      escalateEnabled: false,
      prev: {
        lastSentAbsPct: 9,
        lastWasPump: false,
        lastTierRank: 2,
        lastTierName: 'tier2',
        lastSentAtMs: baseArgs.nowMs - 90_000,
        updatesSent: 0,
      },
      candidatePct: -20,
      candidateTierRank: 1,
    });
    expect(d.kind).toBe('skip');
    if (d.kind === 'skip') expect(d.reason).toBe('cooldown_no_escalation');
  });

  it('усиление < delta_pct и tier тот же → skip (cooldown_no_escalation)', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const d = mod.decideEscalation({
      ...baseArgs,
      prev: {
        lastSentAbsPct: 9,
        lastWasPump: false,
        lastTierRank: 2,
        lastTierName: 'tier2',
        lastSentAtMs: baseArgs.nowMs - 90_000,
        updatesSent: 0,
      },
      candidatePct: -12, // дельта 3 п.п. < 5
      candidateTierRank: 2,
    });
    expect(d.kind).toBe('skip');
    if (d.kind === 'skip') expect(d.reason).toBe('cooldown_no_escalation');
  });
});
