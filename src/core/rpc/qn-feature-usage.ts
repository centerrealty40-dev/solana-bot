/**
 * Per-feature QuickNode credit buckets (month/day/hour) for qn-client.
 * Rolling month key matches solana-rpc-meter (UTC YYYY-MM).
 */
import fs from 'node:fs';
import path from 'node:path';
import { child } from '../logger.js';
import { hourKeyUtc } from './solana-rpc-meter.js';

const log = child('qn-feature-usage');

export const QN_FEATURE_KEYS = [
  'safety',
  'pri_fee',
  'price_verify',
  'sim',
  /** W8.0 Phase 6 — sendTransaction + signature polling for live-oscar. */
  'live_send',
  'liq_watch',
  'holders',
  /** W7.6 — impulse confirm on-chain spot (Orca whirlpool + optional paths). */
  'impulse_confirm',
] as const;
export type QnFeature = (typeof QN_FEATURE_KEYS)[number];

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKeyUtc(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function featureUsagePath(): string {
  return process.env.QN_FEATURE_USAGE_PATH || path.join('data', 'qn-feature-usage.json');
}

type FeatureSlice = {
  monthCredits: number;
  dayUtc: string;
  dayCredits: number;
  hourUtc: string;
  hourCredits: number;
};

export type QnFeatureUsageFile = {
  month: string;
  perFeature: Record<QnFeature, FeatureSlice>;
};

const BUDGET_ENV: Record<QnFeature, string> = {
  safety: 'QN_FEATURE_BUDGET_SAFETY',
  pri_fee: 'QN_FEATURE_BUDGET_PRI_FEE',
  price_verify: 'QN_FEATURE_BUDGET_PRICE_VERIFY',
  sim: 'QN_FEATURE_BUDGET_SIM',
  live_send: 'QN_FEATURE_BUDGET_LIVE_SEND',
  liq_watch: 'QN_FEATURE_BUDGET_LIQ_WATCH',
  holders: 'QN_FEATURE_BUDGET_HOLDERS',
  impulse_confirm: 'QN_FEATURE_BUDGET_IMPULSE_CONFIRM',
};

const DEFAULT_BUDGET: Record<QnFeature, number> = {
  safety: 1_000_000,
  pri_fee: 2_000_000,
  price_verify: 4_000_000,
  sim: 6_000_000,
  live_send: 4_000_000,
  liq_watch: 12_000_000,
  holders: 10_000_000,
  /** Monthly cap for impulse confirm QN calls (rolling 6h kill is separate; see impulse-qn-rolling). */
  impulse_confirm: 5_000_000,
};

export function qnFeatureBudgetMonth(f: QnFeature): number {
  const raw = Number(process.env[BUDGET_ENV[f]] ?? DEFAULT_BUDGET[f]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BUDGET[f];
}

function emptySlice(): FeatureSlice {
  const d = dayKeyUtc();
  const h = hourKeyUtc();
  return { monthCredits: 0, dayUtc: d, dayCredits: 0, hourUtc: h, hourCredits: 0 };
}

function defaultFile(): QnFeatureUsageFile {
  const perFeature = {} as Record<QnFeature, FeatureSlice>;
  for (const k of QN_FEATURE_KEYS) perFeature[k] = emptySlice();
  return { month: monthKey(), perFeature };
}

function readFile(): QnFeatureUsageFile {
  const p = featureUsagePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw) as Partial<QnFeatureUsageFile>;
    if (j && typeof j.month === 'string' && j.perFeature && typeof j.perFeature === 'object') {
      const base = defaultFile();
      base.month = j.month;
      for (const k of QN_FEATURE_KEYS) {
        const s = j.perFeature[k] as Partial<FeatureSlice> | undefined;
        if (s && typeof s.monthCredits === 'number') {
          base.perFeature[k] = {
            monthCredits: Math.max(0, s.monthCredits),
            dayUtc: typeof s.dayUtc === 'string' && s.dayUtc.length >= 8 ? s.dayUtc : dayKeyUtc(),
            dayCredits: typeof s.dayCredits === 'number' && s.dayCredits >= 0 ? s.dayCredits : 0,
            hourUtc: typeof s.hourUtc === 'string' && s.hourUtc.length >= 10 ? s.hourUtc : hourKeyUtc(),
            hourCredits: typeof s.hourCredits === 'number' && s.hourCredits >= 0 ? s.hourCredits : 0,
          };
        }
      }
      return rolloverFile(base);
    }
  } catch {
    /* */
  }
  return defaultFile();
}

function rolloverSlice(s: FeatureSlice, fileMonth: string): FeatureSlice {
  const mk = monthKey();
  const dk = dayKeyUtc();
  const hk = hourKeyUtc();
  let next = { ...s };
  if (fileMonth !== mk) {
    next = { monthCredits: 0, dayUtc: dk, dayCredits: 0, hourUtc: hk, hourCredits: 0 };
    return next;
  }
  if (next.dayUtc !== dk) {
    next = { ...next, dayUtc: dk, dayCredits: 0 };
  }
  if (next.hourUtc !== hk) {
    next = { ...next, hourUtc: hk, hourCredits: 0 };
  }
  return next;
}

function rolloverFile(f: QnFeatureUsageFile): QnFeatureUsageFile {
  const mk = monthKey();
  let month = f.month;
  const perFeature = { ...f.perFeature };
  if (month !== mk) {
    month = mk;
    for (const k of QN_FEATURE_KEYS) {
      perFeature[k] = emptySlice();
    }
    return { month, perFeature };
  }
  for (const k of QN_FEATURE_KEYS) {
    perFeature[k] = rolloverSlice(perFeature[k], month);
  }
  return { month, perFeature };
}

function writeFile(f: QnFeatureUsageFile): void {
  const p = featureUsagePath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const p = featureUsagePath();
  const lockPath = `${p}.lock`;
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + 1500;
  let fd: number | null = null;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
      break;
    } catch {
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 5000) fs.unlinkSync(lockPath);
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
      try {
        fs.closeSync(fd);
      } catch {
        /* */
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* */
    }
  }
}

/**
 * Try to reserve credits for one feature (month cap only — day/hour tracked for snapshot).
 */
export async function reserveQnFeatureCredits(feature: QnFeature, credits: number): Promise<boolean> {
  if (!Number.isFinite(credits) || credits <= 0) return true;
  return withLock(() => {
    let f = readFile();
    f = rolloverFile(f);
    const cap = qnFeatureBudgetMonth(feature);
    const slice = f.perFeature[feature];
    if (slice.monthCredits + credits > cap) {
      log.warn({ feature, cap, used: slice.monthCredits, requested: credits }, 'qn feature monthly budget exceeded');
      writeFile(f);
      return false;
    }
    const nextSlice: FeatureSlice = {
      ...slice,
      monthCredits: slice.monthCredits + credits,
      dayCredits: slice.dayCredits + credits,
      hourCredits: slice.hourCredits + credits,
    };
    f = { ...f, perFeature: { ...f.perFeature, [feature]: nextSlice } };
    writeFile(f);
    return true;
  });
}

export async function releaseQnFeatureCredits(feature: QnFeature, credits: number): Promise<void> {
  if (!Number.isFinite(credits) || credits <= 0) return;
  await withLock(() => {
    let f = readFile();
    f = rolloverFile(f);
    const slice = f.perFeature[feature];
    const nextSlice: FeatureSlice = {
      ...slice,
      monthCredits: Math.max(0, slice.monthCredits - credits),
      dayCredits: Math.max(0, slice.dayCredits - credits),
      hourCredits: Math.max(0, slice.hourCredits - credits),
    };
    f = { ...f, perFeature: { ...f.perFeature, [feature]: nextSlice } };
    writeFile(f);
  });
}

export function readQnFeatureUsageForSnapshot(): QnFeatureUsageFile {
  return rolloverFile(readFile());
}
