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
 * - `JUPITER_429_BURST_TELEGRAM=0` — выкл. немедленный алерт при burst HTTP 429 (см. jupiter-429-monitor.ts).
 * - `JUPITER_429_EXHAUST_TELEGRAM=0` — выкл. алерт при исчерпании retry на quote/swap 429.
 * - `LIVE_JUPITER_TRACKER_TG_THROTTLE_MS` — мин. интервал между одинаковыми алертами по одному mint (default 300000).
 * - `live-jupiter-tracker-mtm-snap-clamp` — Jupiter buy-probe сильно выше PG snapshot; MTM на тике переведён на snapshot.
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

/** Трекер live: Jupiter buy-probe заметно расходится с PG snapshot — MTM на этом тике по snapshot (симметричная полоса). */
export async function notifyLiveTrackerJupiterMtmClampedToSnapshot(args: {
  strategyId: string;
  mint: string;
  symbol: string;
  snapshotPx: number;
  jupiterPx: number;
  probeUsd: number;
  maxPremiumPct: number;
  /** `high` — Jupiter выше полосы; `low` — ниже (занижение котировки). */
  bandClamp?: 'high' | 'low';
}): Promise<void> {
  if (!TRACKER_ON) return;
  const dir = args.bandClamp ?? 'high';
  const key = `clamp:${args.mint}:${dir}`;
  if (shouldThrottle(key, throttleDefaultMs)) return;

  const prem = args.snapshotPx > 0 ? ((args.jupiterPx / args.snapshotPx - 1) * 100).toFixed(2) : 'n/a';
  const reason =
    dir === 'low'
      ? 'Причина: Jupiter SOL→token probe заметно ниже последнего PG price_usd; TP/peak/trail на этом тике считаются по snapshot (симметричная полоса — иначе лестница TP могла бы не срабатывать при заниженном Jupiter).'
      : 'Причина: Jupiter SOL→token probe сильно выше последнего PG price_usd; TP/peak/trail на этом тике считаются по snapshot (защита от ложного роста на тонком маршруте).';
  const hint =
    dir === 'low'
      ? 'Что делать: сверить график/DEX и маршрут; при частых срабатываниях поднять LIVE_TRACKER_JUPITER_MAX_PREMIUM_OVER_SNAPSHOT_PCT (полоса симметрична) или временно поставить 0 (отключить полосу).'
      : 'Что делать: сверить график/DEX; при частых срабатываниях поднять LIVE_TRACKER_JUPITER_MAX_PREMIUM_OVER_SNAPSHOT_PCT или временно поставить 0 (старое поведение).';
  const lines = [
    'severity=ACTION  investigate_product=YES',
    '',
    reason,
    hint,
    '',
    `strategyId=${args.strategyId}`,
    `symbol=${args.symbol}`,
    `mint=${args.mint}`,
    `bandClamp=${dir}`,
    `snapshotUsd=${args.snapshotPx.toFixed(10)}`,
    `jupiterUsd=${args.jupiterPx.toFixed(10)}`,
    `jupiterVsSnapshotPct=${prem}`,
    `maxPremiumPctConfigured=${args.maxPremiumPct}`,
    `probeUsd=${args.probeUsd.toFixed(4)}`,
    `tsUtc=${new Date().toISOString()}`,
  ];
  await sendTagged('ALERT', 'live-jupiter-tracker-mtm-snap-clamp', lines.join('\n'));
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

/** Немедленный алерт: burst HTTP 429 от Jupiter (free-tier choking / rate limit). */
export async function notifyJupiter429RateLimitBurst(args: {
  eventsInWindow: number;
  windowMs: number;
  bySource: Record<'quote' | 'swap' | 'price', number>;
  tierHint: string;
}): Promise<void> {
  const key = '429-burst';
  const cd = Math.max(
    throttleDefaultMs,
    Number(process.env.JUPITER_429_BURST_TG_THROTTLE_MS ?? 300_000),
  );
  if (shouldThrottle(key, cd)) return;

  const lines = [
    'severity=ACTION  investigate_product=YES',
    '',
    'Причина: burst HTTP 429 от Jupiter API — вероятно упёрлись в rate limit (free tier ≈1 RPS).',
    'Что делать: проверить JUPITER_API_KEY tier, sa-rate-429-report, логи live-oscar; рассмотреть Developer ($25/mo, 10 RPS).',
    '',
    `eventsInWindow=${args.eventsInWindow}`,
    `windowMs=${args.windowMs}`,
    `quote429=${args.bySource.quote} swap429=${args.bySource.swap} price429=${args.bySource.price}`,
    `jupiterTier=${args.tierHint}`,
    `tsUtc=${new Date().toISOString()}`,
  ];
  await sendTagged('ALERT', 'jupiter-429-burst', lines.join('\n'));
}

/** Немедленный алерт: quote/swap исчерпал retry на 429 — котировка/сборка tx не получена. */
export async function notifyJupiterQuoteRateLimitExhausted(args: {
  source: 'quote' | 'swap' | 'price';
  retriesAttempted: number;
  eventsInWindow: number;
  tierHint: string;
}): Promise<void> {
  const key = `429-exhaust:${args.source}`;
  const cd = Math.max(
    60_000,
    Number(process.env.JUPITER_429_EXHAUST_TG_THROTTLE_MS ?? 120_000),
  );
  if (shouldThrottle(key, cd)) return;

  const lines = [
    'severity=ACTION  investigate_product=YES',
    '',
    `Причина: Jupiter ${args.source} HTTP 429 — исчерпаны retry, запрос не выполнен.`,
    'Что делать: снизить параллелизм Jupiter, проверить tier ключа, hot-tick / exit-slice нагрузку.',
    '',
    `source=${args.source}`,
    `retriesAttempted=${args.retriesAttempted}`,
    `recent429InWindow=${args.eventsInWindow}`,
    `jupiterTier=${args.tierHint}`,
    `tsUtc=${new Date().toISOString()}`,
  ];
  await sendTagged('ALERT', 'jupiter-429-exhaust', lines.join('\n'));
}
