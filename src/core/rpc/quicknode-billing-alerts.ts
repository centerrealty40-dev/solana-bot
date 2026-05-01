/**
 * Пороговые Telegram-уведомления по данным QuickNode Admin API (биллинг-период):
 * — каждые QUICKNODE_BILLING_ALERT_EVERY_CREDITS кредитов израсходовано (по умолчанию 1M);
 * — опционально каждые QUICKNODE_BILLING_ALERT_PCT_STEP процентов от лимита плана (напр. 3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { child } from '../logger.js';
import { sendTagged } from '../telegram/sender.js';

const log = child('quicknode-billing-alerts');

export type BillingSummaryForAlerts = {
  credits_used: number;
  credits_remaining: number;
  limit: number;
  start_time?: number;
  end_time?: number;
};

type StoredState = {
  periodKey: string;
  lastCreditStep: number;
  lastPctChunk: number;
};

function statePath(): string {
  return (
    process.env.QUICKNODE_BILLING_ALERT_STATE_PATH ||
    path.join('data', 'quicknode-billing-alert-state.json')
  );
}

function periodKey(s: BillingSummaryForAlerts): string {
  if (s.start_time != null && s.end_time != null) {
    return `${s.start_time}:${s.end_time}`;
  }
  return `fallback:${s.limit}:${Math.floor(Date.now() / (86400 * 1000))}`;
}

function readState(): StoredState | null {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const j = JSON.parse(raw) as StoredState;
    if (j && typeof j.periodKey === 'string') {
      return {
        periodKey: j.periodKey,
        lastCreditStep: typeof j.lastCreditStep === 'number' && j.lastCreditStep >= 0 ? j.lastCreditStep : 0,
        lastPctChunk: typeof j.lastPctChunk === 'number' && j.lastPctChunk >= 0 ? j.lastPctChunk : 0,
      };
    }
  } catch {
    /* */
  }
  return null;
}

function writeState(s: StoredState): void {
  const p = statePath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function everyCredits(): number {
  const n = Number(process.env.QUICKNODE_BILLING_ALERT_EVERY_CREDITS ?? 1_000_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function pctStep(): number {
  const n = Number(process.env.QUICKNODE_BILLING_ALERT_PCT_STEP ?? 0);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0;
}

function milestonesDisabled(): boolean {
  return process.env.QUICKNODE_BILLING_MILESTONES === '0';
}

function isoUtcFromUnixSec(sec?: number): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

/**
 * Отправляет сообщения по всем новым порогам, пересечённым с последней проверки.
 */
export async function emitQuickNodeBillingMilestones(s: BillingSummaryForAlerts): Promise<void> {
  if (milestonesDisabled()) return;

  const stepCred = everyCredits();
  const pct = pctStep();
  if (stepCred <= 0 && pct <= 0) return;

  const pk = periodKey(s);
  let st = readState();
  if (!st || st.periodKey !== pk) {
    st = { periodKey: pk, lastCreditStep: 0, lastPctChunk: 0 };
  }

  const used = Math.max(0, s.credits_used);
  const limit = Math.max(1, s.limit);

  let next = { ...st };
  const pctUsed = ((used / limit) * 100).toFixed(2);
  const periodLine = (() => {
    const a = isoUtcFromUnixSec(s.start_time);
    const b = isoUtcFromUnixSec(s.end_time);
    if (a && b) return ` Биллинг-период (UTC): ${a} → ${b}.`;
    return '';
  })();

  if (stepCred > 0) {
    const reached = Math.floor(used / stepCred);
    while (next.lastCreditStep < reached) {
      next.lastCreditStep += 1;
      const threshold = next.lastCreditStep * stepCred;
      const label =
        stepCred >= 1_000_000
          ? `${(stepCred / 1_000_000).toLocaleString('en-US')} млн`
          : `${stepCred.toLocaleString('en-US')}`;
      const msg =
        `QuickNode: расход по биллинг-периоду достиг ${threshold.toLocaleString('en-US')} credits ` +
        `(шаг ${next.lastCreditStep} × ${label}). Факт ${Math.round(used).toLocaleString('en-US')} из ` +
        `${limit.toLocaleString('en-US')} (${pctUsed}% лимита). Осталось ${Math.round(s.credits_remaining).toLocaleString('en-US')}.${periodLine}`;
      try {
        await sendTagged('ALERT', 'quicknode-milestone', msg);
        await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        log.warn({ err: String(e) }, 'quicknode milestone telegram failed');
      }
    }
  }

  if (pct > 0) {
    const chunk = Math.floor((used * 100) / (limit * pct));
    while (next.lastPctChunk < chunk) {
      next.lastPctChunk += 1;
      const pctNow = next.lastPctChunk * pct;
      const msg =
        `QuickNode: израсходовано ≥ ${pctNow}% общего лимита биллинг-периода ` +
        `(≈ ${((pctNow / 100) * limit).toLocaleString('en-US')} credits из ${limit.toLocaleString('en-US')}). ` +
        `Факт ${Math.round(used).toLocaleString('en-US')} (${pctUsed}%). Осталось ${Math.round(s.credits_remaining).toLocaleString('en-US')}.${periodLine}`;
      try {
        await sendTagged('ALERT', 'quicknode-milestone-pct', msg);
        await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        log.warn({ err: String(e) }, 'quicknode pct milestone telegram failed');
      }
    }
  }

  writeState(next);
}
