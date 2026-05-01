/**
 * W7.6 — Rolling 6h QuickNode credit ledger for impulse_confirm only.
 * If cumulative credits exceed IMPULSE_QN_ROLLING_MAX_CREDITS (default 1e6): Telegram ALERT + persistent kill file (feature auto-off).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sendTagged } from '../../core/telegram/sender.js';
import { child } from '../../core/logger.js';

const log = child('impulse-qn-rolling');

const WINDOW_MS = 6 * 60 * 60 * 1000;

function rollingPath(): string {
  return process.env.IMPULSE_QN_ROLLING_PATH?.trim() || path.join('data', 'impulse-confirm-qn-rolling.json');
}

function killPath(): string {
  return process.env.IMPULSE_CONFIRM_KILL_PATH?.trim() || path.join('data', 'impulse-confirm-killed.json');
}

export function impulseRollingMaxCredits(): number {
  const raw = Number(process.env.IMPULSE_QN_ROLLING_MAX_CREDITS ?? 1_000_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_000_000;
}

type RollingEntry = { tsMs: number; credits: number; strategyId?: string };

type RollingFile = { entries: RollingEntry[] };

function readRolling(): RollingFile {
  try {
    const raw = fs.readFileSync(rollingPath(), 'utf8');
    const j = JSON.parse(raw) as Partial<RollingFile>;
    if (j && Array.isArray(j.entries)) return { entries: j.entries.filter((e) => e && typeof e.tsMs === 'number') };
  } catch {
    /* */
  }
  return { entries: [] };
}

function writeRolling(f: RollingFile): void {
  const p = rollingPath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ entries: f.entries }, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function prune(now = Date.now()): RollingEntry[] {
  const cut = now - WINDOW_MS;
  return readRolling().entries.filter((e) => e.tsMs >= cut);
}

export function impulseQnRollingSum(now = Date.now()): number {
  return prune(now).reduce((s, e) => s + (Number.isFinite(e.credits) ? Math.max(0, e.credits) : 0), 0);
}

export type KillState = { killedAtMs: number; rollingSumAtKill: number; strategyId?: string };

export function readImpulseKillState(): KillState | null {
  try {
    const raw = fs.readFileSync(killPath(), 'utf8');
    const j = JSON.parse(raw) as Partial<KillState>;
    if (j && typeof j.killedAtMs === 'number') {
      return {
        killedAtMs: j.killedAtMs,
        rollingSumAtKill: typeof j.rollingSumAtKill === 'number' ? j.rollingSumAtKill : 0,
        strategyId: typeof j.strategyId === 'string' ? j.strategyId : undefined,
      };
    }
  } catch {
    /* */
  }
  return null;
}

function writeKill(s: KillState): void {
  const p = killPath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function impulseKillOverrideEnabled(): boolean {
  return process.env.PAPER_IMPULSE_KILL_OVERRIDE === '1';
}

/** Returns false if kill file exists (unless override env). */
export function impulseFeatureAllowedByKillSwitch(): boolean {
  if (impulseKillOverrideEnabled()) return true;
  return readImpulseKillState() === null;
}

/**
 * Before spending credits: false ⇒ caller must skip impulse QN (reason impulse:budget_exceeded or rolling kill).
 * Allows a call while current sum is strictly below the cap even if this call pushes cumulative over the cap —
 * `recordImpulseQnCredits` then fires Telegram + kill (rolling window exceeds norm).
 */
export function canSpendImpulseQnCredits(cost: number, _strategyId: string, now = Date.now()): boolean {
  if (!impulseFeatureAllowedByKillSwitch()) return false;
  if (!(Number.isFinite(cost) && cost > 0)) return true;
  const max = impulseRollingMaxCredits();
  const sum = impulseQnRollingSum(now);
  return sum < max;
}

async function fireKillTelegram(strategyId: string, sum: number, max: number): Promise<void> {
  const text = [
    `Impulse confirm QuickNode rolling 6h budget exceeded.`,
    `strategyId=${strategyId}`,
    `rollingSumCredits=${sum}`,
    `limit=${max}`,
    `Impulse confirm RPC path disabled until ${killPath()} is removed or PAPER_IMPULSE_KILL_OVERRIDE=1.`,
  ].join('\n');
  try {
    await sendTagged('ALERT', 'impulse-qn-kill', text);
  } catch (e) {
    log.warn({ err: String(e) }, 'impulse kill telegram failed');
  }
}

/**
 * Record successful QN consumption for impulse path; may write kill file + telegram when over limit.
 */
export async function recordImpulseQnCredits(credits: number, strategyId: string, now = Date.now()): Promise<void> {
  if (!(Number.isFinite(credits) && credits > 0)) return;
  const max = impulseRollingMaxCredits();
  let entries = prune(now);
  entries.push({ tsMs: now, credits, strategyId });
  const sum = entries.reduce((s, e) => s + e.credits, 0);
  writeRolling({ entries });

  if (sum >= max && !readImpulseKillState()) {
    writeKill({ killedAtMs: now, rollingSumAtKill: sum, strategyId });
    log.error({ sum, max, strategyId }, 'impulse confirm QN rolling budget exceeded — killed');
    await fireKillTelegram(strategyId, sum, max);
  }
}
