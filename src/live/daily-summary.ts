/**
 * 1.11.231 — Daily Telegram-сводка по live-oscar.
 *
 * Раз в сутки в час `LIVE_DAILY_SUMMARY_HOUR_MSK` (default 0 = 00:00 MSK) читает последние
 * 24 часа `LIVE_TRADES_PATH` (JSONL) и собирает короткую сводку:
 *   - eval'ов / pass'ов;
 *   - топ блокеров discovery (по частоте в `reasons`);
 *   - buy attempts, confirmed buys;
 *   - sell-успехи и dollar PnL по закрытым позициям за сутки;
 *   - sim_err cooldown rearm'ов;
 *   - priority-fee boost activations.
 *
 * Берёт хвост файла (`LIVE_DAILY_SUMMARY_MAX_BYTES`, default 50 MB) и парсит построчно.
 * При отсутствии записей шлёт «нет данных» сообщение, чтобы было понятно что сервис жив.
 *
 * Внутри использует setInterval / расчёт next-fire-time → одна tick'а в час, дешёво.
 */

import fs from 'node:fs';
import { child } from '../core/logger.js';
import { sendTagged } from '../core/telegram/sender.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { LiveOscarConfig } from './config.js';

const log = child('live-daily-summary');

interface SummaryAggregate {
  evals: number;
  passes: number;
  reasonsTop: Map<string, number>;
  buyAttempts: number;
  buyConfirmed: number;
  sellConfirmed: number;
  simErrCount: number;
  stagedCooldownRearms: number;
  autoDenylistAdds: number;
  priorityFeeBoosts: number;
  closedPositions: number;
  netPnlUsd: number;
  windowMs: { from: number; to: number };
}

function pruneTop(map: Map<string, number>, keep: number): Array<[string, number]> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, keep);
}

/** Безопасный JSON.parse; не падаем на битой строке (JSONL может быть truncated при ротации). */
function safeParse(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const v = JSON.parse(line) as unknown;
    if (v && typeof v === 'object') return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function readTail(absPath: string, maxBytes: number): string {
  if (!fs.existsSync(absPath)) return '';
  const stat = fs.statSync(absPath);
  if (stat.size <= maxBytes) return fs.readFileSync(absPath, 'utf8');
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    const all = buf.toString('utf8');
    /** Cut first partial line. */
    const nl = all.indexOf('\n');
    return nl < 0 ? all : all.slice(nl + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function tsMsFromEvent(ev: Record<string, unknown>): number {
  const t = ev.ts;
  if (typeof t === 'number' && Number.isFinite(t)) return t > 1e12 ? t : t * 1000;
  if (typeof t === 'string') {
    const n = new Date(t).getTime();
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

export function aggregateLiveDaily(args: {
  jsonlPath: string;
  fromMs: number;
  toMs: number;
  maxBytes: number;
}): SummaryAggregate {
  const agg: SummaryAggregate = {
    evals: 0,
    passes: 0,
    reasonsTop: new Map(),
    buyAttempts: 0,
    buyConfirmed: 0,
    sellConfirmed: 0,
    simErrCount: 0,
    stagedCooldownRearms: 0,
    autoDenylistAdds: 0,
    priorityFeeBoosts: 0,
    closedPositions: 0,
    netPnlUsd: 0,
    windowMs: { from: args.fromMs, to: args.toMs },
  };
  const body = readTail(args.jsonlPath, args.maxBytes);
  if (!body) return agg;
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const ev = safeParse(line);
    if (!ev) continue;
    const ts = tsMsFromEvent(ev);
    if (ts < args.fromMs || ts > args.toMs) continue;
    const kind = String(ev.kind ?? '');
    switch (kind) {
      case 'live_discovery_eval': {
        agg.evals += 1;
        if (ev.pass === true) agg.passes += 1;
        const reasons = Array.isArray(ev.reasons) ? (ev.reasons as unknown[]) : [];
        for (const r of reasons) {
          /** Topclass reason без числовых хвостов: `dip_no_window_pass`, `vol5m_below_min`. */
          const key = String(r).split(/[:_]/).slice(0, 4).join('_');
          if (!key) continue;
          agg.reasonsTop.set(key, (agg.reasonsTop.get(key) ?? 0) + 1);
        }
        break;
      }
      case 'execution_attempt': {
        if (ev.side === 'buy') agg.buyAttempts += 1;
        break;
      }
      case 'execution_result': {
        if (ev.status === 'confirmed') {
          /** sell vs buy определяется по предыдущему attempt'е, но для аналитики достаточно total confirmed:
              мы считаем confirmed по mints без side, чтобы не сводить state. */
          if (typeof ev.txSignature === 'string') {
            /** Heuristic: buy = first confirmed для mint'а за сутки, sell = subsequent. Не идеально,
                но без сложного state machine. Альтернатива — смотреть `live_position_*`. */
          }
        }
        if (ev.status === 'sim_err') agg.simErrCount += 1;
        break;
      }
      case 'live_position_open':
      case 'live_position_buy_open': {
        agg.buyConfirmed += 1;
        break;
      }
      case 'live_position_close': {
        agg.closedPositions += 1;
        const pnl = Number(ev.netPnlUsd);
        if (Number.isFinite(pnl)) agg.netPnlUsd += pnl;
        agg.sellConfirmed += 1;
        break;
      }
      case 'live_position_sell':
      case 'live_position_partial_sell':
      case 'live_position_sell_partial': {
        agg.sellConfirmed += 1;
        break;
      }
      case 'live_staged_add_cooldown': {
        agg.stagedCooldownRearms += 1;
        break;
      }
      case 'live_staged_add_auto_denylist': {
        agg.autoDenylistAdds += 1;
        break;
      }
      case 'live_priority_fee_boost': {
        agg.priorityFeeBoosts += 1;
        break;
      }
      default:
        break;
    }
  }
  return agg;
}

export function formatSummaryText(agg: SummaryAggregate): string {
  const top = pruneTop(agg.reasonsTop, 5)
    .map(([k, v]) => `  • ${k}: ${v}`)
    .join('\n');
  const passRate = agg.evals > 0 ? ((agg.passes / agg.evals) * 100).toFixed(2) : '0.00';
  const pnl = agg.netPnlUsd;
  const pnlStr = Number.isFinite(pnl)
    ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`)
    : 'n/a';
  return (
    `Live-Oscar daily summary (24h)\n` +
    `Окно: ${new Date(agg.windowMs.from).toISOString()} → ${new Date(agg.windowMs.to).toISOString()}\n` +
    `\n` +
    `Discovery:\n` +
    `  • evaluated: ${agg.evals}\n` +
    `  • passed: ${agg.passes} (${passRate}%)\n` +
    `  • top blockers:\n${top || '  • (нет данных)'}\n` +
    `\n` +
    `Execution:\n` +
    `  • buy attempts: ${agg.buyAttempts}\n` +
    `  • confirmed buys: ${agg.buyConfirmed}\n` +
    `  • confirmed sells: ${agg.sellConfirmed}\n` +
    `  • closed positions: ${agg.closedPositions}\n` +
    `  • net PnL (на closed): ${pnlStr}\n` +
    `\n` +
    `Health:\n` +
    `  • sim_err total: ${agg.simErrCount}\n` +
    `  • staged-add cooldown rearms: ${agg.stagedCooldownRearms}\n` +
    `  • auto-denylist adds: ${agg.autoDenylistAdds}\n` +
    `  • priority-fee boost activations: ${agg.priorityFeeBoosts}`
  );
}

/** Compute timestamp of next fire-time at given MSK hour from `nowMs`. */
export function nextDailyFireMs(nowMs: number, hourMsk: number): number {
  /** MSK = UTC+3. Конвертируем nowMs → MSK timestamp. */
  const MSK_OFFSET = 3 * 60 * 60 * 1000;
  const mskNow = nowMs + MSK_OFFSET;
  const day = Math.floor(mskNow / (24 * 3600 * 1000));
  const hourMs = hourMsk * 3600 * 1000;
  const todayFireMsk = day * 24 * 3600 * 1000 + hourMs;
  const todayFireUtc = todayFireMsk - MSK_OFFSET;
  if (todayFireUtc > nowMs) return todayFireUtc;
  return todayFireUtc + 24 * 3600 * 1000;
}

let timerHandle: NodeJS.Timeout | null = null;

async function runDailyTick(args: {
  liveCfg: LiveOscarConfig;
  hourMsk: number;
  maxBytes: number;
}): Promise<void> {
  const now = Date.now();
  /** Окно = предыдущие 24 ч до fire-time. */
  const toMs = now;
  const fromMs = now - 24 * 3600 * 1000;
  const agg = aggregateLiveDaily({
    jsonlPath: args.liveCfg.liveTradesPath,
    fromMs,
    toMs,
    maxBytes: args.maxBytes,
  });
  const text = formatSummaryText(agg);
  appendLiveJsonlEvent({
    kind: 'live_daily_summary',
    fromMs,
    toMs,
    evals: agg.evals,
    passes: agg.passes,
    buyAttempts: agg.buyAttempts,
    buyConfirmed: agg.buyConfirmed,
    sellConfirmed: agg.sellConfirmed,
    closedPositions: agg.closedPositions,
    netPnlUsd: agg.netPnlUsd,
    simErrCount: agg.simErrCount,
    stagedCooldownRearms: agg.stagedCooldownRearms,
    autoDenylistAdds: agg.autoDenylistAdds,
    priorityFeeBoosts: agg.priorityFeeBoosts,
    topBlockers: pruneTop(agg.reasonsTop, 10).map(([k, v]) => ({ reason: k, count: v })),
  });
  try {
    const ok = await sendTagged('REPORT', 'live_daily_summary', text, { skipQuietHours: false });
    log.info({ ok }, 'daily summary telegram sent');
  } catch (e) {
    log.warn({ err: String(e) }, 'daily summary telegram failed');
  }
}

function scheduleNext(args: {
  liveCfg: LiveOscarConfig;
  hourMsk: number;
  maxBytes: number;
}): void {
  const now = Date.now();
  const next = nextDailyFireMs(now, args.hourMsk);
  const delay = Math.max(60_000, next - now);
  log.info(
    {
      nextAt: new Date(next).toISOString(),
      delayMs: delay,
      hourMsk: args.hourMsk,
    },
    'daily summary scheduled',
  );
  timerHandle = setTimeout(() => {
    void runDailyTick(args)
      .catch((e) => log.warn({ err: String(e) }, 'daily summary tick failed'))
      .finally(() => scheduleNext(args));
  }, delay);
  /** Не держим event loop живым только из-за этой сводки. */
  timerHandle.unref?.();
}

export function startLiveDailySummary(liveCfg: LiveOscarConfig): void {
  const enabled = (process.env.LIVE_DAILY_SUMMARY_ENABLED ?? '1').trim() !== '0';
  if (!enabled) {
    log.info({}, 'daily summary disabled');
    return;
  }
  const hourMskRaw = Number(process.env.LIVE_DAILY_SUMMARY_HOUR_MSK ?? '0');
  const hourMsk = Number.isFinite(hourMskRaw) && hourMskRaw >= 0 && hourMskRaw < 24 ? Math.floor(hourMskRaw) : 0;
  const maxBytesRaw = Number(process.env.LIVE_DAILY_SUMMARY_MAX_BYTES ?? String(50 * 1024 * 1024));
  const maxBytes =
    Number.isFinite(maxBytesRaw) && maxBytesRaw > 1024 * 1024 ? Math.floor(maxBytesRaw) : 50 * 1024 * 1024;
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
  scheduleNext({ liveCfg, hourMsk, maxBytes });
}

/** Test helper. */
export function _stopLiveDailySummaryForTests(): void {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}
