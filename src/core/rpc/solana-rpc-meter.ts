/**
 * Client-side metering for QuickNode (or any) Solana HTTPS JSON-RPC.
 * QuickNode Solana standard methods ≈ 30 API credits each (see quicknode.com/api-credits/solana).
 *
 * Sends a Telegram for **each** new step: ALERT_PCT% of the monthly budget (5%, 10%, 15%… up to 100%),
 * not only the first. If a single `record` jumps several steps, you get one message per crossed step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { child } from '../logger.js';
import { sendTagged } from '../telegram/sender.js';
import { readProviderDailyCache } from './quicknode-provider-usage.js';

const log = child('solana-rpc-meter');

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKeyUtc(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Current UTC hour bucket, e.g. `2026-05-01T07`. */
export function hourKeyUtc(d = new Date()): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}`;
}

function usagePath(): string {
  return process.env.QUICKNODE_USAGE_PATH || path.join('data', 'quicknode-usage.json');
}

export function defaultSolanaRpcUrl(): string {
  const u =
    process.env.SOLANA_RPC_HTTP_URL ||
    process.env.QUICKNODE_HTTP_URL ||
    process.env.ALCHEMY_HTTP_URL ||
    '';
  return u.trim();
}

type UsageState = {
  month: string;
  creditsUsed: number;
  /**
   * How many ALERT_PCT-sized buckets we already sent Telegram for (1 = first 5% if ALERT_PCT=5, …, 20 = 100%).
   */
  lastAlertedStep: number;
  /** UTC calendar day (YYYY-MM-DD) for creditsUsedDay. */
  dayUtc: string;
  /** Credits consumed on dayUtc (QuickNode-style units, same as creditsUsed). */
  creditsUsedDay: number;
  /** Last UTC day we sent the “daily cap reached” Telegram (at most once per day). */
  lastDailyBlockedAlertDayUtc?: string;
  /** Current UTC hour bucket (YYYY-MM-DDTHH) for creditsUsedHour. */
  hourUtc: string;
  /** Credits consumed in hourUtc. */
  creditsUsedHour: number;
  /** Last hour bucket we sent the hourly-cap Telegram (at most once per that hour). */
  lastHourlyBlockedAlertHourUtc?: string;
};

type LegacyFile = Partial<UsageState> & { alertedEarly?: boolean };

function readState(): UsageState {
  const p = usagePath();
  const today = dayKeyUtc();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw) as LegacyFile;
    if (j && typeof j.creditsUsed === 'number' && j.month) {
      let last = typeof j.lastAlertedStep === 'number' && j.lastAlertedStep >= 0 ? j.lastAlertedStep : 0;
      if (j.alertedEarly === true && last === 0) {
        last = 1;
      }
      const dayUtc = typeof j.dayUtc === 'string' && j.dayUtc.length >= 8 ? j.dayUtc : today;
      let creditsUsedDay = typeof j.creditsUsedDay === 'number' && j.creditsUsedDay >= 0 ? j.creditsUsedDay : 0;
      if (dayUtc !== today) {
        creditsUsedDay = 0;
      }
      const lastDailyBlockedAlertDayUtc =
        typeof j.lastDailyBlockedAlertDayUtc === 'string' ? j.lastDailyBlockedAlertDayUtc : undefined;
      const hk = hourKeyUtc();
      let hourUtc = typeof j.hourUtc === 'string' && j.hourUtc.length >= 13 ? j.hourUtc : hk;
      let creditsUsedHour = typeof j.creditsUsedHour === 'number' && j.creditsUsedHour >= 0 ? j.creditsUsedHour : 0;
      if (hourUtc !== hk) {
        hourUtc = hk;
        creditsUsedHour = 0;
      }
      const lastHourlyBlockedAlertHourUtc =
        typeof j.lastHourlyBlockedAlertHourUtc === 'string' ? j.lastHourlyBlockedAlertHourUtc : undefined;
      return {
        month: j.month,
        creditsUsed: j.creditsUsed,
        lastAlertedStep: last,
        dayUtc: today,
        creditsUsedDay,
        lastDailyBlockedAlertDayUtc,
        hourUtc,
        creditsUsedHour,
        lastHourlyBlockedAlertHourUtc,
      };
    }
  } catch {
    /* */
  }
  return {
    month: monthKey(),
    creditsUsed: 0,
    lastAlertedStep: 0,
    dayUtc: today,
    creditsUsedDay: 0,
    hourUtc: hourKeyUtc(),
    creditsUsedHour: 0,
  };
}

function writeState(s: UsageState): void {
  const p = usagePath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** Простой lock через файл с O_EXCL — на pm2-кластерах гонки между recordSolanaRpcCredits станут безопаснее. */
async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const p = usagePath();
  const lockPath = `${p}.lock`;
  const dir = path.dirname(p);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }
  const deadline = Date.now() + 1500;
  let fd: number | null = null;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
      break;
    } catch {
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 5000) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        /* */
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* */ }
    }
    try { fs.unlinkSync(lockPath); } catch { /* */ }
  }
}

function budgetCredits(): number {
  return Math.max(1, Number(process.env.QUICKNODE_MONTHLY_CREDIT_BUDGET || 80_000_000));
}

/** Hard daily ceiling for billable credits (QuickNode). Default 3M/day. */
function dailyBudgetCredits(): number {
  return Math.max(1, Number(process.env.QUICKNODE_DAILY_CREDIT_BUDGET || 3_000_000));
}

/** Hourly ceiling; 0 or unset = enforcement off. */
function hourlyBudgetCredits(): number {
  return Math.max(0, Number(process.env.QUICKNODE_HOURLY_CREDIT_BUDGET || 0));
}

function dailyEnforce(): boolean {
  return process.env.QUICKNODE_DAILY_ENFORCE !== '0';
}

/**
 * Сверхдневной бюджет по данным Admin API (все каналы), если в кэше свежий снимок.
 * Вкл.: QUICKNODE_DAILY_ENFORCE_PROVIDER=1 + опрос /data/quicknode-provider-daily.json (см. sa-stream).
 */
function getProviderBlockSnapshot(credits: number): { used: number } | null {
  if (process.env.QUICKNODE_DAILY_ENFORCE_PROVIDER !== '1') return null;
  const maxAge = Math.max(30_000, Number(process.env.QUICKNODE_PROVIDER_CACHE_MAX_AGE_MS || 900_000));
  const c = readProviderDailyCache();
  const today = dayKeyUtc();
  if (!c || c.dayUtc !== today) return null;
  if (Date.now() - c.polledAtMs > maxAge) return null;
  const cap = dailyBudgetCredits();
  if (c.providerCreditsUsed + credits > cap) {
    return { used: c.providerCreditsUsed };
  }
  return null;
}

function alertPct(): number {
  const v = Number(process.env.QUICKNODE_ALERT_PCT || 5);
  return v > 0 && v <= 100 ? v : 5;
}

/** One “step” in credits (e.g. 5% of 80M = 4M if ALERT_PCT=5). */
function stepCredits(): number {
  return Math.max(1, Math.floor((budgetCredits() * alertPct()) / 100));
}

function maxSteps(): number {
  return Math.max(1, Math.floor(100 / alertPct()));
}

async function sendTelegram(text: string): Promise<void> {
  if (process.env.QUICKNODE_TELEGRAM_ALERTS === '0') return;
  await sendTagged('ALERT', 'rpc', text);
}

function rolloverCalendarFields(st: UsageState): UsageState {
  const mk = monthKey();
  const dk = dayKeyUtc();
  const hk = hourKeyUtc();
  let next = { ...st };
  if (next.month !== mk) {
    next = { ...next, month: mk, creditsUsed: 0, lastAlertedStep: 0 };
  }
  if (next.dayUtc !== dk) {
    next = { ...next, dayUtc: dk, creditsUsedDay: 0 };
  }
  if (next.hourUtc !== hk) {
    next = { ...next, hourUtc: hk, creditsUsedHour: 0 };
  }
  return next;
}

function applyCreditsLocked(st: UsageState, credits: number): { state: UsageState; alertsToSend: number[] } {
  let next = rolloverCalendarFields(st);
  next.creditsUsed += credits;
  next.creditsUsedDay += credits;
  next.creditsUsedHour += credits;
  const step = stepCredits();
  const cap = maxSteps();
  const reached = Math.min(cap, Math.floor(next.creditsUsed / step));
  const queued: number[] = [];
  while (next.lastAlertedStep < reached) {
    next.lastAlertedStep += 1;
    queued.push(next.lastAlertedStep);
  }
  writeState(next);
  return { state: next, alertsToSend: queued };
}

async function fireMonthlyAlerts(s: UsageState, alertsToSend: number[]): Promise<void> {
  for (const n of alertsToSend) {
    const limit = budgetCredits();
    const step = stepCredits();
    const pct = n * alertPct();
    const creditsAtStep = n * step;
    const msg =
      `QuickNode usage: ${pct}% месячного лимита (≈${creditsAtStep.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} credits). ` +
      `Факт ${Math.round(s.creditsUsed).toLocaleString('en-US')} за ${s.month}. Проверь дашборд.`;
    try {
      await sendTelegram(msg);
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      log.warn({ err: String(e) }, 'telegram alert failed');
    }
  }
}

/**
 * In-memory rollover + current counters (for dashboards). Does not write the usage file.
 */
export function solanaRpcMeterCounters(): {
  month: string;
  monthCredits: number;
  dayUtc: string;
  dayCredits: number;
  hourUtc: string;
  hourCredits: number;
  budgets: { month: number; day: number; hour: number };
} {
  const st = rolloverCalendarFields(readState());
  return {
    month: st.month,
    monthCredits: st.creditsUsed,
    dayUtc: st.dayUtc,
    dayCredits: st.creditsUsedDay,
    hourUtc: st.hourUtc,
    hourCredits: st.creditsUsedHour,
    budgets: {
      month: budgetCredits(),
      day: dailyBudgetCredits(),
      hour: hourlyBudgetCredits(),
    },
  };
}

/**
 * Reserve credits **before** a billable JSON-RPC. Returns false when a budget would be exceeded
 * (provider/daily/hourly caps). Call {@link releaseSolanaRpcCredits} if the request fails
 * and QuickNode should not charge this batch.
 */
export async function reserveSolanaRpcCredits(credits: number): Promise<boolean> {
  if (!Number.isFinite(credits) || credits <= 0) return true;

  let dailyBlockTelegram: string | null = null;
  let hourlyBlockTelegram: string | null = null;

  const { state: s, alertsToSend, blocked } = await withLock(async () => {
    let st = readState();
    st = rolloverCalendarFields(st);
    const dailyCap = dailyBudgetCredits();
    const prov = getProviderBlockSnapshot(credits);
    if (prov) {
      log.warn(
        {
          providerCreditsUsed: prov.used,
          requested: credits,
          dailyCap,
        },
        'quicknode daily budget (provider API cache) would be exceeded — blocking HTTP RPC',
      );
      return { state: st, alertsToSend: [] as number[], blocked: true };
    }
    if (dailyEnforce() && st.creditsUsedDay + credits > dailyCap) {
      log.warn(
        {
          creditsUsedDay: st.creditsUsedDay,
          dailyCap,
          requested: credits,
          dayUtc: st.dayUtc,
        },
        'quicknode daily credit budget exceeded — blocking RPC batch',
      );
      const dk = dayKeyUtc();
      if (st.lastDailyBlockedAlertDayUtc !== dk) {
        st = { ...st, lastDailyBlockedAlertDayUtc: dk };
        writeState(st);
        dailyBlockTelegram =
          `QuickNode: достигнут дневной лимит кредитов (${dailyCap.toLocaleString('en-US')} / day UTC). ` +
          `Использовано сегодня ≈${Math.round(st.creditsUsedDay).toLocaleString('en-US')}. Платные RPC-запросы блокируются до следующего UTC-дня.`;
      }
      return { state: st, alertsToSend: [] as number[], blocked: true };
    }
    const hourlyCap = hourlyBudgetCredits();
    if (hourlyCap > 0 && st.creditsUsedHour + credits > hourlyCap) {
      log.warn(
        {
          creditsUsedHour: st.creditsUsedHour,
          hourlyCap,
          requested: credits,
          hourUtc: st.hourUtc,
        },
        'quicknode hourly credit budget exceeded — blocking RPC batch',
      );
      const hk = hourKeyUtc();
      if (st.lastHourlyBlockedAlertHourUtc !== hk) {
        st = { ...st, lastHourlyBlockedAlertHourUtc: hk };
        writeState(st);
        hourlyBlockTelegram =
          `QuickNode: достигнут часовой лимит ${hourlyCap} credits (${hk} UTC). ` +
          `Платные RPC заблокированы до начала следующего часа.`;
      }
      return { state: st, alertsToSend: [] as number[], blocked: true };
    }
    const { state, alertsToSend } = applyCreditsLocked(st, credits);
    return { state, alertsToSend, blocked: false };
  });

  if (dailyBlockTelegram) {
    try {
      await sendTelegram(dailyBlockTelegram);
    } catch (e) {
      log.warn({ err: String(e) }, 'telegram daily-cap alert failed');
    }
  }

  if (hourlyBlockTelegram) {
    try {
      if (process.env.QUICKNODE_TELEGRAM_ALERTS !== '0') {
        await sendTagged('ALERT', 'quicknode-hourly-cap', hourlyBlockTelegram);
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'telegram hourly-cap alert failed');
    }
  }

  if (blocked) return false;
  await fireMonthlyAlerts(s, alertsToSend);
  log.debug(
    {
      creditsReserved: credits,
      month: s.month,
      total: s.creditsUsed,
      creditsUsedDay: s.creditsUsedDay,
      dayUtc: s.dayUtc,
    },
    'rpc credits reserved',
  );
  return true;
}

/** Roll back a reservation when the HTTP/RPC call did not succeed or should not be billed. */
export async function releaseSolanaRpcCredits(credits: number): Promise<void> {
  if (!Number.isFinite(credits) || credits <= 0) return;
  await withLock(async () => {
    let st = readState();
    st = rolloverCalendarFields(st);
    st.creditsUsed = Math.max(0, st.creditsUsed - credits);
    st.creditsUsedDay = Math.max(0, st.creditsUsedDay - credits);
    st.creditsUsedHour = Math.max(0, st.creditsUsedHour - credits);
    writeState(st);
  });
  log.debug({ creditsReleased: credits }, 'rpc credits released');
}

/**
 * Record API credits (QuickNode) after a successful JSON-RPC that counts toward the plan.
 * @param credits — e.g. 30 for a standard Solana call
 */
export async function recordSolanaRpcCredits(credits: number): Promise<void> {
  if (!Number.isFinite(credits) || credits <= 0) return;
  const ok = await reserveSolanaRpcCredits(credits);
  if (!ok) {
    log.warn({ credits }, 'recordSolanaRpcCredits: daily budget full — not recording');
  }
}

/** Credits per one standard Solana JSON-RPC (QuickNode default 30). */
export function creditsPerStandardSolanaRpc(): number {
  const n = Number(process.env.QUICKNODE_CREDITS_PER_SOLANA_RPC || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
