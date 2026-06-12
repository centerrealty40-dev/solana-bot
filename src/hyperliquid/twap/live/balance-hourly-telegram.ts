import {
  fetchHlClearinghouseMargin,
  fetchHlClearinghousePositions,
  resolveAccountEquityUsd,
} from '../hyperliquid-meta.js';
import { loadDrawdownStopState } from './drawdown-stop.js';

export const BALANCE_HOURLY_MS = 60 * 60 * 1000;

/** Hourly HL Total Balance ping to whale Telegram chat (default on when live enabled). */
export function balanceHourlyTelegramEnabled(liveEnabled = false): boolean {
  const v = process.env.HL_TWAP_BALANCE_HOURLY_TELEGRAM?.trim();
  if (v === '0' || v?.toLowerCase() === 'false' || v?.toLowerCase() === 'no') return false;
  if (v === '1' || v?.toLowerCase() === 'true' || v?.toLowerCase() === 'yes') return true;
  return liveEnabled;
}

/** Ms until next UTC hour boundary (skip immediate ping on process start). */
export function msUntilNextHourBoundary(nowMs: number): number {
  const d = new Date(nowMs);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1));
  const delta = next.getTime() - nowMs;
  return delta > 0 ? delta : BALANCE_HOURLY_MS;
}

export function formatUsdBalance(v: number): string {
  if (!Number.isFinite(v)) return '?';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type BalanceHourlySnapshot = {
  equityUsd: number;
  peakUsd?: number;
  openPositions: number;
};

function pluralPositionsRu(n: number): string {
  const m = Math.abs(Math.round(n)) % 100;
  const m10 = m % 10;
  if (m10 === 1 && m !== 11) return 'позиция';
  if (m10 >= 2 && m10 <= 4 && (m < 10 || m >= 20)) return 'позиции';
  return 'позиций';
}

/** Russian-friendly hourly balance line(s) for Telegram. */
export function formatBalanceHourlyMessage(snap: BalanceHourlySnapshot): string {
  const lines = [`💰 HL Total Balance: ${formatUsdBalance(snap.equityUsd)}`];
  if (snap.peakUsd != null && Number.isFinite(snap.peakUsd) && snap.peakUsd > snap.equityUsd + 0.005) {
    lines.push(`📈 Пик: ${formatUsdBalance(snap.peakUsd)}`);
  }
  const n = snap.openPositions;
  if (Number.isFinite(n) && n >= 0) {
    lines.push(`📊 Открыто: ${n} ${pluralPositionsRu(n)}`);
  }
  return lines.join('\n');
}

export async function fetchBalanceHourlySnapshot(user: string): Promise<BalanceHourlySnapshot> {
  const [margin, positions] = await Promise.all([
    fetchHlClearinghouseMargin(user),
    fetchHlClearinghousePositions(user),
  ]);
  const equityUsd = resolveAccountEquityUsd(margin, positions);
  const peakUsd = loadDrawdownStopState()?.peakAccountValueUsd;
  return {
    equityUsd,
    peakUsd: peakUsd != null && peakUsd > 0 ? peakUsd : undefined,
    openPositions: positions.length,
  };
}

export type BalanceHourlyTelegramOpts = {
  user: string;
  send: (text: string) => Promise<void>;
  dryRun?: boolean;
  nowMs?: () => number;
  log?: (msg: string) => void;
};

/** Schedule hourly balance ping aligned to UTC hour; no message on startup. */
export function startBalanceHourlyTelegram(opts: BalanceHourlyTelegramOpts): { stop: () => void } {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let hourlyTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const deliver = async (): Promise<void> => {
    if (stopped) return;
    try {
      const snap = await fetchBalanceHourlySnapshot(opts.user);
      const text = formatBalanceHourlyMessage(snap);
      if (opts.dryRun) {
        log(`[hl-twap-telegram-watch] DRY_RUN balance hourly:\n${text}`);
        return;
      }
      await opts.send(text);
      log(`[hl-twap-telegram-watch] balance hourly sent equity=$${snap.equityUsd.toFixed(2)}`);
    } catch (e) {
      log(`[hl-twap-telegram-watch] balance hourly failed ${String(e)}`);
    }
  };

  const firstDelay = msUntilNextHourBoundary(nowMs());
  log(`[hl-twap-telegram-watch] balance hourly telegram first in ${Math.round(firstDelay / 1000)}s`);
  initialTimer = setTimeout(() => {
    initialTimer = null;
    if (stopped) return;
    void deliver();
    hourlyTimer = setInterval(() => {
      void deliver();
    }, BALANCE_HOURLY_MS);
  }, firstDelay);

  return {
    stop: () => {
      stopped = true;
      if (initialTimer != null) clearTimeout(initialTimer);
      if (hourlyTimer != null) clearInterval(hourlyTimer);
    },
  };
}
