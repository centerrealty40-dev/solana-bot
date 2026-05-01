import { child } from '../core/logger.js';
import { emitQuickNodeBillingMilestones } from '../core/rpc/quicknode-billing-alerts.js';
import {
  fetchQuickNodeBillingPeriodSummary,
  fetchQuickNodeRpcUsageWindow,
  refreshQuickNodeProviderDailyCache,
} from '../core/rpc/quicknode-provider-usage.js';
import { sendTagged } from '../core/telegram/sender.js';

const log = child('sa-stream-qn-usage');

function isoUtcFromUnixSec(sec?: number): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

let lastTelegramMs = 0;
let lastCapAlertDayUtc: string | null = null;

/**
 * Периодически опрашивает QuickNode Admin API за текущий UTC-день и пишет кэш
 * `data/quicknode-provider-daily.json` (сумма по всем каналам: HTTP + WSS).
 * Опционально шлёт сводку в Telegram (REPORT).
 */
export function startQuickNodeUsageReporting(): void {
  const fromFile = process.env.QUICKNODE_ADMIN_API_KEY_FILE?.trim();
  const key =
    process.env.QUICKNODE_ADMIN_API_KEY?.trim() ||
    process.env.QUICKNODE_API_KEY?.trim() ||
    process.env.QN_ADMIN_API_KEY?.trim();
  if (!key && !fromFile) {
    log.warn(
      'Set QUICKNODE_ADMIN_API_KEY or QUICKNODE_ADMIN_API_KEY_FILE (Console API, CONSOLE_REST) — see https://dashboard.quicknode.com/api-keys',
    );
    return;
  }
  if (fromFile) {
    log.info(
      { file: fromFile },
      'QuickNode Admin API: key expected in this file (Console REST, one line)',
    );
  }

  const pollMs = Math.max(60_000, Number(process.env.QUICKNODE_USAGE_POLL_MS || 1_800_000));
  /** Отчёт в Telegram не чаще, чем раз в N мс (по умолчанию 3 ч). */
  const tgMinMs = Math.max(0, Number(process.env.QUICKNODE_USAGE_TELEGRAM_MIN_MS || 10_800_000));

  const tick = async () => {
    try {
      const row = await refreshQuickNodeProviderDailyCache();
      if (!row) return;

      if (process.env.QUICKNODE_USAGE_TELEGRAM === '0') return;
      if (Date.now() - lastTelegramMs < tgMinMs) return;
      lastTelegramMs = Date.now();

      const budget = Math.max(1, Number(process.env.QUICKNODE_DAILY_CREDIT_BUDGET || 3_000_000));
      const pct = ((row.providerCreditsUsed / budget) * 100).toFixed(1);
      const rem =
        row.creditsRemaining != null && Number.isFinite(row.creditsRemaining)
          ? row.creditsRemaining.toLocaleString('en-US')
          : 'n/a';
      const plan =
        row.planLimit != null && Number.isFinite(row.planLimit)
          ? row.planLimit.toLocaleString('en-US')
          : 'n/a';

      const msg =
        `QuickNode UTC ${row.dayUtc}: ${row.providerCreditsUsed.toLocaleString('en-US')} credits за сутки (Admin API v0/usage/rpc — сумма по аккаунту, HTTP+WS). ` +
        `Ориентир суток в коде: ${budget.toLocaleString('en-US')} (~${pct}% от ориентира). ` +
        `Остаток кредитов (billing period, API): ${rem}. Лимит плана (API): ${plan}.`;

      const cat = process.env.QUICKNODE_USAGE_TELEGRAM_CATEGORY === 'REPORT' ? 'REPORT' : 'ALERT';
      await sendTagged(cat, 'quicknode-usage', msg);

      if (
        process.env.QUICKNODE_USAGE_CAP_ALERT === '1' &&
        row.providerCreditsUsed >= budget &&
        lastCapAlertDayUtc !== row.dayUtc
      ) {
        lastCapAlertDayUtc = row.dayUtc;
        await sendTagged(
          'ALERT',
          'quicknode-daily',
          `QuickNode: дневной ориентир ${budget.toLocaleString('en-US')} credits по данным Admin API — уже ${row.providerCreditsUsed.toLocaleString('en-US')} за UTC-день ${row.dayUtc}. Учитываются HTTP и WSS вместе.`,
        );
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'quicknode usage tick failed');
    }
  };

  const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const hourlyMs = Math.max(
    60_000,
    Number(process.env.QUICKNODE_HOURLY_REMAINING_TELEGRAM_MS || 3_600_000),
  );

  const hourlyRemaining = async () => {
    /* Часовой отчёт — отдельный лимит Console API; по умолчанию выкл. Вкл.: QUICKNODE_HOURLY_REMAINING_TELEGRAM=1 */
    if (process.env.QUICKNODE_HOURLY_REMAINING_TELEGRAM !== '1') return;
    try {
      const s = await fetchQuickNodeBillingPeriodSummary();
      if (!s) return;
      const pct = ((s.credits_used / s.limit) * 100).toFixed(1);
      const startIso = isoUtcFromUnixSec(s.start_time);
      const endIso = isoUtcFromUnixSec(s.end_time);
      const periodLine =
        startIso && endIso
          ? ` Биллинг-период (границы UTC из Admin API): ${startIso} → ${endIso}.`
          : '';

      const recentParts: string[] = [];
      const recentRaw = (process.env.QUICKNODE_HOURLY_RECENT_MINUTES_LIST ?? '')
        .split(',')
        .map((x) => Number(String(x).trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 24 * 60);
      const nowSec = Math.floor(Date.now() / 1000);
      for (const minutes of recentRaw) {
        const startSec = nowSec - minutes * 60;
        const w = await fetchQuickNodeRpcUsageWindow(startSec, nowSec);
        if (w && Number.isFinite(w.credits_used)) {
          recentParts.push(
            `${minutes}m: ${Math.round(w.credits_used).toLocaleString('en-US')} credits`,
          );
        }
      }
      const recentLine =
        recentParts.length > 0 ? ` Скользящее окно (Admin API): ${recentParts.join('; ')}.` : '';

      const msg =
        `QuickNode: по биллинг-периоду осталось ${s.credits_remaining.toLocaleString('en-US')} из ${s.limit.toLocaleString('en-US')} кредитов. ` +
        `Израсходовано ${s.credits_used.toLocaleString('en-US')} (${pct}% лимита).` +
        periodLine +
        recentLine;
      const ok = await sendTagged('ALERT', 'quicknode-balance', msg);
      log.info(
        { ok, remaining: s.credits_remaining, limit: s.limit, used: s.credits_used },
        'quicknode hourly balance telegram',
      );
    } catch (e) {
      log.warn({ err: String(e) }, 'quicknode hourly balance telegram failed');
    }
  };

  /** Чаще, чем часовой отчёт: пороги по биллинг-периоду (1M credits / N% лимита). */
  const milestonePollMs = Math.max(
    60_000,
    Number(process.env.QUICKNODE_BILLING_MILESTONE_POLL_MS || 300_000),
  );

  const milestoneTick = async () => {
    try {
      const s = await fetchQuickNodeBillingPeriodSummary();
      if (!s) return;
      await emitQuickNodeBillingMilestones(s);
    } catch (e) {
      log.warn({ err: String(e) }, 'quicknode billing milestone tick failed');
    }
  };

  /** Подряд несколько GET к Console API дают 429; разносим старт и опираемся на кэш billing summary. */
  const runStartupSequence = async () => {
    try {
      await tick();
      await pause(800);
      await milestoneTick();
      await pause(800);
      await hourlyRemaining();
    } catch (e) {
      log.warn({ err: String(e) }, 'quicknode usage startup sequence failed');
    }
  };
  void runStartupSequence();

  setInterval(() => void tick(), pollMs);
  setInterval(() => void hourlyRemaining(), hourlyMs);
  setInterval(() => void milestoneTick(), milestonePollMs);
}
