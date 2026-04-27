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

const log = child('solana-rpc-meter');

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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
};

type LegacyFile = UsageState & { alertedEarly?: boolean };

function readState(): UsageState {
  const p = usagePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw) as LegacyFile;
    if (j && typeof j.creditsUsed === 'number' && j.month) {
      let last = typeof j.lastAlertedStep === 'number' && j.lastAlertedStep >= 0 ? j.lastAlertedStep : 0;
      if (j.alertedEarly === true && last === 0) {
        last = 1;
      }
      return { month: j.month, creditsUsed: j.creditsUsed, lastAlertedStep: last };
    }
  } catch {
    /* */
  }
  return { month: monthKey(), creditsUsed: 0, lastAlertedStep: 0 };
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

/**
 * Record API credits (QuickNode) after a successful JSON-RPC that counts toward the plan.
 * @param credits — e.g. 30 for a standard Solana call
 */
export async function recordSolanaRpcCredits(credits: number): Promise<void> {
  if (!Number.isFinite(credits) || credits <= 0) return;

  const mk = monthKey();
  const { state: s, alertsToSend } = await withLock(async () => {
    let st = readState();
    if (st.month !== mk) {
      st = { month: mk, creditsUsed: 0, lastAlertedStep: 0 };
    }
    st.creditsUsed += credits;
    const step = stepCredits();
    const cap = maxSteps();
    const reached = Math.min(cap, Math.floor(st.creditsUsed / step));
    const queued: number[] = [];
    while (st.lastAlertedStep < reached) {
      st.lastAlertedStep += 1;
      queued.push(st.lastAlertedStep);
    }
    writeState(st);
    return { state: st, alertsToSend: queued };
  });

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
  log.debug({ creditsAdded: credits, month: s.month, total: s.creditsUsed, step: s.lastAlertedStep }, 'rpc credits recorded');
}

/** Credits per one standard Solana JSON-RPC (QuickNode default 30). */
export function creditsPerStandardSolanaRpc(): number {
  const n = Number(process.env.QUICKNODE_CREDITS_PER_SOLANA_RPC || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
