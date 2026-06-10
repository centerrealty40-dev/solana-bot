import fs from 'node:fs';
import path from 'node:path';

import type { TwapWatchState } from '../detect.js';
import type { HyperliquidMarketCache } from '../hyperliquid-meta.js';
import {
  fetchHlAccountEquityUsd,
  fetchHlClearinghouseMargin,
  fetchHlClearinghousePositions,
  resolveAccountEquityUsd,
} from '../hyperliquid-meta.js';
import { markPxForCoin } from '../paper-trader.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapExchangeClient } from './exchange-client.js';
import { instantCloseLiveTrade } from './chunked-exit-runner.js';
import { flattenCoinOnExchange } from './flatten-position.js';
import {
  appendLiveJournal,
  loadLiveOpensFromJournal,
  loadPendingLiveSchedules,
} from './journal.js';
import { groupOpensByCoinSide } from './coin-side-ladder.js';
import { notifyDrawdownHalt } from './telegram-notify.js';

export type DrawdownStopState = {
  /** Trailing high-water mark (peak equity since process start or manual reset). */
  peakAccountValueUsd: number;
  peakUpdatedAtMs: number;
  halted: boolean;
  haltedAtMs?: number;
  haltReason?: string;
  lastCheckMs?: number;
  lastAccountValueUsd?: number;
  lastDrawdownUsd?: number;
};

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/** USD drawdown from trailing peak that triggers emergency flatten (0 = disabled). */
export function drawdownStopThresholdUsd(): number {
  return Math.max(0, envNum('HL_TWAP_LIVE_DRAWDOWN_STOP_USD', 0));
}

/** Poll interval for equity check (default 60s). */
export function drawdownCheckIntervalMs(): number {
  return Math.max(10_000, envNum('HL_TWAP_LIVE_DRAWDOWN_CHECK_MS', 60_000));
}

export function drawdownStopEnabled(): boolean {
  return drawdownStopThresholdUsd() > 0;
}

export function drawdownStatePath(): string {
  return (
    process.env.HL_TWAP_LIVE_DRAWDOWN_STATE_PATH?.trim() ||
    path.join(process.cwd(), 'data/hl-twap/drawdown-stop.json')
  );
}

/** Drawdown from trailing peak: peak − current (never negative). */
export function computeDrawdownUsd(peakUsd: number, currentEquityUsd: number): number {
  return Math.max(0, peakUsd - currentEquityUsd);
}

/** Raise peak when equity makes a new high-water mark. */
export function updateTrailingPeak(peakUsd: number, currentEquityUsd: number): number {
  return Math.max(peakUsd, currentEquityUsd);
}

export function shouldTriggerDrawdownStop(
  peakUsd: number,
  currentEquityUsd: number,
  thresholdUsd: number,
): boolean {
  if (thresholdUsd <= 0 || peakUsd <= 0) return false;
  return computeDrawdownUsd(peakUsd, currentEquityUsd) >= thresholdUsd;
}

function normalizeLoadedState(raw: Record<string, unknown>): DrawdownStopState | null {
  const peak =
    typeof raw.peakAccountValueUsd === 'number'
      ? raw.peakAccountValueUsd
      : typeof raw.baselineAccountValueUsd === 'number'
        ? raw.baselineAccountValueUsd
        : null;
  if (peak == null) return null;
  const peakUpdatedAtMs =
    typeof raw.peakUpdatedAtMs === 'number'
      ? raw.peakUpdatedAtMs
      : typeof raw.baselineSetAtMs === 'number'
        ? raw.baselineSetAtMs
        : Date.now();
  return {
    peakAccountValueUsd: peak,
    peakUpdatedAtMs,
    halted: raw.halted === true,
    haltedAtMs: typeof raw.haltedAtMs === 'number' ? raw.haltedAtMs : undefined,
    haltReason: typeof raw.haltReason === 'string' ? raw.haltReason : undefined,
    lastCheckMs: typeof raw.lastCheckMs === 'number' ? raw.lastCheckMs : undefined,
    lastAccountValueUsd:
      typeof raw.lastAccountValueUsd === 'number' ? raw.lastAccountValueUsd : undefined,
    lastDrawdownUsd: typeof raw.lastDrawdownUsd === 'number' ? raw.lastDrawdownUsd : undefined,
  };
}

export function loadDrawdownStopState(filePath = drawdownStatePath()): DrawdownStopState | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    return normalizeLoadedState(raw);
  } catch {
    return null;
  }
}

export function saveDrawdownStopState(state: DrawdownStopState, filePath = drawdownStatePath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, 'utf8');
}

export function isTradingHaltedByDrawdown(filePath = drawdownStatePath()): boolean {
  return loadDrawdownStopState(filePath)?.halted === true;
}

export function drawdownHaltBlockReason(filePath = drawdownStatePath()): string | null {
  if (!isTradingHaltedByDrawdown(filePath)) return null;
  return 'drawdown_stop_halted';
}

function cancelAllPendingSchedules(journalPath: string, reason: string): number {
  const pending = loadPendingLiveSchedules(journalPath);
  for (const hash of pending.keys()) {
    appendLiveJournal(journalPath, { kind: 'schedule_cancel', ts: Date.now(), hash, reason });
  }
  return pending.size;
}

/**
 * Initialize trailing-peak monitor on process start.
 * Peak = current equity (high-water mark resets each start unless halted).
 */
export async function initDrawdownMonitor(
  user: string,
  opts?: { clearHalt?: boolean; equityUsd?: number },
): Promise<DrawdownStopState | null> {
  if (!drawdownStopEnabled()) return null;

  const filePath = drawdownStatePath();
  const clearHalt = opts?.clearHalt ?? envBool('HL_TWAP_LIVE_DRAWDOWN_CLEAR_HALT', false);
  const existing = loadDrawdownStopState(filePath);

  if (existing?.halted && !clearHalt) {
    console.warn(
      `[hl-twap-live:drawdown] trading HALTED since ${existing.haltedAtMs ? new Date(existing.haltedAtMs).toISOString() : '?'} — set HL_TWAP_LIVE_DRAWDOWN_CLEAR_HALT=1 to resume`,
    );
    return existing;
  }

  const equity = opts?.equityUsd ?? (await fetchHlAccountEquityUsd(user));
  const state: DrawdownStopState = {
    peakAccountValueUsd: equity,
    peakUpdatedAtMs: Date.now(),
    halted: false,
    lastAccountValueUsd: equity,
    lastDrawdownUsd: 0,
  };
  saveDrawdownStopState(state, filePath);
  const action = clearHalt ? 'peak reset (halt cleared)' : 'peak initialized';
  console.log(
    `[hl-twap-live:drawdown] ${action} peak=$${equity.toFixed(2)} threshold=$${drawdownStopThresholdUsd()} (trailing high-water mark)`,
  );
  return state;
}

/** @deprecated use initDrawdownMonitor */
export const initDrawdownBaseline = initDrawdownMonitor;

async function emergencyFlattenAll(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<void> {
  const cancelled = cancelAllPendingSchedules(cfg.journalPath, 'drawdown_stop');
  if (cancelled > 0) {
    console.log(`[hl-twap-live:drawdown] cancelled ${cancelled} pending schedule(s)`);
  }

  const onExchange = await fetchHlClearinghousePositions(client.accountAddress());
  const flattenedCoins = new Set<string>();
  for (const ex of onExchange) {
    if (flattenedCoins.has(ex.coin)) continue;
    flattenedCoins.add(ex.coin);
    const markPx = markPxForCoin(ex.coin, cache) || ex.entryPx;
    if (markPx <= 0) continue;
    console.log(
      `[hl-twap-live:drawdown] flatten ${ex.displaySymbol} ${ex.side} ~$${ex.notionalUsd.toFixed(0)}`,
    );
    const { flat, remainingAbsSize } = await flattenCoinOnExchange(
      client,
      ex.coin,
      ex.displaySymbol,
      markPx,
      'close',
    );
    appendLiveJournal(cfg.journalPath, {
      kind: 'residual_flatten',
      ts: Date.now(),
      coin: ex.coin,
      displaySymbol: ex.displaySymbol,
      side: ex.side,
      sizeBase: ex.size,
      notionalUsd: ex.notionalUsd,
      flat,
      remainingAbsSize,
    });
    if (!flat) {
      console.error(
        `[hl-twap-live:drawdown] ${ex.displaySymbol} still ${remainingAbsSize.toFixed(6)} base after flatten`,
      );
    }
  }

  const opens = loadLiveOpensFromJournal(cfg.journalPath);
  const books = groupOpensByCoinSide(opens);
  for (const legs of books.values()) {
    const primary = legs.reduce((a, b) => (a.entryTs <= b.entryTs ? a : b));
    const markPx =
      markPxForCoin(primary.coin, cache) ||
      cache.mids.get(primary.displaySymbol) ||
      primary.avgEntryPx;
    if (markPx <= 0) continue;
    await instantCloseLiveTrade(primary.hash, markPx, 'drawdown_stop', cfg, client, watchState);
  }
}

let drawdownTriggerInFlight = false;

/** Periodic equity check; updates trailing peak; triggers flatten when peak − equity ≥ threshold. */
export async function runDrawdownCheck(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<void> {
  if (!drawdownStopEnabled() || client.mode !== 'live') return;

  const filePath = drawdownStatePath();
  const state = loadDrawdownStopState(filePath);
  if (!state) return;
  if (state.halted) return;
  if (drawdownTriggerInFlight) return;

  const threshold = drawdownStopThresholdUsd();
  let equity: number;
  try {
    const [margin, positions] = await Promise.all([
      fetchHlClearinghouseMargin(client.accountAddress()),
      fetchHlClearinghousePositions(client.accountAddress()),
    ]);
    equity = resolveAccountEquityUsd(margin, positions);
  } catch (e) {
    console.warn('[hl-twap-live:drawdown] equity fetch failed', String(e));
    return;
  }

  const prevPeak = state.peakAccountValueUsd;
  const newPeak = updateTrailingPeak(prevPeak, equity);
  if (newPeak > prevPeak) {
    state.peakUpdatedAtMs = Date.now();
  }
  state.peakAccountValueUsd = newPeak;

  const drawdownUsd = computeDrawdownUsd(newPeak, equity);
  state.lastCheckMs = Date.now();
  state.lastAccountValueUsd = equity;
  state.lastDrawdownUsd = drawdownUsd;
  saveDrawdownStopState(state, filePath);

  if (!shouldTriggerDrawdownStop(newPeak, equity, threshold)) {
    return;
  }

  drawdownTriggerInFlight = true;
  try {
    const stopLevel = newPeak - threshold;
    console.error(
      `[hl-twap-live:drawdown] STOP LOSS: peak $${newPeak.toFixed(2)} equity $${equity.toFixed(2)} drawdown $${drawdownUsd.toFixed(2)} >= $${threshold} (stop level $${stopLevel.toFixed(2)})`,
    );

    state.halted = true;
    state.haltedAtMs = Date.now();
    state.haltReason = 'drawdown_stop';
    saveDrawdownStopState(state, filePath);

    await emergencyFlattenAll(cache, cfg, client, watchState);
    await notifyDrawdownHalt({
      peakUsd: newPeak,
      equityUsd: equity,
      drawdownUsd,
      thresholdUsd: threshold,
    });
  } finally {
    drawdownTriggerInFlight = false;
  }
}
