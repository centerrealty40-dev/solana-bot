/**
 * Скользящее окно метрик discovery для Telegram HEALTH и опционально для дашборда (QuickNode hourly).
 *
 * - discovered — строки снимка SQL (кандидаты в лентах).
 * - evaluated — сколько mint прошли троттл реэвал и получили полный eval.
 * - passed — сколько прошли гейты на вход (до safety / impulse / live whitelist и т.д.).
 * - opened — сколько реальных открытий позиции в этом discovery-тике.
 */

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

type Sample = {
  ts: number;
  discovered: number;
  evaluated: number;
  passed: number;
  opened: number;
};

const samples: Sample[] = [];

function windowMs(): number {
  const n = Number(process.env.LIVE_DISCOVERY_HEALTH_WINDOW_MS);
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : DEFAULT_WINDOW_MS;
}

function prune(now: number): void {
  const cutoff = now - windowMs();
  while (samples.length > 0 && samples[0]!.ts < cutoff) {
    samples.shift();
  }
}

export function recordDiscoveryHealthSample(args: {
  ts?: number;
  discovered: number;
  evaluated: number;
  passed: number;
  opened: number;
}): void {
  const ts = args.ts ?? Date.now();
  samples.push({
    ts,
    discovered: Math.max(0, args.discovered),
    evaluated: Math.max(0, args.evaluated),
    passed: Math.max(0, args.passed),
    opened: Math.max(0, args.opened),
  });
  prune(ts);
}

export type DiscoveryHealthSummary = {
  windowMs: number;
  discovered: number;
  evaluated: number;
  gateFail: number;
  opened: number;
  discoveryTicks: number;
};

/** Последний снимок «ждём дип» только для live-oscar (обновляется из `papertrader/main`). */
export type NearReadyDipItem = { mint: string; symbol: string };

let lastNearReadyDipWatchlist: NearReadyDipItem[] = [];

export function updateNearReadyDipWatchlist(items: NearReadyDipItem[]): void {
  lastNearReadyDipWatchlist = items.map((x) => ({
    mint: String(x.mint ?? '').trim(),
    symbol: String(x.symbol ?? '?').trim() || '?',
  }));
}

export function getNearReadyDipWatchlist(): NearReadyDipItem[] {
  return lastNearReadyDipWatchlist;
}

export function discoveryHealthSummaryRolling(): DiscoveryHealthSummary {
  const now = Date.now();
  prune(now);
  let discovered = 0;
  let evaluated = 0;
  let passed = 0;
  let opened = 0;
  for (const s of samples) {
    discovered += s.discovered;
    evaluated += s.evaluated;
    passed += s.passed;
    opened += s.opened;
  }
  return {
    windowMs: windowMs(),
    discovered,
    evaluated,
    gateFail: Math.max(0, evaluated - passed),
    opened,
    discoveryTicks: samples.length,
  };
}

/** Last time a discovery tick finished without throwing (mutex / stall watchdog). */
let lastDiscoveryTickCompletedMs = 0;
let discoverySchedulerStartedMs = 0;
let lastDiscoveryStallAlertMs = 0;

export function markDiscoverySchedulerStarted(ts = Date.now()): void {
  discoverySchedulerStartedMs = ts;
  if (lastDiscoveryTickCompletedMs === 0) lastDiscoveryTickCompletedMs = ts;
}

export function recordDiscoveryTickCompleted(ts = Date.now()): void {
  lastDiscoveryTickCompletedMs = ts;
}

export function discoveryStallThresholdMs(): number {
  const n = Number(process.env.LIVE_DISCOVERY_STALL_ALERT_MS);
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : 5 * 60_000;
}

function discoveryStallBootGraceMs(): number {
  const n = Number(process.env.LIVE_DISCOVERY_STALL_BOOT_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3 * 60_000;
}

function discoveryStallAlertRepeatMs(): number {
  const n = Number(process.env.LIVE_DISCOVERY_STALL_ALERT_REPEAT_MS);
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : 10 * 60_000;
}

export function isDiscoveryStallAlertEnabled(): boolean {
  return process.env.LIVE_DISCOVERY_STALL_ALERT_ENABLED?.trim() !== '0';
}

export type DiscoveryStallStatus = {
  stalled: boolean;
  stallMs: number;
  thresholdMs: number;
  lastTickCompletedMs: number;
};

export function getDiscoveryStallStatus(now = Date.now()): DiscoveryStallStatus {
  const thresholdMs = discoveryStallThresholdMs();
  const started = discoverySchedulerStartedMs > 0 ? discoverySchedulerStartedMs : now;
  const last = lastDiscoveryTickCompletedMs > 0 ? lastDiscoveryTickCompletedMs : started;
  const stallMs = Math.max(0, now - last);
  const inGrace = now - started < discoveryStallBootGraceMs();
  return {
    stalled: isDiscoveryStallAlertEnabled() && !inGrace && stallMs >= thresholdMs,
    stallMs,
    thresholdMs,
    lastTickCompletedMs: last,
  };
}

/** Returns stall status when a new alert should fire (throttled repeat). */
export function shouldEmitDiscoveryStallAlert(now = Date.now()): DiscoveryStallStatus | null {
  const st = getDiscoveryStallStatus(now);
  if (!st.stalled) return null;
  if (now - lastDiscoveryStallAlertMs < discoveryStallAlertRepeatMs()) return null;
  lastDiscoveryStallAlertMs = now;
  return st;
}
