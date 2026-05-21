/**
 * Отдельный watch-only бот: резкий рост/пролив по снимкам DEX в Postgres → Telegram.
 *
 * Не использует TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID продового Live Oscar — только
 * SPIKE_ALERT_TELEGRAM_* и отдельный rate-limit Telegram. Запросы к PG те же пулы, что и у
 * коллектора, но нагрузка ограничена циклом SPIKE_ALERT_POLL_INTERVAL_MS и лимитом строк;
 * Live Oscar на это не завязан.
 *
 * Детекция: по каждому mint из свежей выборки поднимаем цепочку минутных баров за SPIKE_ALERT_SCAN_MINUTES
 * и ищем **соседнюю** пару баров с |Δ%| ≥ порога (отдельно для роста и пролива:
 * SPIKE_ALERT_THRESHOLD_PUMP_CONSEC_PCT / SPIKE_ALERT_THRESHOLD_DUMP_CONSEC_PCT).
 * Дополнительно — накопление: для каждого целого окна от SPIKE_ALERT_ROLLING_MINUTES до
 * SPIKE_ALERT_ROLLING_MAX_MINUTES ищем бар-опору «не новее чем W минут назад» и сравниваем с последним
 * баром; достаточно |Δ%| ≥ SPIKE_ALERT_THRESHOLD_ROLLING_PCT хотя бы для одного W (берётся кандидат
 * с наибольшим |Δ%|, при равенстве — меньшее W).
 *
 * SPIKE_ALERT_WINDOW_MIN / SPIKE_ALERT_LOOKBACK_SEC оставлены в коде через resolveLookbackSec только для
 * совместимости env; основной триггер — скан пар баров + rolling.
 *
 * Если в tokens нет symbol/name — перед отправкой в Telegram опционально подтягиваем метаданные с
 * Dexscreener (SPIKE_ALERT_DEXSCREENER_META) и можем дописать строку в PG (SPIKE_ALERT_UPSERT_TOKEN_META).
 *
 * Отбор «latest» по таблице: до SPIKE_ALERT_MAX_ROWS_PER_TABLE mint с **наиболее свежим** последним снимком
 * в окне пола (ORDER BY MAX(ts) DESC), не лексикографически по адресу mint.
 * SPIKE_ALERT_MIN_MARKET_CAP_USD — порог по COALESCE(market_cap_usd, fdv_usd снимка, tokens.fdv_usd); по умолчанию **$2M**.
 *
 * SPIKE_ALERT_POLL_INTERVAL_MS > 0 — цикл опроса PG (чаще, чем раз в минуту), чтобы второй минутный бар
 * успевал попасть в БД между проверками. При опросе включена короткая дедупликация отправок
 * SPIKE_ALERT_POLL_SEND_DEDUPE_MS (не путать с удалённым часовым cooldown).
 *
 * SPIKE_ALERT_MINT_COOLDOWN_MINUTES — после успешной отправки по mint пауза; эскалация может
 * слать [UPDATE] при усилении пролива (см. SPIKE_ALERT_ESCALATE_*).
 *
 * Диагностика без Telegram: `npm run market-spike-telegram-watch -- --diagnose-mint <mint> [--at ISO]`
 *
 * Алерт только если «новый» бар события не старше SPIKE_ALERT_MAX_NEWER_BAR_AGE_MINUTES; соседняя пара
 * берётся самая свежая в ряду (не максимум |%| за всю глубину). При очень низкой liq_usd в снимке —
 * потолок |Δ%| (anti-glitch). Время в тексте — SPIKE_ALERT_DISPLAY_TZ (по умолчанию Москва).
 *
 * История баров фильтруется по (base_mint, pair_address) из «latest», чтобы не смешивать несколько пулов
 * одного mint в одной минутной метке. SPIKE_ALERT_GLITCH_NEXT_BAR_RETRACE_MIN — подавление одноминутного
 * выброса, если следующий бар откатывает большую долю движения.
 *
 * Перекрёстные проверки снимков: SPIKE_ALERT_LIQ_MCAP_SANITY — при крупной ref mcap/fdv требовать,
 * чтобы liquidity_usd в последнем снимке не была микроскопической относительно капы (иначе битый ряд PG).
 * SPIKE_ALERT_MC_PRICE_MAX_DIVERGENCE_PCT — если в обоих барах есть mcap_usd, Δ% по mcap должен быть
 * близок к Δ% по price_usd.
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';

import { db, sql as pgSql } from '../core/db/client.js';

const SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

type DexTable = (typeof SNAPSHOT_TABLES)[number];

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

/** Legacy env (сек), не участвует в SQL после перехода на скан баров. */
function resolveLookbackSec(): number {
  const secRaw = process.env.SPIKE_ALERT_LOOKBACK_SEC?.trim();
  if (secRaw) {
    return Math.max(30, Math.min(7200, envNum('SPIKE_ALERT_LOOKBACK_SEC', 60)));
  }
  const minRaw = process.env.SPIKE_ALERT_WINDOW_MIN?.trim();
  if (minRaw) {
    const wm = Math.max(1, Math.min(180, envNum('SPIKE_ALERT_WINDOW_MIN', 30)));
    return wm * 60;
  }
  return 60;
}

const LOOKBACK_SEC = resolveLookbackSec();
/** Нижняя граница длины окна накопления (мин); 0 — выключить накопление целиком. */
let ROLLING_MINUTES_MIN = Math.max(0, Math.min(120, Math.floor(envNum('SPIKE_ALERT_ROLLING_MINUTES', 3))));
/** Верхняя граница того же (мин); по умолчанию 10 → окна 3…10 мин включительно. */
let ROLLING_MINUTES_MAX = Math.max(0, Math.min(120, Math.floor(envNum('SPIKE_ALERT_ROLLING_MAX_MINUTES', 10))));
if (ROLLING_MINUTES_MIN > ROLLING_MINUTES_MAX) {
  const t = ROLLING_MINUTES_MIN;
  ROLLING_MINUTES_MIN = ROLLING_MINUTES_MAX;
  ROLLING_MINUTES_MAX = t;
}
/** Накопление включено, если задан положительный диапазон. */
const ROLLING_RANGE_ENABLED = ROLLING_MINUTES_MIN > 0 && ROLLING_MINUTES_MAX > 0;
/** Глубина истории баров для поиска резких скачков между соседними минутами. */
const SCAN_MINUTES = Math.max(15, Math.min(180, Math.floor(envNum('SPIKE_ALERT_SCAN_MINUTES', 60))));

/** Последний снимок mint должен быть не старше этого порога (сек). */
const LATEST_FLOOR_SEC = Math.max(
  600,
  Math.min(
    3600,
    Math.max(
      900,
      ROLLING_RANGE_ENABLED ? ROLLING_MINUTES_MAX * 60 + 300 : 900,
    ),
  ),
);

/**
 * Legacy SPIKE_ALERT_THRESHOLD_PCT — дефолт для порога pump по соседним минутам,
 * если отдельный SPIKE_ALERT_THRESHOLD_PUMP_CONSEC_PCT не задан.
 */
const THRESHOLD_PCT_LEGACY = Math.max(0.5, Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_PCT', 8)));
/** Минутное окно: рост (соседние бары). */
const THRESHOLD_CONSEC_PUMP_PCT = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_PUMP_CONSEC_PCT', THRESHOLD_PCT_LEGACY)),
);
/** Минутное окно: пролив (соседние бары). */
const THRESHOLD_CONSEC_DUMP_PCT = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_DUMP_CONSEC_PCT', 8)),
);
/** Накопление по окнам SPIKE_ALERT_ROLLING_MINUTES…MAX (последний бар vs опора за W минут). */
const THRESHOLD_ROLLING_PCT = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_ROLLING_PCT', 10)),
);

const SPIKE_THRESHOLD_FLOOR = Math.max(
  THRESHOLD_CONSEC_PUMP_PCT,
  THRESHOLD_CONSEC_DUMP_PCT,
  THRESHOLD_ROLLING_PCT,
);

/**
 * Tier-фильтр по market cap: единый минимум для PUMP (рост) + три ступени для DUMP (пролив).
 * Используется ВМЕСТО плоских THRESHOLD_*_CONSEC_PCT/ROLLING_PCT, когда SPIKE_ALERT_TIERED_BY_MCAP=1.
 *
 * Зачем: на капе $1.5–3M пролив 8% — это шум; на капе $7M+ ждать 15% — пропуск. Каскад снижает порог
 * для крупных капов и поднимает для мелких. Pump в любой капе считаем интересным только от 30%.
 *
 * Логика финального решения:
 *   ref_mcap = nowMcap ?? anchorMcap ?? token_fdv ?? 0
 *   if pct >= 0:                                       минимум = SPIKE_ALERT_PUMP_MIN_PCT
 *   elif ref_mcap >= SPIKE_ALERT_DUMP_TIER3_MCAP_USD:  минимум = SPIKE_ALERT_DUMP_TIER3_MIN_PCT
 *   elif ref_mcap >= SPIKE_ALERT_DUMP_TIER2_MCAP_USD:  минимум = SPIKE_ALERT_DUMP_TIER2_MIN_PCT
 *   elif ref_mcap >= SPIKE_ALERT_DUMP_TIER1_MCAP_USD:  минимум = SPIKE_ALERT_DUMP_TIER1_MIN_PCT
 *   else:                                              отбрасываем (микрокап)
 *
 * Когда SPIKE_ALERT_TIERED_BY_MCAP=0 — поведение прежнее (плоские THRESHOLD_*).
 */
/** По умолчанию включён tier-каскад (см. ecosystem.market-spike-watch.cjs). */
const TIERED_BY_MCAP = envBool('SPIKE_ALERT_TIERED_BY_MCAP', true);
const PUMP_MIN_PCT = Math.max(0.5, Math.min(500, envNum('SPIKE_ALERT_PUMP_MIN_PCT', 30)));
const DUMP_TIER1_MCAP = Math.max(0, envNum('SPIKE_ALERT_DUMP_TIER1_MCAP_USD', 1_500_000));
/**
 * Tier-пороги для DUMP делятся на signalKind:
 *  - `_CONSEC` — соседние минутные бары (резкий шаг);
 *  - `_ROLLING` — диапазон ROLLING_MINUTES_MIN…MAX (накопление за W мин).
 * Если `_ROLLING` не задан явно — берётся `_CONSEC` (legacy совместимость).
 */
const DUMP_TIER1_MIN_PCT_CONSEC = Math.max(0.5, Math.min(80, envNum('SPIKE_ALERT_DUMP_TIER1_MIN_PCT', 14)));
const DUMP_TIER1_MIN_PCT_ROLLING = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_DUMP_TIER1_MIN_PCT_ROLLING', 15)),
);
const DUMP_TIER2_MCAP = Math.max(0, envNum('SPIKE_ALERT_DUMP_TIER2_MCAP_USD', 3_000_000));
const DUMP_TIER2_MIN_PCT_CONSEC = Math.max(0.5, Math.min(80, envNum('SPIKE_ALERT_DUMP_TIER2_MIN_PCT', 11)));
const DUMP_TIER2_MIN_PCT_ROLLING = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_DUMP_TIER2_MIN_PCT_ROLLING', 12)),
);
const DUMP_TIER3_MCAP = Math.max(0, envNum('SPIKE_ALERT_DUMP_TIER3_MCAP_USD', 7_000_000));
const DUMP_TIER3_MIN_PCT_CONSEC = Math.max(0.5, Math.min(80, envNum('SPIKE_ALERT_DUMP_TIER3_MIN_PCT', 8)));
const DUMP_TIER3_MIN_PCT_ROLLING = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_DUMP_TIER3_MIN_PCT_ROLLING', 10)),
);

/**
 * Минимально интересный |Δ%|, который ВООБЩЕ пропускаем через детекторы pickConsecutive/pickRolling.
 * Финальное решение принимается в outer фильтре по tier-логике.
 * Когда TIERED_BY_MCAP=1 — берём минимум из всех tier-порогов (consec и rolling), но не меньше 5%,
 * чтобы не плодить шум.
 */
const PICK_PCT_FLOOR = TIERED_BY_MCAP
  ? Math.max(
      5,
      Math.min(
        DUMP_TIER1_MIN_PCT_CONSEC,
        DUMP_TIER2_MIN_PCT_CONSEC,
        DUMP_TIER3_MIN_PCT_CONSEC,
        DUMP_TIER1_MIN_PCT_ROLLING,
        DUMP_TIER2_MIN_PCT_ROLLING,
        DUMP_TIER3_MIN_PCT_ROLLING,
        PUMP_MIN_PCT,
      ),
    )
  : Math.min(THRESHOLD_CONSEC_PUMP_PCT, THRESHOLD_CONSEC_DUMP_PCT, THRESHOLD_ROLLING_PCT);

/**
 * Эскалация: если в течение mint cooldown пролив усилился, шлём повторный [UPDATE]-алерт.
 *  - `ENABLED` — включить (по умолчанию on);
 *  - `DELTA_PCT` — повторный алерт, если |new pct| - |prev pct| ≥ DELTA_PCT (даже если tier тот же);
 *  - `MIN_GAP_SEC` — минимальный интервал между [SENT]/[UPDATE] по одному mint;
 *  - `MAX_PER_MINT` — максимум апдейтов за один период жизни алерта (после обнуляется через MINT_COOLDOWN_MS*2);
 *  - `TIER_CHANGE_FORCES_UPDATE` — при переходе в более жёсткий tier шлём апдейт даже если delta ниже DELTA_PCT.
 */
const ESCALATE_ENABLED = envBool('SPIKE_ALERT_ESCALATE_ENABLED', false);
const ESCALATE_DELTA_PCT = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_ESCALATE_DELTA_PCT', 5)),
);
const ESCALATE_MIN_GAP_SEC = Math.max(
  10,
  Math.min(3600, Math.floor(envNum('SPIKE_ALERT_ESCALATE_MIN_GAP_SEC', 60))),
);
const ESCALATE_MAX_PER_MINT = Math.max(
  0,
  Math.min(10, Math.floor(envNum('SPIKE_ALERT_ESCALATE_MAX_PER_MINT', 3))),
);
const ESCALATE_TIER_CHANGE_FORCES_UPDATE = envBool(
  'SPIKE_ALERT_ESCALATE_TIER_CHANGE_FORCES_UPDATE',
  true,
);

/**
 * Аудит решений в PG-таблицу `market_spike_events`.
 * При старте делается `CREATE TABLE IF NOT EXISTS`. Если PG отказал (нет прав или сетевая ошибка) —
 * graceful fallback: пишем только в stdout, отправка алертов не страдает.
 */
const AUDIT_DB_ENABLED = envBool('SPIKE_ALERT_AUDIT_DB_ENABLED', true);
/** Писать ли в БД skip-события (false → только sent/update/miss/skip-важные). */
const AUDIT_LOG_SKIPS = envBool('SPIKE_ALERT_AUDIT_LOG_SKIPS', false);

/** Если пройден PICK_PCT_FLOOR, но не tier-минимум — записать в лог как [MISS] (для retro-анализа). */
const LOG_MISS_BY_FILTER = envBool('SPIKE_ALERT_LOG_MISS_BY_FILTER', true);

const MIN_HOLDERS = Math.max(0, envNum('SPIKE_ALERT_MIN_HOLDERS', 1000));
/**
 * Если SPIKE_ALERT_HOLDER_NULL_SOFT=1: токены с tokens.holder_count IS NULL пропускаются дальше
 * (фильтр holders применяется только к токенам, у которых holder_count известен и < MIN_HOLDERS).
 *
 * Зачем: token-meta collector не успевает наполнять holder_count для свежих pump-токенов;
 * жёсткий COALESCE(holder_count, 0) >= 1000 ранее отбрасывал даже легитимные токены с большим объёмом.
 * NULL-soft режим даёт другим фильтрам (mcap, age, sanity) шанс отработать.
 */
const HOLDER_NULL_SOFT = envBool('SPIKE_ALERT_HOLDER_NULL_SOFT', true);
const MIN_AGE_HOURS = Math.max(0, envNum('SPIKE_ALERT_MIN_AGE_HOURS', 8));
const MIN_LIQ_USD = Math.max(0, envNum('SPIKE_ALERT_MIN_LIQ_USD', 0));
const MIN_VOL_5M_USD = Math.max(0, envNum('SPIKE_ALERT_MIN_VOL_5M_USD', 0));
/** Минимум market cap в USD: снимок пары (mcap/fdv) или fallback tokens.fdv_usd; 0 = выкл. */
const MIN_MARKET_CAP_USD = Math.max(0, envNum('SPIKE_ALERT_MIN_MARKET_CAP_USD', 2_000_000));
const MAX_ROWS = Math.max(50, Math.min(5000, envNum('SPIKE_ALERT_MAX_ROWS_PER_TABLE', 800)));
const DRY_RUN = envBool('SPIKE_ALERT_DRY_RUN', false);

/** 0 — один проход и exit (только с PM2 autorestart:false + cron_restart). Иначе цикл каждые N мс. */
const POLL_INTERVAL_MS_RAW = Math.floor(envNum('SPIKE_ALERT_POLL_INTERVAL_MS', 0));
const POLL_INTERVAL_MS =
  POLL_INTERVAL_MS_RAW <= 0 ? 0 : Math.max(5000, Math.min(600_000, POLL_INTERVAL_MS_RAW));
/** Анти-спам при poll: не слать повтор того же события чаще чем раз в N мс (только если POLL > 0). */
const POLL_SEND_DEDUPE_MS = Math.max(0, Math.min(3_600_000, Math.floor(envNum('SPIKE_ALERT_POLL_SEND_DEDUPE_MS', 120_000))));

/** После успешного алерта по mint — пауза перед любыми новыми алертами по этому mint (мин); 0 = выкл. */
const MINT_COOLDOWN_MINUTES = Math.max(
  0,
  Math.min(24 * 60, Math.floor(envNum('SPIKE_ALERT_MINT_COOLDOWN_MINUTES', 5))),
);
const MINT_COOLDOWN_MS = MINT_COOLDOWN_MINUTES * 60_000;

/** Опора «сдвинулась назад» ≥ N сек — считаем новым пампом/проливом (не повтор того же движения). */
const LEG_ANCHOR_SLACK_MS = Math.max(
  0,
  Math.min(3600, Math.floor(envNum('SPIKE_ALERT_LEG_ANCHOR_SLACK_SEC', 120))) * 1000,
);

/** Алерт только если «новый» бар скачка не старше N минут относительно now (отсекает старые движения в окне скана). */
const MAX_NEWER_BAR_AGE_MIN = Math.max(
  1,
  Math.min(180, Math.floor(envNum('SPIKE_ALERT_MAX_NEWER_BAR_AGE_MINUTES', 20))),
);

/**
 * Если известна liq_usd из последнего снимка и она ниже порога — не считать движение выше LOW_LIQ_MAX_ABS_PCT
 * (тонкий пул / шум котировки price_usd в PG).
 */
const LOW_LIQ_GLITCH_THRESHOLD_USD = Math.max(0, envNum('SPIKE_ALERT_LOW_LIQ_GLITCH_THRESHOLD_USD', 5000));
const LOW_LIQ_MAX_ABS_PCT = Math.max(
  SPIKE_THRESHOLD_FLOOR,
  Math.min(500, envNum('SPIKE_ALERT_LOW_LIQ_MAX_ABS_PCT', 55)),
);

/** Достать symbol/name у Dexscreener, если в tokens пусто (кэш на процесс + опционально UPSERT). */
const DEXSCREENER_META_ENABLED = envBool('SPIKE_ALERT_DEXSCREENER_META', true);
const UPSERT_TOKEN_META_FROM_DEX = envBool('SPIKE_ALERT_UPSERT_TOKEN_META', true);
const DEX_META_CHUNK = Math.max(1, Math.min(40, Math.floor(envNum('SPIKE_ALERT_DEXSCREENER_CHUNK', 20))));
const DEX_META_CACHE_TTL_MS = Math.max(
  60_000,
  Math.min(7 * 24 * 3600_000, Math.floor(envNum('SPIKE_ALERT_DEXSCREENER_CACHE_TTL_MS', 24 * 3600_000))),
);

type DexTokenMeta = { symbol: string | null; name: string | null };
const dexMetaCache = new Map<string, { meta: DexTokenMeta; at: number }>();

/**
 * Если следующий минутный бар откатывает ≥ доли импульса (разовый выброс в PG) — не считать пару событий.
 * 0 = выкл.
 */
const GLITCH_NEXT_BAR_RETRACE_MIN = Math.max(
  0,
  Math.min(1, envNum('SPIKE_ALERT_GLITCH_NEXT_BAR_RETRACE_MIN', 0.55)),
);

/**
 * Пул «мёртвый» относительно других пулов того же mint: liq < MIN_LIQ_SHARE_OF_MINT_MAX × max liq по mint.
 * Отсекает ложные +95% на CK71… когда pumpswap/meteora держат сотни k USD.
 */
const MIN_LIQ_SHARE_OF_MINT_MAX = Math.max(
  0,
  Math.min(1, envNum('SPIKE_ALERT_MIN_LIQ_SHARE_OF_MINT_MAX', 0.1)),
);

/**
 * Якорный бар с vol_5m=0 и |Δ%| ≥ порога — типичный stale price_usd на заброшенном пуле.
 * 0 = выкл.
 */
const STALE_ZERO_VOL_JUMP_PCT = Math.max(
  0,
  Math.min(500, envNum('SPIKE_ALERT_STALE_ZERO_VOL_JUMP_PCT', 30)),
);

/** Обновлять tokens.primary_pair / liquidity_usd на пул с max liq среди свежих снимков (раз за проход). */
const PRIMARY_PAIR_REFRESH_ENABLED = envBool('SPIKE_ALERT_PRIMARY_PAIR_REFRESH', true);

/** Несостыковка liq_usd «latest» vs ref market cap/fdv из баров/tokens — типичный ложный пролив. */
const LIQ_MCAP_SANITY_ENABLED = envBool('SPIKE_ALERT_LIQ_MCAP_SANITY', true);
/** Ниже этого ref (USD) порог liq/mcap не применяем (тонкий рынок / неполные данные). */
const LIQ_MCAP_REF_MIN_USD = Math.max(
  0,
  envNum('SPIKE_ALERT_LIQ_MCAP_REF_MIN_USD', 2_000_000),
);
/** Минимум liq_usd / ref_mcap; например 0.002 = 0.2% от капы (у ~$10M mcap liq должно быть десятки+ k). */
const MIN_LIQ_TO_REF_MCAP_RATIO = Math.max(
  0,
  Math.min(0.5, envNum('SPIKE_ALERT_MIN_LIQ_TO_REF_MCAP_RATIO', 0.002)),
);

/** Допустимый разрыв между Δ% price_usd и Δ% mcap_usd в паре баров (округление, разные поля). */
const MC_PRICE_MAX_DIVERGENCE_PCT = Math.max(
  0,
  Math.min(100, envNum('SPIKE_ALERT_MC_PRICE_MAX_DIVERGENCE_PCT', 8)),
);

const DISPLAY_TZ = process.env.SPIKE_ALERT_DISPLAY_TZ?.trim() || 'Europe/Moscow';

const TG_TOKEN = process.env.SPIKE_ALERT_TELEGRAM_BOT_TOKEN?.trim() ?? '';
const TG_CHAT = process.env.SPIKE_ALERT_TELEGRAM_CHAT_ID?.trim() ?? '';

function dexLabel(table: DexTable): string {
  return table.replace('_pair_snapshots', '');
}

type LatestMeta = {
  base_mint: string;
  pair_address: string;
  px_now: number;
  ts_now: Date | string;
  symbol: string | null;
  token_name: string | null;
  holder_count: number | null;
  liq_usd: number | null;
  /** Fallback для строки Market cap, если в мин. снимках нет mcap/fdv по паре. */
  token_fdv_usd: number | null;
};

type Bar = { ts: Date; px: number; mcapUsd: number | null; vol5m: number | null };

type SpikeSignalKind = 'consecutive' | 'rolling';

type SpikePick = {
  pct: number;
  anchorPx: number;
  pxNow: number;
  anchorMcapUsd: number | null;
  nowMcapUsd: number | null;
  anchorTs: Date;
  tsNew: Date;
  windowLabel: string;
  signalKind: SpikeSignalKind;
  /** Заполнено для signalKind rolling: какое W минут дало этот кандидат. */
  rollingSpanMinutes?: number;
};

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

/** Кортежи (mint, pair) только для пулов из latest — иначе несколько пар на mint смешиваются в одну минуту. */
function sqlMintPairInTuples(rows: LatestMeta[]): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const r of rows) {
    const mint = r.base_mint.trim();
    const pair = r.pair_address.trim();
    if (!ADDR_RE.test(mint) || !ADDR_RE.test(pair)) continue;
    const key = `${mint}|${pair}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`('${mint.replace(/'/g, "''")}', '${pair.replace(/'/g, "''")}')`);
  }
  if (!parts.length) return null;
  return parts.join(', ');
}

function buildLatestOnlyQuery(table: DexTable): string {
  const liqClause =
    MIN_LIQ_USD > 0 ? `AND COALESCE(s.liquidity_usd, 0) >= ${MIN_LIQ_USD}` : '';
  const volClause =
    MIN_VOL_5M_USD > 0 ? `AND COALESCE(s.volume_5m, 0) >= ${MIN_VOL_5M_USD}` : '';
  const mcapClause =
    MIN_MARKET_CAP_USD > 0
      ? `AND COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) >= ${MIN_MARKET_CAP_USD}`
      : '';
  // Holders: при HOLDER_NULL_SOFT=1 NULL значения пропускаем (фильтрация только если holder_count известен).
  const holdersClause = HOLDER_NULL_SOFT
    ? `AND (t.holder_count IS NULL OR t.holder_count >= ${MIN_HOLDERS})`
    : `AND COALESCE(t.holder_count, 0) >= ${MIN_HOLDERS}`;
  const snapshotFilters = `
    AND s.ts > now() - (${LATEST_FLOOR_SEC} * interval '1 second')
    AND COALESCE(s.price_usd, 0) > 0
    ${holdersClause}
    AND (
      (s.launch_ts IS NOT NULL AND s.launch_ts <= now() - interval '${MIN_AGE_HOURS} hours')
      OR (s.launch_ts IS NULL AND t.first_seen_at <= now() - interval '${MIN_AGE_HOURS} hours')
    )
    ${liqClause}
    ${volClause}
    ${mcapClause}`;
  return `
WITH top_mints AS (
  SELECT s.base_mint
  FROM ${table} s
  INNER JOIN tokens t ON t.mint = s.base_mint
  WHERE true
    ${snapshotFilters}
  GROUP BY s.base_mint
  ORDER BY MAX(s.ts) DESC, s.base_mint ASC
  LIMIT ${MAX_ROWS}
),
latest AS (
  -- DISTINCT ON (base_mint, pair_address): берём последний снимок по КАЖДОЙ паре mint.
  -- Так анализ ниже видит все пулы одного mint — резкий бар на pumpswap не теряется
  -- из-за того что свежее у meteora (или наоборот). Кэп от MAX_ROWS уже применён в top_mints.
  SELECT DISTINCT ON (s.base_mint, s.pair_address)
    s.base_mint,
    s.pair_address,
    s.price_usd AS px_now,
    s.ts AS ts_now,
    s.liquidity_usd AS liq_usd
  FROM ${table} s
  INNER JOIN tokens t ON t.mint = s.base_mint
  INNER JOIN top_mints m ON m.base_mint = s.base_mint
  WHERE true
    ${snapshotFilters}
  ORDER BY s.base_mint, s.pair_address, s.ts DESC
)
SELECT
  l.base_mint,
  l.pair_address,
  l.px_now::double precision AS px_now,
  l.ts_now,
  t.symbol,
  t.name AS token_name,
  t.holder_count,
  l.liq_usd::double precision AS liq_usd,
  t.fdv_usd::double precision AS token_fdv_usd
FROM latest l
INNER JOIN tokens t ON t.mint = l.base_mint`;
}

function buildBarsQuery(table: DexTable, mintPairTuplesSql: string): string {
  return `
SELECT base_mint::text, pair_address::text, ts, price_usd::double precision AS price_usd,
  COALESCE(market_cap_usd, fdv_usd)::double precision AS mcap_usd,
  COALESCE(volume_5m, 0)::double precision AS vol_5m
FROM ${table}
WHERE (base_mint, pair_address) IN (${mintPairTuplesSql})
  AND ts > now() - (${SCAN_MINUTES} * interval '1 minute')
  AND COALESCE(price_usd, 0) > 0
ORDER BY base_mint ASC, pair_address ASC, ts ASC`;
}

/** Ключ для bars-map: `${mint}|${pair}`. */
function barsMapKey(mint: string, pair: string): string {
  return `${mint}|${pair}`;
}

function parseTs(v: Date | string): Date {
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/** Один ts — одна точка (последняя цена на метку времени). */
function dedupeBarsSorted(rows: Bar[]): Bar[] {
  const byMs = new Map<number, Bar>();
  for (const r of rows) {
    const ms = r.ts.getTime();
    byMs.set(ms, r);
  }
  return [...byMs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => b);
}

function parseMcapUsd(row: Record<string, unknown>): number | null {
  const v = row.mcap_usd;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatDisplayHm(d: Date): string {
  return formatDisplayDt(d, false);
}

/** Дата и время в SPIKE_ALERT_DISPLAY_TZ (по умолчанию Москва). */
export function formatDisplayDt(d: Date, withDate = true): string {
  try {
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: DISPLAY_TZ,
      ...(withDate ? { day: '2-digit', month: '2-digit' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${fmt.format(d).replace(',', '')} МСК`;
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

function formatPriceUsd(px: number): string {
  if (!Number.isFinite(px) || px <= 0) return '?';
  if (px >= 1) return `$${px.toFixed(4)}`;
  if (px >= 0.0001) return `$${px.toFixed(6)}`;
  return `$${px.toExponential(3)}`;
}

export function mcapChangePct(anchorMcapUsd: number | null, nowMcapUsd: number | null): number | null {
  if (anchorMcapUsd == null || nowMcapUsd == null || !(anchorMcapUsd > 0)) return null;
  const pct = (nowMcapUsd / anchorMcapUsd - 1) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/** Новый бар события достаточно свежий, чтобы слать алерт (не «архив» из SCAN_MINUTES). */
function isPickFreshEnough(pick: SpikePick, nowMs: number): boolean {
  const ageMs = nowMs - pick.tsNew.getTime();
  return ageMs >= 0 && ageMs <= MAX_NEWER_BAR_AGE_MIN * 60_000;
}

/** Пул с liq существенно ниже лучшего пула того же mint — не слать алерт с этого pair. */
export function isDeadPoolVsMintMaxLiq(
  pairLiqUsd: number | null,
  mintMaxLiqUsd: number | null,
  minShareOfMax: number = MIN_LIQ_SHARE_OF_MINT_MAX,
): boolean {
  if (minShareOfMax <= 0) return false;
  const pairLiq = pairLiqUsd ?? 0;
  const maxLiq = mintMaxLiqUsd ?? 0;
  if (!(maxLiq > 0) || !(pairLiq > 0)) return false;
  return pairLiq < maxLiq * minShareOfMax;
}

/** Якорный бар без объёма 5m и резкий скачок — stale котировка на заброшенном пуле. */
export function isStaleZeroVolPriceJump(
  bars: Bar[],
  pick: SpikePick,
  thresholdPct: number = STALE_ZERO_VOL_JUMP_PCT,
): boolean {
  if (thresholdPct <= 0) return false;
  if (Math.abs(pick.pct) < thresholdPct) return false;
  const anchorMs = pick.anchorTs.getTime();
  let anchorBar: Bar | null = null;
  for (const b of bars) {
    if (b.ts.getTime() === anchorMs) {
      anchorBar = b;
      break;
    }
  }
  if (!anchorBar) return false;
  const vol = anchorBar.vol5m;
  if (vol == null) return false;
  return vol <= 0;
}

export function buildMintMaxLiqFromLatestRows(
  rows: Array<{ base_mint: string; liq_usd: number | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const liq = row.liq_usd ?? 0;
    if (!(liq > 0)) continue;
    const prev = out.get(row.base_mint) ?? 0;
    if (liq > prev) out.set(row.base_mint, liq);
  }
  return out;
}

/** Отсечь подозрительно большие % при очень маленькой ликвидности в снимке pair. */
function isPickPlausibleForLiquidity(pick: SpikePick, liqUsd: number | null): boolean {
  if (LOW_LIQ_GLITCH_THRESHOLD_USD <= 0 || LOW_LIQ_MAX_ABS_PCT >= 500) return true;
  if (liqUsd == null || !(liqUsd > 0) || liqUsd >= LOW_LIQ_GLITCH_THRESHOLD_USD) return true;
  return Math.abs(pick.pct) <= LOW_LIQ_MAX_ABS_PCT;
}

function referenceMcapUsd(meta: LatestMeta, pick: SpikePick): number {
  const a = pick.anchorMcapUsd ?? 0;
  const b = pick.nowMcapUsd ?? 0;
  const f = meta.token_fdv_usd ?? 0;
  return Math.max(a, b, f);
}

/**
 * Возвращает минимальный |Δ%| для алерта по tier-логике (по market cap).
 * Возвращает null, если кандидат должен быть отброшен (микрокап, не интересен).
 *
 * Пороги отдельные для consec и rolling:
 *   tier3 (mcap≥$7M): consec=8%, rolling=10%
 *   tier2 (mcap≥$3M): consec=11%, rolling=12%
 *   tier1 (mcap≥$1.5M): consec=14%, rolling=15%
 * Только для TIERED_BY_MCAP=1; иначе зовётся унаследованный флоу.
 */
export function tierRequiredMinAbsPct(
  refMcap: number,
  isPump: boolean,
  signalKind: SpikeSignalKind = 'consecutive',
): number | null {
  if (isPump) return PUMP_MIN_PCT;
  if (refMcap >= DUMP_TIER3_MCAP) {
    return signalKind === 'rolling' ? DUMP_TIER3_MIN_PCT_ROLLING : DUMP_TIER3_MIN_PCT_CONSEC;
  }
  if (refMcap >= DUMP_TIER2_MCAP) {
    return signalKind === 'rolling' ? DUMP_TIER2_MIN_PCT_ROLLING : DUMP_TIER2_MIN_PCT_CONSEC;
  }
  if (refMcap >= DUMP_TIER1_MCAP) {
    return signalKind === 'rolling' ? DUMP_TIER1_MIN_PCT_ROLLING : DUMP_TIER1_MIN_PCT_CONSEC;
  }
  return null;
}

/** Числовая ступень: 3 (самая «мягкая», крупная капа), 2, 1, 0 (микрокап). Используется для эскалации. */
export function tierRank(refMcap: number): 0 | 1 | 2 | 3 {
  if (refMcap >= DUMP_TIER3_MCAP) return 3;
  if (refMcap >= DUMP_TIER2_MCAP) return 2;
  if (refMcap >= DUMP_TIER1_MCAP) return 1;
  return 0;
}

export function tierLabel(refMcap: number): string {
  switch (tierRank(refMcap)) {
    case 3:
      return 'tier3(7M+)';
    case 2:
      return 'tier2(3-7M)';
    case 1:
      return 'tier1(1.5-3M)';
    default:
      return 'sub-tier(<1.5M)';
  }
}

/**
 * Ликвидность из последнего снимка должна быть соразмерна капе: иначе price_usd/mcap_usd в барах
 * часто из одной записи, а liq_usd — из другой или битый парсинг Meteora и т.п.
 */
function isPickPlausibleLiqVsMcap(meta: LatestMeta, pick: SpikePick): boolean {
  if (!LIQ_MCAP_SANITY_ENABLED || MIN_LIQ_TO_REF_MCAP_RATIO <= 0) return true;
  const ref = referenceMcapUsd(meta, pick);
  if (!(ref >= LIQ_MCAP_REF_MIN_USD)) return true;
  const liq = meta.liq_usd;
  if (liq == null || !(liq > 0)) return false;
  return liq >= ref * MIN_LIQ_TO_REF_MCAP_RATIO;
}

/** Соседние бары: движение цены и mcap из тех же строк должны согласоваться. */
function isPickPriceMcapConsistent(pick: SpikePick): boolean {
  if (MC_PRICE_MAX_DIVERGENCE_PCT <= 0) return true;
  const mcapPct = mcapChangePct(pick.anchorMcapUsd, pick.nowMcapUsd);
  if (mcapPct == null) return true;
  return Math.abs(mcapPct - pick.pct) <= MC_PRICE_MAX_DIVERGENCE_PCT;
}

/** mcap и цена не должны расходиться по знаку (ложный пролив/памп в PG). */
export function isPickMcapSignAligned(pick: SpikePick): boolean {
  const mcapPct = mcapChangePct(pick.anchorMcapUsd, pick.nowMcapUsd);
  if (mcapPct == null) return true;
  if (Math.abs(mcapPct) < 1) return true;
  return (pick.pct >= 0) === (mcapPct >= 0);
}

/**
 * Rolling: пролив только от локального хая окна, памп — от локального лоя.
 * Иначе «-19%» может быть сравнением с серединой волны, а не с пиком.
 */
export function isRollingPickAnchoredAtExtreme(bars: Bar[], pick: SpikePick): boolean {
  if (!ROLLING_RANGE_ENABLED || pick.signalKind !== 'rolling') return true;
  const startMs = pick.anchorTs.getTime();
  const endMs = pick.tsNew.getTime();
  if (endMs <= startMs) return true;
  let minPx = Infinity;
  let maxPx = 0;
  for (const b of bars) {
    const t = b.ts.getTime();
    if (t < startMs || t > endMs) continue;
    if (b.px > maxPx) maxPx = b.px;
    if (b.px < minPx) minPx = b.px;
  }
  if (!(maxPx > 0) || !Number.isFinite(minPx)) return true;
  const tol = 1e-4;
  if (pick.pct < 0) return pick.anchorPx >= maxPx * (1 - tol);
  if (pick.pct > 0) return pick.anchorPx <= minPx * (1 + tol);
  return true;
}

/** Следующий бар частично отменил скачок — типичный артефакт минутного снимка. */
function isOneBarGlitchReversedByNext(bars: Bar[], newerIdx: number): boolean {
  const thr = GLITCH_NEXT_BAR_RETRACE_MIN;
  if (thr <= 0 || newerIdx + 1 >= bars.length) return false;
  const o = bars[newerIdx - 1].px;
  const n = bars[newerIdx].px;
  const x = bars[newerIdx + 1].px;
  if (!(o > 0) || !(n > 0) || !(x > 0)) return false;
  if (n < o && x > n) {
    const impulse = o - n;
    const rec = x - n;
    return impulse > 0 && rec / impulse >= thr;
  }
  if (n > o && x < n) {
    const impulse = n - o;
    const rec = n - x;
    return impulse > 0 && rec / impulse >= thr;
  }
  return false;
}

/** Для W ∈ [ROLLING_MINUTES_MIN … MAX]: опора — последний бар с ts ≤ now−W·60s; сравнение с последним баром ряда. */
function pickRollingRangeFromBars(bars: Bar[], nowMs: number = Date.now()): SpikePick | null {
  if (!ROLLING_RANGE_ENABLED || bars.length < 2) return null;
  const newest = bars[bars.length - 1];
  // В tiered-режиме порог отбора кандидатов = PICK_PCT_FLOOR; финальное решение — outer tier-фильтр.
  const rollingMinAbs = TIERED_BY_MCAP ? PICK_PCT_FLOOR : THRESHOLD_ROLLING_PCT;
  let best: SpikePick | null = null;
  for (let w = ROLLING_MINUTES_MIN; w <= ROLLING_MINUTES_MAX; w++) {
    const cutoffMs = nowMs - w * 60_000;
    let anchor: Bar | null = null;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].ts.getTime() <= cutoffMs) {
        anchor = bars[i];
        break;
      }
    }
    if (!anchor || !(anchor.px > 0) || !(newest.px > 0)) continue;
    if (anchor.ts.getTime() >= newest.ts.getTime()) continue;
    const pct = (newest.px / anchor.px - 1) * 100;
    if (!Number.isFinite(pct) || Math.abs(pct) < rollingMinAbs) continue;
    const pick: SpikePick = {
      pct,
      anchorPx: anchor.px,
      pxNow: newest.px,
      anchorMcapUsd: anchor.mcapUsd,
      nowMcapUsd: newest.mcapUsd,
      anchorTs: anchor.ts,
      tsNew: newest.ts,
      windowLabel: `${w} мин накопл., конец ${formatDisplayHm(newest.ts)}`,
      signalKind: 'rolling',
      rollingSpanMinutes: w,
    };
    if (
      !best ||
      Math.abs(pick.pct) > Math.abs(best.pct) ||
      (Math.abs(pick.pct) === Math.abs(best.pct) &&
        (best.rollingSpanMinutes == null || w < best.rollingSpanMinutes))
    ) {
      best = pick;
    }
  }
  return best;
}

/** Самая свежая соседняя пара минутных баров с |Δ%| ≥ порога (с конца ряда), не максимум за всю глубину скана. */
function pickConsecutiveBarSpike(bars: Bar[]): SpikePick | null {
  if (bars.length < 2) return null;
  for (let i = bars.length - 1; i >= 1; i--) {
    const older = bars[i - 1];
    const newer = bars[i];
    if (!(older.px > 0) || !(newer.px > 0)) continue;
    const pct = (newer.px / older.px - 1) * 100;
    if (!Number.isFinite(pct)) continue;
    // В tiered-режиме отбираем по floor — финальное решение в outer tier-фильтре.
    const thrAbs = TIERED_BY_MCAP
      ? PICK_PCT_FLOOR
      : pct >= 0
        ? THRESHOLD_CONSEC_PUMP_PCT
        : THRESHOLD_CONSEC_DUMP_PCT;
    if (Math.abs(pct) < thrAbs) continue;
    if (isOneBarGlitchReversedByNext(bars, i)) continue;
    return {
      pct,
      anchorPx: older.px,
      pxNow: newer.px,
      anchorMcapUsd: older.mcapUsd,
      nowMcapUsd: newer.mcapUsd,
      anchorTs: older.ts,
      tsNew: newer.ts,
      windowLabel: `мин. ${formatDisplayHm(older.ts)}→${formatDisplayHm(newer.ts)}`,
      signalKind: 'consecutive',
    };
  }
  return null;
}

function analyzeBarsForMint(rawBars: Bar[], nowMs: number = Date.now()): SpikePick | null {
  const bars = dedupeBarsSorted(rawBars);
  const c1 = pickConsecutiveBarSpike(bars);
  const c2 = pickRollingRangeFromBars(bars, nowMs);
  if (!c1) return c2;
  if (!c2) return c1;
  return Math.abs(c2.pct) > Math.abs(c1.pct) ? c2 : c1;
}

/** Как в `src/live/mint-whitelist.ts`. */
function gmgnSolTokenUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint.trim())}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSignedPct(pct: number): string {
  const v = pct.toFixed(2);
  return pct >= 0 ? `+${v}%` : `${v}%`;
}

function formatMarketCapUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '?';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}k`;
  return `$${n.toFixed(0)}`;
}

/** Blacklist spike-канала tiered: Orka / Orca (не слать в Telegram). */
const SPIKE_TELEGRAM_BLACKLIST_MINTS = new Set<string>([
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
]);

function isSpikeTelegramBlacklisted(
  mint: string,
  symbol: string | null | undefined,
  tokenName: string | null | undefined,
): boolean {
  if (SPIKE_TELEGRAM_BLACKLIST_MINTS.has(mint.trim())) return true;
  if ((symbol ?? '').trim().toUpperCase() === 'ORKA') return true;
  if ((tokenName ?? '').trim().toLowerCase() === 'orka') return true;
  return false;
}

type AlertRow = LatestMeta & {
  dex: string;
  pct: number;
  windowLabel: string;
  signalKind: SpikeSignalKind;
  rollingSpanMinutes?: number;
  anchorPx: number;
  anchorTs: Date | string;
  anchorMcapUsd: number | null;
  nowMcapUsd: number | null;
  /** Max liq среди всех свежих пулов mint (для текста алерта, не triggering pair). */
  best_pool_liq_usd?: number | null;
  /** Заполняются перед фильтрами эскалации/тайра — для аудита и сообщения. */
  refMcapUsd?: number;
  tierName?: string;
  /** Если true — это [UPDATE]-апдейт по уже отосланному mint (внутри cooldown). */
  isUpdate?: boolean;
  /** Заполняется при isUpdate=true; мы передаём это в текст алерта и в БД. */
  prevPct?: number;
  prevTierName?: string;
  prevSentAtMs?: number;
};

function alertKindTag(row: AlertRow): { tag: string; kindWord: string } {
  if (row.isUpdate) {
    const sub = row.pct >= 0 ? 'spike_pump_update' : 'spike_dump_update';
    return {
      tag: `[${sub}]`,
      kindWord: row.pct >= 0 ? 'Рост (UPDATE)' : 'Пролив (UPDATE)',
    };
  }
  const sub = row.pct >= 0 ? 'spike_pump' : 'spike_dump';
  return {
    tag: `[${sub}]`,
    kindWord: row.pct >= 0 ? 'Рост' : 'Пролив',
  };
}

function spikeSignalExplain(row: AlertRow): string {
  if (row.signalKind === 'rolling' && row.rollingSpanMinutes != null) {
    return `rolling ${row.rollingSpanMinutes} мин (${escapeHtml(row.windowLabel)})`;
  }
  return `2 мин. бара подряд (${escapeHtml(row.windowLabel)})`;
}

function tokenHeadlineHtml(symbol: string | null | undefined, tokenName: string | null | undefined): string {
  const sym = (symbol ?? '').trim() || '?';
  const nameRaw = (tokenName ?? '').trim();
  if (sym !== '?' && nameRaw && nameRaw.toUpperCase() !== sym.toUpperCase()) {
    return `<b>${escapeHtml(sym)}</b> — <i>${escapeHtml(nameRaw)}</i>`;
  }
  if (sym !== '?') return `<b>${escapeHtml(sym)}</b>`;
  if (nameRaw) return `<b>${escapeHtml(nameRaw)}</b>`;
  return '<b>?</b>';
}

function buildAlertHtml(row: AlertRow): string {
  const mint = row.base_mint.trim();
  const gmgnUrl = gmgnSolTokenUrl(mint);
  const { tag, kindWord } = alertKindTag(row);
  const pctHuman = formatSignedPct(row.pct);
  const headline = tokenHeadlineHtml(row.symbol, row.token_name);

  const anchorTs = parseTs(row.anchorTs as Date | string);
  const endTs = parseTs(row.ts_now as Date | string);
  const mcapPct = mcapChangePct(row.anchorMcapUsd, row.nowMcapUsd);
  const mcapFrom =
    row.anchorMcapUsd != null && row.anchorMcapUsd > 0
      ? formatMarketCapUsd(row.anchorMcapUsd)
      : '?';
  const mcapTo =
    row.nowMcapUsd != null && row.nowMcapUsd > 0 ? formatMarketCapUsd(row.nowMcapUsd) : '?';
  const mcapPctHuman = mcapPct != null ? formatSignedPct(mcapPct) : '?';

  const escalationLine =
    row.isUpdate && typeof row.prevPct === 'number'
      ? `\nэскалация: ${escapeHtml(formatSignedPct(row.prevPct))} → <b>${escapeHtml(pctHuman)}</b>`
      : '';
  const tierLine = row.tierName ? `tier: ${escapeHtml(row.tierName)}\n` : '';

  const calcBlock = [
    `<i>${escapeHtml(spikeSignalExplain(row))} · ${escapeHtml(row.dex)}</i>`,
    `Δ <b>цена</b> ${escapeHtml(pctHuman)}: ${escapeHtml(formatPriceUsd(row.anchorPx))} → ${escapeHtml(formatPriceUsd(row.px_now))}`,
    `  ${escapeHtml(formatDisplayDt(anchorTs))} → ${escapeHtml(formatDisplayDt(endTs))}`,
    `Δ <b>mcap</b> ${escapeHtml(mcapPctHuman)}: ${escapeHtml(mcapFrom)} → ${escapeHtml(mcapTo)}`,
  ].join('\n');

  let body =
    `${headline}\n` +
    `${tag} ${kindWord} <b>${escapeHtml(pctHuman)}</b>${escalationLine}\n` +
    tierLine +
    `\n${calcBlock}\n` +
    `\n<a href="${gmgnUrl}">GMGN</a> · <code>${escapeHtml(mint)}</code>\n` +
    `holders: ${row.holder_count ?? '?'}`;
  const displayLiq = row.best_pool_liq_usd ?? row.liq_usd;
  if (displayLiq != null && displayLiq > 0) body += `\nliq ~${Math.round(displayLiq)} USD`;
  return body;
}

function buildAlertPlain(row: AlertRow): string {
  const mint = row.base_mint.trim();
  const sym = row.symbol?.trim() || '?';
  const { tag, kindWord } = alertKindTag(row);
  const nameRaw = row.token_name?.trim();
  const headline =
    sym !== '?' && nameRaw && nameRaw.toUpperCase() !== sym.toUpperCase()
      ? `${sym} (${nameRaw})`
      : sym !== '?'
        ? sym
        : nameRaw || '?';
  const escalationLine =
    row.isUpdate && typeof row.prevPct === 'number'
      ? `\nэскалация: ${formatSignedPct(row.prevPct)} → ${formatSignedPct(row.pct)}`
      : '';
  const tierLine = row.tierName ? `tier: ${row.tierName}\n` : '';
  let body =
    `${headline}\n` +
    `${tag} ${kindWord} ${formatSignedPct(row.pct)}${escalationLine}\n` +
    tierLine +
    `\nGMGN: ${gmgnSolTokenUrl(mint)}\n` +
    `${mint}\n` +
    `holders: ${row.holder_count ?? '?'}`;
  const displayLiq = row.best_pool_liq_usd ?? row.liq_usd;
  if (displayLiq != null && displayLiq > 0) body += `\nliq ~${Math.round(displayLiq)} USD`;
  return body;
}

async function fetchLatestOnly(table: DexTable): Promise<LatestMeta[]> {
  const q = buildLatestOnlyQuery(table);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  const out: LatestMeta[] = [];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    if (!mint) continue;
    const fdvRaw = row.token_fdv_usd;
    const fdvNum = fdvRaw != null ? Number(fdvRaw) : NaN;
    out.push({
      base_mint: mint,
      pair_address: String(row.pair_address ?? ''),
      px_now: Number(row.px_now),
      ts_now: row.ts_now as Date | string,
      symbol: row.symbol != null ? String(row.symbol) : null,
      token_name: row.token_name != null ? String(row.token_name) : null,
      holder_count: row.holder_count != null ? Number(row.holder_count) : null,
      liq_usd: row.liq_usd != null ? Number(row.liq_usd) : null,
      token_fdv_usd: Number.isFinite(fdvNum) && fdvNum > 0 ? fdvNum : null,
    });
  }
  return out;
}

async function fetchBarsBatch(
  table: DexTable,
  latestRows: LatestMeta[],
): Promise<Map<string, Bar[]>> {
  const map = new Map<string, Bar[]>();
  if (latestRows.length === 0) return map;
  const tupleSql = sqlMintPairInTuples(latestRows);
  if (tupleSql === null) return map;
  const q = buildBarsQuery(table, tupleSql);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    const pair = String(row.pair_address ?? '');
    const px = Number(row.price_usd);
    if (!mint || !pair || !(px > 0)) continue;
    const ts = parseTs(row.ts as Date | string);
    const mcapUsd = parseMcapUsd(row);
    const volRaw = row.vol_5m;
    const volNum = volRaw != null ? Number(volRaw) : NaN;
    const vol5m = Number.isFinite(volNum) ? volNum : null;
    const key = barsMapKey(mint, pair);
    const arr = map.get(key) ?? [];
    arr.push({ ts, px, mcapUsd, vol5m });
    map.set(key, arr);
  }
  return map;
}

type SendTelegramResult = { ok: boolean; messageId: number | null };

async function sendTelegram(text: string, parseMode?: 'HTML'): Promise<SendTelegramResult> {
  if (!TG_TOKEN || !TG_CHAT) return { ok: false, messageId: null };
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: TG_CHAT,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.warn(
      '[market-spike-telegram-watch] sendMessage failed',
      res.status,
      errBody.slice(0, 400),
    );
    return { ok: false, messageId: null };
  }
  let messageId: number | null = null;
  try {
    const j = (await res.json()) as { result?: { message_id?: number } };
    if (j.result?.message_id != null) messageId = Number(j.result.message_id);
  } catch {
    messageId = null;
  }
  return { ok: true, messageId };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tokenMetaLooksMissing(v: string | null | undefined): boolean {
  const t = v?.trim();
  return !t || t === '?';
}

function needsDexMeta(meta: LatestMeta): boolean {
  return tokenMetaLooksMissing(meta.symbol) || tokenMetaLooksMissing(meta.token_name);
}

function truncateTokenMetaField(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

async function fetchDexscreenerTokenMetaForMints(mints: string[]): Promise<Map<string, DexTokenMeta>> {
  const out = new Map<string, DexTokenMeta>();
  const now = Date.now();
  const unique = [...new Set(mints.map((m) => m.trim()).filter((m) => ADDR_RE.test(m)))];
  const toRequest: string[] = [];
  for (const m of unique) {
    const c = dexMetaCache.get(m);
    if (c && now - c.at < DEX_META_CACHE_TTL_MS) {
      out.set(m, c.meta);
    } else {
      toRequest.push(m);
    }
  }

  for (let i = 0; i < toRequest.length; i += DEX_META_CHUNK) {
    const chunk = toRequest.slice(i, i + DEX_META_CHUNK);
    const chunkSet = new Set(chunk);
    let apiOk = false;
    const fromPairs = new Map<string, DexTokenMeta>();
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map((m) => encodeURIComponent(m)).join(',')}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      apiOk = r.ok;
      if (r.ok) {
        const j = (await r.json()) as {
          pairs?: { baseToken?: { address?: string; symbol?: string; name?: string } }[];
        };
        const firstSeenAddr = new Set<string>();
        for (const p of j.pairs ?? []) {
          const addr = String(p.baseToken?.address ?? '').trim();
          if (!ADDR_RE.test(addr) || firstSeenAddr.has(addr) || !chunkSet.has(addr)) continue;
          firstSeenAddr.add(addr);
          const sym = String(p.baseToken?.symbol ?? '').trim() || null;
          const nam = String(p.baseToken?.name ?? '').trim() || null;
          fromPairs.set(addr, { symbol: sym, name: nam });
        }
      }
    } catch {
      apiOk = false;
    }

    if (apiOk) {
      for (const m of chunk) {
        const meta = fromPairs.get(m) ?? { symbol: null, name: null };
        dexMetaCache.set(m, { meta, at: Date.now() });
        out.set(m, meta);
      }
    }

    if (i + DEX_META_CHUNK < toRequest.length) await sleepMs(350);
  }

  return out;
}

async function upsertTokenMetaFromDex(mint: string, meta: DexTokenMeta): Promise<void> {
  const sym = meta.symbol ? truncateTokenMetaField(meta.symbol, 120) : null;
  const nam = meta.name ? truncateTokenMetaField(meta.name, 240) : null;
  if (!sym && !nam) return;
  // Раньше тут было pgSql.json({ source: 'spike_watch_dexscreener' }) — оно возвращало объект,
  // который драйвер пытался передать как plain string. Это приводило к TypeError ERR_INVALID_ARG_TYPE
  // («Received an instance of Object») и шуму каждые 20 сек в error.log. В этом UPSERT мы всё равно
  // не трогаем поле metadata — только symbol/name. Если в `tokens` для нового mint ничего нет,
  // запись будет создана с metadata=NULL (поле допускает NULL). Это безопасно для остального продукта,
  // т.к. этим UPSERT в `tokens` пишет только spike-watch для обогащения symbol/name из Dexscreener.
  try {
    await pgSql`
      INSERT INTO tokens (mint, symbol, name, decimals, updated_at)
      VALUES (
        ${mint},
        ${sym},
        ${nam},
        0,
        now()
      )
      ON CONFLICT (mint) DO UPDATE SET
        symbol = COALESCE(NULLIF(TRIM(tokens.symbol), ''), EXCLUDED.symbol),
        name = COALESCE(NULLIF(TRIM(tokens.name), ''), EXCLUDED.name),
        updated_at = now()
    `;
  } catch (e) {
    console.warn(
      '[market-spike-telegram-watch] token upsert failed',
      mint.slice(0, 12),
      String(e),
    );
  }
}

async function enrichAlertRowsWithDexMeta(rows: Iterable<AlertRow>): Promise<void> {
  if (!DEXSCREENER_META_ENABLED) return;
  const list = [...rows].filter((r) => needsDexMeta(r));
  if (!list.length) return;
  const mints = list.map((r) => r.base_mint.trim());
  const metaByMint = await fetchDexscreenerTokenMetaForMints(mints);
  for (const row of list) {
    const m = metaByMint.get(row.base_mint.trim());
    if (!m) continue;
    if (m.symbol && tokenMetaLooksMissing(row.symbol)) row.symbol = m.symbol;
    if (m.name && tokenMetaLooksMissing(row.token_name)) row.token_name = m.name;
    if (UPSERT_TOKEN_META_FROM_DEX && (m.symbol || m.name)) {
      await upsertTokenMetaFromDex(row.base_mint.trim(), m);
    }
  }
}

function pruneSendDedupe(map: Map<string, number>, olderThanMs: number): void {
  const cut = Date.now() - olderThanMs;
  for (const [k, t] of map) {
    if (t < cut) map.delete(k);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Эскалация: state в RAM + чистая функция-арбитр (тестируемая отдельно).
// ────────────────────────────────────────────────────────────────────────────────

export type MintEscalationState = {
  /** |pct| последнего отправленного алерта (sent или update). */
  lastSentAbsPct: number;
  /** Знак (true=pump,false=dump) последнего алерта. Эскалация только в ту же сторону. */
  lastWasPump: boolean;
  /** Tier-rank на момент последнего алерта. */
  lastTierRank: 0 | 1 | 2 | 3;
  /** Последний lastTierRank — для лога. */
  lastTierName: string;
  /** epoch ms последнего алерта. */
  lastSentAtMs: number;
  /** ts опоры (дно/хай) последнего отправленного алерта — для антидубля «той же ноги». */
  lastSentAnchorTsMs: number;
  /** Сколько UPDATE-алертов было после первого SENT (без учёта первого). */
  updatesSent: number;
};

/**
 * Тот же памп/пролив, что уже сообщали: та же сторона и опора не «откатилась» назад
 * (при rolling-окне опора только уползает вперёд — это продолжение, не новое событие).
 */
export function isDuplicateOngoingSpike(
  prev: Pick<MintEscalationState, 'lastWasPump' | 'lastSentAnchorTsMs'> | null,
  candidate: { pct: number; anchorTs: Date },
): boolean {
  if (!prev) return false;
  const isPump = candidate.pct >= 0;
  if (isPump !== prev.lastWasPump) return false;
  const prevAnchor = prev.lastSentAnchorTsMs;
  if (prevAnchor == null || !Number.isFinite(prevAnchor)) return false;
  const anchorMs = candidate.anchorTs.getTime();
  if (anchorMs < prevAnchor - LEG_ANCHOR_SLACK_MS) return false;
  return true;
}

export function spikeAlertEventDedupeKey(row: {
  base_mint: string;
  dex: string;
  anchorTs: Date | string;
  pct: number;
}): string {
  const anchorTs = parseTs(row.anchorTs as Date | string);
  return `${row.base_mint.trim()}|${row.dex}|${anchorTs.toISOString()}|${row.pct >= 0 ? 'u' : 'd'}`;
}

export type EscalationDecision =
  | {
      kind: 'first';
      reason: 'no_prev_state' | 'cooldown_expired' | 'new_move_leg';
    }
  | {
      kind: 'update';
      reason: 'tier_change' | 'delta_pct';
    }
  | {
      kind: 'skip';
      reason:
        | 'cooldown_no_escalation'
        | 'gap_too_small'
        | 'max_updates_reached'
        | 'wrong_side'
        | 'pct_below_prev';
    };

/**
 * Принимает решение о посылке/пропуске алерта по mint в рамках эскалации.
 * - Если prev state нет — отправляем как «first».
 * - Если cooldown истёк — отправляем как «first» (это де-факто новый алерт).
 * - Если внутри cooldown:
 *   - Только в ту же сторону (pump/dump);
 *   - tier стал жёстче (rank упал) и `tier_change_forces_update`=true → update;
 *   - |pct| - |prev| ≥ ESCALATE_DELTA_PCT и прошло ≥ ESCALATE_MIN_GAP_SEC → update;
 *   - Иначе skip (с конкретной причиной).
 */
export function decideEscalation(args: {
  prev: MintEscalationState | null;
  candidatePct: number;
  candidateTierRank: 0 | 1 | 2 | 3;
  nowMs: number;
  cooldownMs: number;
  escalateEnabled: boolean;
  escalateDeltaPct: number;
  escalateMinGapSec: number;
  escalateMaxPerMint: number;
  tierChangeForcesUpdate: boolean;
}): EscalationDecision {
  const {
    prev,
    candidatePct,
    candidateTierRank,
    nowMs,
    cooldownMs,
    escalateEnabled,
    escalateDeltaPct,
    escalateMinGapSec,
    escalateMaxPerMint,
    tierChangeForcesUpdate,
  } = args;

  if (!prev) return { kind: 'first', reason: 'no_prev_state' };

  const sinceMs = nowMs - prev.lastSentAtMs;
  if (cooldownMs > 0 && sinceMs >= cooldownMs) {
    return { kind: 'first', reason: 'cooldown_expired' };
  }
  // Cooldown ещё активен — здесь только эскалация может отправить.
  if (!escalateEnabled) return { kind: 'skip', reason: 'cooldown_no_escalation' };

  const isPump = candidatePct >= 0;
  if (isPump !== prev.lastWasPump) return { kind: 'skip', reason: 'wrong_side' };

  const absNew = Math.abs(candidatePct);
  const absPrev = prev.lastSentAbsPct;
  if (absNew <= absPrev) return { kind: 'skip', reason: 'pct_below_prev' };

  if (escalateMaxPerMint > 0 && prev.updatesSent >= escalateMaxPerMint) {
    return { kind: 'skip', reason: 'max_updates_reached' };
  }
  if (sinceMs < escalateMinGapSec * 1000) {
    return { kind: 'skip', reason: 'gap_too_small' };
  }

  // tier стал жёстче? (для дампа — rank уменьшился; pump — обычно не происходит)
  const tierTighter = !isPump && candidateTierRank < prev.lastTierRank;
  if (tierTighter && tierChangeForcesUpdate) {
    return { kind: 'update', reason: 'tier_change' };
  }

  if (absNew - absPrev >= escalateDeltaPct) {
    return { kind: 'update', reason: 'delta_pct' };
  }
  return { kind: 'skip', reason: 'cooldown_no_escalation' };
}

function pruneMintEscalationState(map: Map<string, MintEscalationState>): void {
  // Чистим записи старше двух MINT_COOLDOWN_MS (или 30 мин при cooldown=0).
  const ttl = MINT_COOLDOWN_MS > 0 ? MINT_COOLDOWN_MS * 2 : 30 * 60_000;
  const cut = Date.now() - ttl;
  for (const [k, v] of map) {
    if (v.lastSentAtMs < cut) map.delete(k);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Аудит: stdout-лог + опциональная запись в PG (graceful fallback).
// ────────────────────────────────────────────────────────────────────────────────

type SpikeEventStatus = 'sent' | 'update' | 'skip' | 'miss';

type SpikeEventRecord = {
  status: SpikeEventStatus;
  mint: string;
  pair_address: string;
  dex: string;
  pct: number;
  signal_kind: SpikeSignalKind;
  rolling_span_minutes: number | null;
  anchor_px: number;
  now_px: number;
  anchor_ts: Date;
  ts_new: Date;
  anchor_mcap_usd: number | null;
  now_mcap_usd: number | null;
  ref_mcap_usd: number | null;
  tier_name: string | null;
  liq_usd: number | null;
  symbol: string | null;
  token_name: string | null;
  skip_reason: string | null;
  prev_pct: number | null;
  prev_sent_at_ms: number | null;
  telegram_msg_id: number | null;
};

let auditTableReady: 'unknown' | 'ok' | 'failed' = 'unknown';

async function ensureAuditTable(): Promise<void> {
  if (!AUDIT_DB_ENABLED) {
    auditTableReady = 'failed';
    return;
  }
  if (auditTableReady === 'ok' || auditTableReady === 'failed') return;
  try {
    await db.execute(
      dsql.raw(`
CREATE TABLE IF NOT EXISTS market_spike_events (
  id              BIGSERIAL PRIMARY KEY,
  ts_event        TIMESTAMPTZ NOT NULL DEFAULT now(),
  mint            TEXT NOT NULL,
  pair_address    TEXT NOT NULL,
  dex             TEXT NOT NULL,
  pct             DOUBLE PRECISION NOT NULL,
  signal_kind     TEXT NOT NULL,
  rolling_span_minutes SMALLINT,
  anchor_px       DOUBLE PRECISION NOT NULL,
  now_px          DOUBLE PRECISION NOT NULL,
  anchor_ts       TIMESTAMPTZ NOT NULL,
  ts_new          TIMESTAMPTZ NOT NULL,
  anchor_mcap_usd DOUBLE PRECISION,
  now_mcap_usd    DOUBLE PRECISION,
  ref_mcap_usd    DOUBLE PRECISION,
  tier_name       TEXT,
  liq_usd         DOUBLE PRECISION,
  symbol          TEXT,
  token_name      TEXT,
  status          TEXT NOT NULL,
  skip_reason     TEXT,
  prev_pct        DOUBLE PRECISION,
  prev_sent_at    TIMESTAMPTZ,
  telegram_msg_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_market_spike_events_mint_ts ON market_spike_events (mint, ts_event DESC);
CREATE INDEX IF NOT EXISTS idx_market_spike_events_ts ON market_spike_events (ts_event DESC);
CREATE INDEX IF NOT EXISTS idx_market_spike_events_status_ts ON market_spike_events (status, ts_event DESC);
`),
    );
    auditTableReady = 'ok';
    console.log('[market-spike-telegram-watch] audit table market_spike_events ready');
  } catch (e) {
    auditTableReady = 'failed';
    console.warn(
      '[market-spike-telegram-watch] audit table CREATE failed (graceful, продолжаем без БД-аудита):',
      String(e).slice(0, 300),
    );
  }
}

async function recordSpikeEvent(rec: SpikeEventRecord): Promise<void> {
  // stdout: компактная строка для grep-расследований.
  const refMcapStr = rec.ref_mcap_usd != null ? formatMarketCapUsd(rec.ref_mcap_usd) : '?';
  const tag = `[market-spike][${rec.status.toUpperCase()}]`;
  const fields = [
    `dex=${rec.dex}`,
    `mint=${rec.mint.slice(0, 12)}`,
    `pair=${rec.pair_address.slice(0, 8)}`,
    `pct=${rec.pct.toFixed(2)}`,
    `signal=${rec.signal_kind}${
      rec.rolling_span_minutes ? `(${rec.rolling_span_minutes}m)` : ''
    }`,
    `tier=${rec.tier_name ?? '?'}`,
    `ref_mcap=${refMcapStr}`,
    `ts_new=${rec.ts_new.toISOString()}`,
  ];
  if (rec.skip_reason) fields.push(`reason=${rec.skip_reason}`);
  if (rec.prev_pct != null) fields.push(`prev_pct=${rec.prev_pct.toFixed(2)}`);
  if (rec.telegram_msg_id != null) fields.push(`tg_msg=${rec.telegram_msg_id}`);
  if (rec.symbol) fields.push(`sym=${rec.symbol}`);
  console.log(`${tag} ${fields.join(' ')}`);

  if (auditTableReady !== 'ok') return;
  if (rec.status === 'skip' && !AUDIT_LOG_SKIPS) return;
  try {
    await pgSql`
      INSERT INTO market_spike_events (
        mint, pair_address, dex, pct, signal_kind, rolling_span_minutes,
        anchor_px, now_px, anchor_ts, ts_new,
        anchor_mcap_usd, now_mcap_usd, ref_mcap_usd, tier_name,
        liq_usd, symbol, token_name, status, skip_reason,
        prev_pct, prev_sent_at, telegram_msg_id
      ) VALUES (
        ${rec.mint},
        ${rec.pair_address},
        ${rec.dex},
        ${rec.pct},
        ${rec.signal_kind},
        ${rec.rolling_span_minutes},
        ${rec.anchor_px},
        ${rec.now_px},
        ${rec.anchor_ts},
        ${rec.ts_new},
        ${rec.anchor_mcap_usd},
        ${rec.now_mcap_usd},
        ${rec.ref_mcap_usd},
        ${rec.tier_name},
        ${rec.liq_usd},
        ${rec.symbol},
        ${rec.token_name},
        ${rec.status},
        ${rec.skip_reason},
        ${rec.prev_pct},
        ${rec.prev_sent_at_ms != null ? new Date(rec.prev_sent_at_ms) : null},
        ${rec.telegram_msg_id}
      )
    `;
  } catch (e) {
    console.warn(
      '[market-spike-telegram-watch] audit insert failed (graceful):',
      String(e).slice(0, 300),
    );
    auditTableReady = 'failed';
  }
}

function recordToEvent(
  status: SpikeEventStatus,
  row: AlertRow,
  extra: { skipReason?: string; tgMsgId?: number | null } = {},
): SpikeEventRecord {
  return {
    status,
    mint: row.base_mint,
    pair_address: row.pair_address,
    dex: row.dex,
    pct: row.pct,
    signal_kind: row.signalKind,
    rolling_span_minutes: row.rollingSpanMinutes ?? null,
    anchor_px: row.anchorPx,
    now_px: row.px_now,
    anchor_ts: parseTs(row.anchorTs as Date | string),
    ts_new: parseTs(row.ts_now as Date | string),
    anchor_mcap_usd: row.anchorMcapUsd,
    now_mcap_usd: row.nowMcapUsd,
    ref_mcap_usd: row.refMcapUsd ?? null,
    tier_name: row.tierName ?? null,
    liq_usd: row.liq_usd,
    symbol: row.symbol,
    token_name: row.token_name,
    skip_reason: extra.skipReason ?? null,
    prev_pct: row.prevPct ?? null,
    prev_sent_at_ms: row.prevSentAtMs ?? null,
    telegram_msg_id: extra.tgMsgId ?? null,
  };
}

type MintBestPool = { pair: string; liq: number };

/** Синхронизирует tokens.primary_pair / liquidity_usd с пулом max liq из свежих снимков. */
async function refreshTokensPrimaryPairs(mintBestPool: Map<string, MintBestPool>): Promise<number> {
  if (mintBestPool.size === 0) return 0;
  let updated = 0;
  const CHUNK = 40;
  const entries = [...mintBestPool.entries()];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    for (const [mint, best] of chunk) {
      const m = mint.trim();
      const pair = best.pair.trim();
      if (!ADDR_RE.test(m) || !ADDR_RE.test(pair) || !(best.liq > 0)) continue;
      try {
        const r = await pgSql`
          UPDATE tokens
          SET primary_pair = ${pair},
              liquidity_usd = ${best.liq},
              updated_at = now()
          WHERE mint = ${m}
            AND (
              primary_pair IS DISTINCT FROM ${pair}
              OR liquidity_usd IS DISTINCT FROM ${best.liq}
            )
        `;
        const n = Number((r as { count?: number }).count ?? 0);
        if (n > 0) updated += n;
      } catch (e) {
        console.warn(
          `[market-spike-telegram-watch] primary_pair update failed mint=${m.slice(0, 8)}…`,
          String(e).slice(0, 200),
        );
      }
    }
  }
  return updated;
}

async function runOnePass(
  sendDedupe: Map<string, number> | null,
  mintEscState: Map<string, MintEscalationState>,
): Promise<void> {
  // merged: per-mint лучший pick по abs|pct| среди ВСЕХ пар всех DEX-таблиц.
  const merged = new Map<string, AlertRow>();
  // tier-MISS: записываем для retro-анализа (только если LOG_MISS_BY_FILTER=1).
  const missEvents: SpikeEventRecord[] = [];
  const mintMaxLiq = new Map<string, number>();
  const mintBestPool = new Map<string, MintBestPool>();
  const tableLatest: { table: DexTable; rows: LatestMeta[] }[] = [];

  for (const table of SNAPSHOT_TABLES) {
    try {
      const latestRows = await fetchLatestOnly(table);
      tableLatest.push({ table, rows: latestRows });
      for (const meta of latestRows) {
        const liq = meta.liq_usd ?? 0;
        if (!(liq > 0)) continue;
        const prev = mintMaxLiq.get(meta.base_mint) ?? 0;
        if (liq > prev) {
          mintMaxLiq.set(meta.base_mint, liq);
          mintBestPool.set(meta.base_mint, { pair: meta.pair_address, liq });
        }
      }
    } catch (e) {
      console.warn(`[market-spike-telegram-watch] ${table} latest query failed`, String(e));
    }
  }

  for (const { table, rows: latestRows } of tableLatest) {
    let barsByMintPair: Map<string, Bar[]>;
    try {
      barsByMintPair = await fetchBarsBatch(table, latestRows);
    } catch (e) {
      console.warn(`[market-spike-telegram-watch] ${table} bars query failed`, String(e));
      continue;
    }

    const dex = dexLabel(table);
    const nowMs = Date.now();
    for (const meta of latestRows) {
      if (isSpikeTelegramBlacklisted(meta.base_mint, meta.symbol, meta.token_name)) continue;

      const mintMax = mintMaxLiq.get(meta.base_mint) ?? null;
      if (isDeadPoolVsMintMaxLiq(meta.liq_usd, mintMax)) continue;

      // Multi-pair: bars берём по конкретной паре (mint+pair), а не по mint целиком.
      const bars = barsByMintPair.get(barsMapKey(meta.base_mint, meta.pair_address)) ?? [];
      const pick = analyzeBarsForMint(bars);
      if (!pick) continue;
      if (!isPickFreshEnough(pick, nowMs)) continue;
      if (isStaleZeroVolPriceJump(bars, pick)) continue;
      if (!isPickPlausibleForLiquidity(pick, meta.liq_usd)) continue;
      if (!isPickPlausibleLiqVsMcap(meta, pick)) continue;
      if (!isPickPriceMcapConsistent(pick)) continue;
      if (!isPickMcapSignAligned(pick)) continue;
      if (!isRollingPickAnchoredAtExtreme(bars, pick)) continue;

      const refMcap = referenceMcapUsd(meta, pick);
      const tierName = tierLabel(refMcap);
      const isPump = pick.pct >= 0;

      // Tier-фильтр по market cap. Финальное решение «слать или нет» при TIERED_BY_MCAP=1.
      if (TIERED_BY_MCAP) {
        const required = tierRequiredMinAbsPct(refMcap, isPump, pick.signalKind);
        if (required == null) {
          if (LOG_MISS_BY_FILTER) {
            const missRow: AlertRow = {
              ...meta,
              dex,
              pct: pick.pct,
              px_now: pick.pxNow,
              ts_now: pick.tsNew,
              windowLabel: pick.windowLabel,
              signalKind: pick.signalKind,
              rollingSpanMinutes: pick.rollingSpanMinutes,
              anchorPx: pick.anchorPx,
              anchorTs: pick.anchorTs,
              anchorMcapUsd: pick.anchorMcapUsd,
              nowMcapUsd: pick.nowMcapUsd,
              refMcapUsd: refMcap,
              tierName,
            };
            missEvents.push(recordToEvent('miss', missRow, { skipReason: 'below_tier1' }));
          }
          continue;
        }
        if (Math.abs(pick.pct) < required) {
          if (LOG_MISS_BY_FILTER) {
            const missRow: AlertRow = {
              ...meta,
              dex,
              pct: pick.pct,
              px_now: pick.pxNow,
              ts_now: pick.tsNew,
              windowLabel: pick.windowLabel,
              signalKind: pick.signalKind,
              rollingSpanMinutes: pick.rollingSpanMinutes,
              anchorPx: pick.anchorPx,
              anchorTs: pick.anchorTs,
              anchorMcapUsd: pick.anchorMcapUsd,
              nowMcapUsd: pick.nowMcapUsd,
              refMcapUsd: refMcap,
              tierName,
            };
            missEvents.push(
              recordToEvent('miss', missRow, {
                skipReason: `tier_below_${pick.signalKind}_required_${required}`,
              }),
            );
          }
          continue;
        }
      }

      const row: AlertRow = {
        ...meta,
        dex,
        pct: pick.pct,
        px_now: pick.pxNow,
        ts_now: pick.tsNew,
        windowLabel: pick.windowLabel,
        signalKind: pick.signalKind,
        rollingSpanMinutes: pick.rollingSpanMinutes,
        anchorPx: pick.anchorPx,
        anchorTs: pick.anchorTs,
        anchorMcapUsd: pick.anchorMcapUsd,
        nowMcapUsd: pick.nowMcapUsd,
        refMcapUsd: refMcap,
        tierName,
        best_pool_liq_usd: mintMax ?? meta.liq_usd,
      };

      const prev = merged.get(meta.base_mint);
      if (!prev || Math.abs(pick.pct) > Math.abs(prev.pct)) merged.set(meta.base_mint, row);
    }
  }

  if (PRIMARY_PAIR_REFRESH_ENABLED && mintBestPool.size > 0) {
    try {
      const n = await refreshTokensPrimaryPairs(mintBestPool);
      if (n > 0) {
        console.log(`[market-spike-telegram-watch] primary_pair refresh updated=${n}`);
      }
    } catch (e) {
      console.warn('[market-spike-telegram-watch] primary_pair refresh failed', String(e));
    }
  }

  // Логируем tier-MISS-события один раз за проход (после слияния).
  for (const ev of missEvents) {
    await recordSpikeEvent(ev);
  }

  try {
    await enrichAlertRowsWithDexMeta(merged.values());
  } catch (e) {
    console.warn('[market-spike-telegram-watch] dex meta enrich failed', String(e));
  }

  let sentFirst = 0;
  let sentUpdate = 0;
  let skipped = 0;
  if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
    pruneSendDedupe(sendDedupe, POLL_SEND_DEDUPE_MS * 3);
  }
  pruneMintEscalationState(mintEscState);

  for (const [, row] of merged) {
    const mintKey = row.base_mint.trim();
    const nowMs = Date.now();

    if (isSpikeTelegramBlacklisted(row.base_mint, row.symbol, row.token_name)) {
      skipped++;
      await recordSpikeEvent(recordToEvent('skip', row, { skipReason: 'mint_blacklist' }));
      continue;
    }

    const prevState = mintEscState.get(mintKey) ?? null;
    const anchorTs = parseTs(row.anchorTs as Date | string);

    if (isDuplicateOngoingSpike(prevState, { pct: row.pct, anchorTs })) {
      skipped++;
      await recordSpikeEvent(recordToEvent('skip', row, { skipReason: 'same_spike_leg' }));
      continue;
    }

    // POLL_SEND_DEDUPE — тот же ключ, что и «нога» (mint+dex+anchor+side), не ts_new.
    if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
      const dedupeKey = spikeAlertEventDedupeKey(row);
      const last = sendDedupe.get(dedupeKey) ?? 0;
      if (nowMs - last < POLL_SEND_DEDUPE_MS) {
        skipped++;
        await recordSpikeEvent(recordToEvent('skip', row, { skipReason: 'poll_send_dedupe' }));
        continue;
      }
    }

    // Эскалация / cooldown (cooldown не блокирует новую ногу — см. bypass ниже).
    const refMcap = row.refMcapUsd ?? referenceMcapUsd(row, {
      pct: row.pct,
      anchorPx: row.anchorPx,
      pxNow: row.px_now,
      anchorMcapUsd: row.anchorMcapUsd,
      nowMcapUsd: row.nowMcapUsd,
      anchorTs: parseTs(row.anchorTs as Date | string),
      tsNew: parseTs(row.ts_now as Date | string),
      windowLabel: row.windowLabel,
      signalKind: row.signalKind,
      rollingSpanMinutes: row.rollingSpanMinutes,
    });
    const candidateTierRank = tierRank(refMcap);

    let decision = decideEscalation({
      prev: prevState,
      candidatePct: row.pct,
      candidateTierRank,
      nowMs,
      cooldownMs: MINT_COOLDOWN_MS,
      escalateEnabled: ESCALATE_ENABLED,
      escalateDeltaPct: ESCALATE_DELTA_PCT,
      escalateMinGapSec: ESCALATE_MIN_GAP_SEC,
      escalateMaxPerMint: ESCALATE_MAX_PER_MINT,
      tierChangeForcesUpdate: ESCALATE_TIER_CHANGE_FORCES_UPDATE,
    });

    if (
      decision.kind === 'skip' &&
      decision.reason === 'cooldown_no_escalation' &&
      !isDuplicateOngoingSpike(prevState, { pct: row.pct, anchorTs })
    ) {
      decision = { kind: 'first', reason: 'new_move_leg' };
    }

    if (decision.kind === 'skip') {
      skipped++;
      await recordSpikeEvent(recordToEvent('skip', row, { skipReason: decision.reason }));
      continue;
    }

    if (decision.kind === 'update' && prevState) {
      row.isUpdate = true;
      row.prevPct = prevState.lastSentAbsPct * (prevState.lastWasPump ? 1 : -1);
      row.prevTierName = prevState.lastTierName;
      row.prevSentAtMs = prevState.lastSentAtMs;
    }

    if (DRY_RUN) {
      console.log('[DRY_RUN]', buildAlertPlain(row));
      // В DRY_RUN тоже фиксируем решение в стейте, чтобы эскалация работала корректно при отладке.
      mintEscState.set(mintKey, {
        lastSentAbsPct: Math.abs(row.pct),
        lastWasPump: row.pct >= 0,
        lastTierRank: candidateTierRank,
        lastTierName: row.tierName ?? tierLabel(refMcap),
        lastSentAtMs: nowMs,
        lastSentAnchorTsMs: anchorTs.getTime(),
        updatesSent: decision.kind === 'update' ? (prevState?.updatesSent ?? 0) + 1 : 0,
      });
      if (decision.kind === 'update') sentUpdate++;
      else sentFirst++;
      await recordSpikeEvent(
        recordToEvent(decision.kind === 'update' ? 'update' : 'sent', row, {
          tgMsgId: null,
        }),
      );
      continue;
    }

    const htmlBody = buildAlertHtml(row);
    const tg = await sendTelegram(htmlBody, 'HTML');
    if (tg.ok) {
      if (decision.kind === 'update') sentUpdate++;
      else sentFirst++;
      if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
        sendDedupe.set(spikeAlertEventDedupeKey(row), Date.now());
      }
      mintEscState.set(mintKey, {
        lastSentAbsPct: Math.abs(row.pct),
        lastWasPump: row.pct >= 0,
        lastTierRank: candidateTierRank,
        lastTierName: row.tierName ?? tierLabel(refMcap),
        lastSentAtMs: Date.now(),
        lastSentAnchorTsMs: anchorTs.getTime(),
        updatesSent: decision.kind === 'update' ? (prevState?.updatesSent ?? 0) + 1 : 0,
      });
      await recordSpikeEvent(
        recordToEvent(decision.kind === 'update' ? 'update' : 'sent', row, {
          tgMsgId: tg.messageId,
        }),
      );
    } else {
      console.warn(
        '[market-spike-telegram-watch] Telegram send failed for',
        row.base_mint.slice(0, 12),
      );
      await recordSpikeEvent(recordToEvent('skip', row, { skipReason: 'tg_send_failed' }));
    }
    await sleepMs(200);
  }

  const rollLog = ROLLING_RANGE_ENABLED
    ? ` rolling=${ROLLING_MINUTES_MIN}-${ROLLING_MINUTES_MAX}m`
    : ' rolling=off';
  const pollLog = POLL_INTERVAL_MS > 0 ? ` poll=${POLL_INTERVAL_MS}ms` : ' poll=off(cron)';
  const tieredLog = TIERED_BY_MCAP
    ? ` tier_dump_consec=${DUMP_TIER3_MIN_PCT_CONSEC}/${DUMP_TIER2_MIN_PCT_CONSEC}/${DUMP_TIER1_MIN_PCT_CONSEC}% tier_dump_rolling=${DUMP_TIER3_MIN_PCT_ROLLING}/${DUMP_TIER2_MIN_PCT_ROLLING}/${DUMP_TIER1_MIN_PCT_ROLLING}% pump_min=${PUMP_MIN_PCT}%`
    : ` thr_consec_pump=${THRESHOLD_CONSEC_PUMP_PCT}% thr_consec_dump=${THRESHOLD_CONSEC_DUMP_PCT}% thr_rolling=${THRESHOLD_ROLLING_PCT}%`;
  const escLog = ESCALATE_ENABLED
    ? ` esc=on(delta=${ESCALATE_DELTA_PCT}% gap=${ESCALATE_MIN_GAP_SEC}s max=${ESCALATE_MAX_PER_MINT})`
    : ' esc=off';
  const auditLog = AUDIT_DB_ENABLED ? ` audit=db(${auditTableReady})` : ' audit=stdout';
  console.log(
    `[market-spike-telegram-watch] done candidates=${merged.size} sent=${sentFirst} updates=${sentUpdate} skipped=${skipped}${tieredLog}${escLog} mintCooldownMin=${MINT_COOLDOWN_MINUTES} minMcapUSD=${MIN_MARKET_CAP_USD} scan=${SCAN_MINUTES}m newer<=${MAX_NEWER_BAR_AGE_MIN}m deadPoolShareMin=${MIN_LIQ_SHARE_OF_MINT_MAX} staleZeroVolJump>=${STALE_ZERO_VOL_JUMP_PCT}% primaryPairRefresh=${PRIMARY_PAIR_REFRESH_ENABLED ? 'on' : 'off'} lowLiq<${LOW_LIQ_GLITCH_THRESHOLD_USD}USD_maxAbs=${LOW_LIQ_MAX_ABS_PCT}% glitchNextRetrace=${GLITCH_NEXT_BAR_RETRACE_MIN} liqMcapSanity=${LIQ_MCAP_SANITY_ENABLED ? `ref>=${LIQ_MCAP_REF_MIN_USD}USD ratio>=${MIN_LIQ_TO_REF_MCAP_RATIO}` : 'off'} mcPxDiv<=${MC_PRICE_MAX_DIVERGENCE_PCT}%${rollLog}${pollLog} legacy_lookback_sec=${LOOKBACK_SEC} holders>=${MIN_HOLDERS} age>=${MIN_AGE_HOURS}h tz=${DISPLAY_TZ} dexMeta=${DEXSCREENER_META_ENABLED ? 'on' : 'off'}${auditLog}`,
  );
}

function parseDiagnoseArgs(): { mint: string; atIso: string | null } | null {
  const argv = process.argv.slice(2);
  let mint: string | null = null;
  let atIso: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--diagnose-mint' || a === '--diagnose') {
      mint = argv[++i]?.trim() ?? null;
      continue;
    }
    if (a.startsWith('--diagnose-mint=')) {
      mint = a.slice('--diagnose-mint='.length).trim() || null;
      continue;
    }
    if (a === '--at') {
      atIso = argv[++i]?.trim() ?? null;
      continue;
    }
    if (a.startsWith('--at=')) {
      atIso = a.slice('--at='.length).trim() || null;
    }
  }
  if (!mint || !ADDR_RE.test(mint)) return null;
  return { mint, atIso };
}

/**
 * Одноразовая диагностика по mint: бары из PG до метки `--at` (или текущего времени),
 * pick, tier-порог, sanity-фильтры. Не шлёт Telegram, не трогает `SPIKE_ALERT_TELEGRAM_*`.
 *
 * Запуск: `npm run market-spike-telegram-watch -- --diagnose-mint <mint> [--at 2026-05-14T13:37:00Z]`
 */
async function runDiagnoseMint(mint: string, atIso: string | null): Promise<void> {
  const at = atIso ? new Date(atIso) : new Date();
  if (Number.isNaN(at.getTime())) {
    console.error('[diagnose] invalid --at, use ISO-8601, e.g. 2026-05-14T13:37:00Z');
    process.exit(1);
  }
  const nowMs = at.getTime();
  const mintEsc = mint.replace(/'/g, "''");
  const atIsoSql = at.toISOString();

  console.log(
    `[diagnose] mint=${mint} at=${atIsoSql} scan=${SCAN_MINUTES}m tiered=${TIERED_BY_MCAP ? '1' : '0'}`,
  );

  for (const table of SNAPSHOT_TABLES) {
    const dex = dexLabel(table);
    const pairsR = await db.execute(
      dsql.raw(`
      SELECT DISTINCT pair_address::text AS pair_address
      FROM ${table}
      WHERE base_mint = '${mintEsc}'
        AND ts <= '${atIsoSql}'::timestamptz
        AND ts > '${atIsoSql}'::timestamptz - interval '14 days'
      LIMIT 40
    `),
    );
    const prow = pairsR as unknown as Record<string, unknown>[];
    const pairs = prow.map((r) => String(r.pair_address ?? '')).filter((p) => ADDR_RE.test(p));
    if (!pairs.length) {
      console.log(`[diagnose] ${dex}: no pairs in PG window`);
      continue;
    }
    for (const pair of pairs) {
      const pairEsc = pair.replace(/'/g, "''");
      const metaR = await db.execute(
        dsql.raw(`
        SELECT price_usd::double precision AS px_now, ts AS ts_now,
               liquidity_usd::double precision AS liq_usd,
               symbol::text, name::text AS token_name, holder_count::int AS holder_count,
               fdv_usd::double precision AS token_fdv_usd
        FROM ${table} s
        LEFT JOIN tokens t ON t.mint = s.base_mint
        WHERE s.base_mint = '${mintEsc}' AND s.pair_address = '${pairEsc}'
          AND s.ts <= '${atIsoSql}'::timestamptz
        ORDER BY s.ts DESC
        LIMIT 1
      `),
      );
      const mrows = metaR as unknown as Record<string, unknown>[];
      const mr = mrows[0];
      const meta: LatestMeta = mr
        ? {
            base_mint: mint,
            pair_address: pair,
            px_now: Number(mr.px_now),
            ts_now: mr.ts_now as Date | string,
            symbol: mr.symbol != null ? String(mr.symbol) : null,
            token_name: mr.token_name != null ? String(mr.token_name) : null,
            holder_count: mr.holder_count != null ? Number(mr.holder_count) : null,
            liq_usd: mr.liq_usd != null ? Number(mr.liq_usd) : null,
            token_fdv_usd:
              mr.token_fdv_usd != null && Number.isFinite(Number(mr.token_fdv_usd))
                ? Number(mr.token_fdv_usd)
                : null,
          }
        : {
            base_mint: mint,
            pair_address: pair,
            px_now: 0,
            ts_now: at,
            symbol: null,
            token_name: null,
            holder_count: null,
            liq_usd: null,
            token_fdv_usd: null,
          };

      const barR = await db.execute(
        dsql.raw(`
        SELECT ts, price_usd::double precision AS price_usd,
          COALESCE(market_cap_usd, fdv_usd)::double precision AS mcap_usd,
          COALESCE(volume_5m, 0)::double precision AS vol_5m
        FROM ${table}
        WHERE base_mint = '${mintEsc}' AND pair_address = '${pairEsc}'
          AND ts > '${atIsoSql}'::timestamptz - (${SCAN_MINUTES} * interval '1 minute')
          AND ts <= '${atIsoSql}'::timestamptz
          AND COALESCE(price_usd, 0) > 0
        ORDER BY ts ASC
      `),
      );
      const rows = barR as unknown as Record<string, unknown>[];
      const rawBars: Bar[] = [];
      for (const row of rows) {
        const volRaw = row.vol_5m;
        const volNum = volRaw != null ? Number(volRaw) : NaN;
        rawBars.push({
          ts: parseTs(row.ts as Date | string),
          px: Number(row.price_usd),
          mcapUsd: parseMcapUsd(row),
          vol5m: Number.isFinite(volNum) ? volNum : null,
        });
      }
      const pick = analyzeBarsForMint(rawBars, nowMs);
      const pickStr = pick
        ? `${formatSignedPct(pick.pct)} ${pick.signalKind} ${pick.windowLabel}`
        : '(нет сигнала по барам)';
      console.log(`[diagnose] ${dex} pair=${pair} bars=${rawBars.length} → ${pickStr}`);
      if (!pick) continue;

      const fresh = isPickFreshEnough(pick, nowMs);
      const staleJump = isStaleZeroVolPriceJump(rawBars, pick);
      const liqPl = isPickPlausibleForLiquidity(pick, meta.liq_usd);
      const liqMc = isPickPlausibleLiqVsMcap(meta, pick);
      const mcDiv = isPickPriceMcapConsistent(pick);
      console.log(
        `  filters: fresh=${fresh} staleZeroVolJump=${staleJump} lowLiqPlausible=${liqPl} liqMcapSanity=${liqMc} mcPriceDivOk=${mcDiv}`,
      );

      const refMcap = referenceMcapUsd(meta, pick);
      if (TIERED_BY_MCAP) {
        const isPump = pick.pct >= 0;
        const req = tierRequiredMinAbsPct(refMcap, isPump, pick.signalKind);
        const passTier = req != null && Math.abs(pick.pct) >= req;
        console.log(
          `  tier: ref_mcap≈${formatMarketCapUsd(refMcap)} ${tierLabel(refMcap)} required=${req == null ? 'reject' : `${req}%`} pass=${passTier}`,
        );
      }
    }
  }
  console.log('[diagnose] done');
}

async function main(): Promise<void> {
  const diag = parseDiagnoseArgs();
  if (diag) {
    try {
      await runDiagnoseMint(diag.mint, diag.atIso);
    } catch (e) {
      console.error('[diagnose] fatal', e);
      process.exit(1);
    }
    process.exit(0);
    return;
  }

  if (!TG_TOKEN || !TG_CHAT) {
    console.error(
      '[market-spike-telegram-watch] Skip: set SPIKE_ALERT_TELEGRAM_BOT_TOKEN and SPIKE_ALERT_TELEGRAM_CHAT_ID (не используйте прод TELEGRAM_* Live Oscar).',
    );
    process.exit(0);
  }

  await ensureAuditTable();

  if (POLL_INTERVAL_MS > 0) {
    const sendDedupe = new Map<string, number>();
    const mintEscState = new Map<string, MintEscalationState>();
    console.log(
      `[market-spike-telegram-watch] poll mode: interval=${POLL_INTERVAL_MS}ms poll_send_dedupe=${POLL_SEND_DEDUPE_MS}ms mint_cooldown_min=${MINT_COOLDOWN_MINUTES} esc=${ESCALATE_ENABLED ? `on(delta=${ESCALATE_DELTA_PCT}% gap=${ESCALATE_MIN_GAP_SEC}s max=${ESCALATE_MAX_PER_MINT})` : 'off'} audit_db=${AUDIT_DB_ENABLED ? auditTableReady : 'off'}`,
    );
    let stop = false;
    const onStop = (): void => {
      stop = true;
    };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    while (!stop) {
      try {
        await runOnePass(sendDedupe, mintEscState);
      } catch (e) {
        console.warn('[market-spike-telegram-watch] cycle error', String(e));
      }
      let waited = 0;
      while (waited < POLL_INTERVAL_MS && !stop) {
        const chunk = Math.min(500, POLL_INTERVAL_MS - waited);
        await sleepMs(chunk);
        waited += chunk;
      }
    }
    process.exit(0);
    return;
  }

  await runOnePass(null, new Map<string, MintEscalationState>());
}

/**
 * Скрипт запускается напрямую (`npm run market-spike-telegram-watch`). Когда модуль импортируется
 * из тестов (vitest), мы не должны автоматически коннектиться к PG/Telegram — иначе тесты
 * непредсказуемо ломаются. Защита: env `SPIKE_ALERT_SKIP_MAIN=1` подавляет автозапуск.
 */
if (process.env.SPIKE_ALERT_SKIP_MAIN !== '1') {
  main().catch((e) => {
    console.error('[market-spike-telegram-watch] fatal', e);
    process.exit(1);
  });
}
