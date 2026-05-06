/**
 * Telegram: Jupiter / live-tracker ценообразование.
 *
 * Схема для оператора (первая строка каждого сообщения):
 * - `severity=INFO` + `investigate_product=NO` — штатный шум тонких рынков, решения уже по Jupiter.
 * - `severity=ACTION` + `investigate_product=YES` — нужен разбор (fallback на PG или инфраструктура Jupiter).
 *
 * Env:
 * - `LIVE_JUPITER_TRACKER_TELEGRAM=0` — выкл. алерты трекера (fallback PG / расхождение с Jupiter).
 * - `JUPITER_QUOTE_CIRCUIT_TELEGRAM=0` — выкл. алерт при открытии circuit breaker (price-verify).
 * - `LIVE_JUPITER_TRACKER_TG_THROTTLE_MS` — мин. интервал между одинаковыми алертами по одному mint (default 300000).
 * Дополнительно можно задать `TELEGRAM_COOLDOWN_ALERT_<SUBTAG>_MS` для sendTagged (см. sender.ts).
 */
import { sendTagged } from './sender.js';

const TRACKER_ON = process.env.LIVE_JUPITER_TRACKER_TELEGRAM !== '0';
const CIRCUIT_ON = process.env.JUPITER_QUOTE_CIRCUIT_TELEGRAM !== '0';

const throttleDefaultMs = Math.max(
  60_000,
  Math.min(3_600_000, Number(process.env.LIVE_JUPITER_TRACKER_TG_THROTTLE_MS ?? 300_000)),
);
const lastSentMs = new Map<string, number>();

function shouldThrottle(key: string, ms: number): boolean {
  const now = Date.now();
  const last = lastSentMs.get(key) ?? 0;
  if (now - last < ms) return true;
  lastSentMs.set(key, now);
  return false;
}

/** Трекер live: котировка Jupiter не получена — решения по TP/trail на этом тике из PG snapshot. */
export async function notifyLiveTrackerJupiterFallback(args: {
  strategyId: string;
  mint: string;
  symbol: string;
  snapshotPx: number;
  probeUsd: number;
  solUsd: number;
  dexSource?: string;
  reason: 'quote-null' | 'jupiter-price-null' | 'exception';
  errorMessage?: string;
}): Promise<void> {
  if (!TRACKER_ON) return;
  const key = `fb:${args.mint}`;
  if (shouldThrottle(key, throttleDefaultMs)) return;

  const lines = [
    'severity=ACTION  investigate_product=YES',
    '',
    'Причина: Jupiter SOL→token probe не удался; на этом тике TP / peak / trail / scale-in считаются по PG snapshot (риск расхождения с исполнением).',
    'Что делать: проверить доступность Jupiter API, RPC, лимиты и логи live-oscar вокруг tsUtc.',
    '',
    `strategyId=${args.strategyId}`,
    `symbol=${args.symbol}`,
    `mint=${args.mint}`,
    `dex=${args.dexSource ?? 'unknown'}`,
    `snapshotUsdPerToken=${args.snapshotPx.toFixed(10)}`,
    `probeUsd=${args.probeUsd.toFixed(4)} solUsd=${args.solUsd.toFixed(6)}`,
    `reason=${args.reason}`,
  ];
  if (args.errorMessage) lines.push(`error=${args.errorMessage.slice(0, 800)}`);
  lines.push(`tsUtc=${new Date().toISOString()}`);

  await sendTagged('ALERT', 'live-jupiter-tracker-fallback', lines.join('\n'));
}

/** Трекер live: PG vs Jupiter tradable заметно разошлись; решения уже по Jupiter — см. severity=INFO в тексте. */
export async function notifyLiveTrackerSnapshotJupiterDivergence(args: {
  strategyId: string;
  mint: string;
  symbol: string;
  snapshotPx: number;
  jupiterPx: number;
  divergePct: number;
  probeUsd: number;
  avgEntryMarket?: number;
}): Promise<void> {
  if (!TRACKER_ON) return;
  const key = `div:${args.mint}`;
  if (shouldThrottle(key, throttleDefaultMs)) return;

  const xSnap = args.avgEntryMarket && args.avgEntryMarket > 0 ? args.snapshotPx / args.avgEntryMarket : null;
  const xJup = args.avgEntryMarket && args.avgEntryMarket > 0 ? args.jupiterPx / args.avgEntryMarket : null;

  const lines = [
    'severity=INFO  investigate_product=NO',
    '',
    'Это не признак поломки: решения TP/trail на этом тике уже по Jupiter; PG ниже только для аудита.',
    'Разбор продукта нужен, если параллельно идут алерты live-jupiter-tracker-fallback или jupiter-quote-circuit.',
    '',
    `strategyId=${args.strategyId}`,
    `symbol=${args.symbol}`,
    `mint=${args.mint}`,
    `snapshotUsd=${args.snapshotPx.toFixed(10)}`,
    `jupiterUsd=${args.jupiterPx.toFixed(10)}`,
    `absDiffPctVsJupiter=${args.divergePct.toFixed(2)}%`,
    `probeUsd=${args.probeUsd.toFixed(4)}`,
  ];
  if (xSnap != null && xJup != null && Number.isFinite(xSnap) && Number.isFinite(xJup)) {
    lines.push(
      `xAvg_snapshot=${xSnap.toFixed(6)} xAvg_jupiter=${xJup.toFixed(6)} (vs avgEntryMarket)`,
    );
  }
  lines.push(`tsUtc=${new Date().toISOString()}`);

  await sendTagged('ALERT', 'live-jupiter-tracker-diverge', lines.join('\n'));
}

/** Price-verify: sliding-window circuit breaker открылся (много transport-fail по Jupiter). */
export async function notifyJupiterQuoteCircuitBreakerOpen(args: {
  fails: number;
  windowSamples: number;
  failPct: number;
  cooldownMs: number;
}): Promise<void> {
  if (!CIRCUIT_ON) return;
  const key = 'circuit-open';
  if (shouldThrottle(key, Math.max(throttleDefaultMs, 600_000))) return;

  const lines = [
    'severity=ACTION  investigate_product=YES',
    '',
    'Причина: sliding-window circuit breaker по котированию Jupiter (много transport-fail).',
    'Что делать: проверить сеть, Jupiter, лимиты и логи price-verify / resilience до истечения cooldown.',
    '',
    `failsInWindow=${args.fails}`,
    `samplesInWindow=${args.windowSamples}`,
    `failPct=${args.failPct.toFixed(2)}`,
    `cooldownMs=${args.cooldownMs}`,
    `tsUtc=${new Date().toISOString()}`,
  ];
  await sendTagged('ALERT', 'jupiter-quote-circuit', lines.join('\n'));
}
