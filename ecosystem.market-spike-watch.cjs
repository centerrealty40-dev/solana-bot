/**
 * Отдельный PM2-профиль — не смешивать с ecosystem.config.cjs, чтобы не делать
 * `pm2 reload` всего продакшена при добавлении watch-only задачи.
 *
 * Запуск на VPS (из корня репозитория). PM2 6 на хосте воспринимает этот .cjs как обычный скрипт Node,
 * а не ecosystem — используйте bash-обёртку:
 *
 *   chmod +x scripts/spike-watch-pm2-entry.sh
 *   pm2 start scripts/spike-watch-pm2-entry.sh --name market-spike-telegram-watch \
 *     --cwd /opt/solana-alpha --interpreter bash --merge-logs --time
 *   pm2 save
 *
 * Блок `apps` ниже оставлен как документация env (дублируется в spike-watch-pm2-entry.sh).
 *
 * По умолчанию — долгоживущий процесс с опросом PG каждые SPIKE_ALERT_POLL_INTERVAL_MS (быстрее ловит
 * второй минутный бар). Режим «раз в минуту»: SPIKE_ALERT_POLL_INTERVAL_MS=0, autorestart:false,
 * cron_restart в этом же профиле (см. комментарий у apps[0]).
 *
 * Секреты только в .env хоста (SPIKE_ALERT_TELEGRAM_*), не в этом файле.
 */
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'market-spike-telegram-watch',
      cwd: root,
      script: 'npm',
      args: 'run --silent market-spike-telegram-watch',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Если SPIKE_ALERT_POLL_INTERVAL_MS=0: autorestart:false и cron_restart раз в минуту.
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        /** Опрос БД; 0 = один проход и exit (тогда нужен cron + autorestart:false). */
        SPIKE_ALERT_POLL_INTERVAL_MS: '20000',
        /** При опросе: не слать повтор того же события чаще N мс (анти-спам в Telegram). */
        SPIKE_ALERT_POLL_SEND_DEDUPE_MS: '60000',
        /**
         * Пауза перед новым алертом по тому же mint после успешной отправки (мин).
         * Эскалация (см. ниже) пробивает cooldown при значимом усилении пролива.
         */
        SPIKE_ALERT_MINT_COOLDOWN_MINUTES: '5',
        /** История баров для поиска резкого шага между соседними минутами (PG только). */
        SPIKE_ALERT_SCAN_MINUTES: '60',
        /** Накопленное окно по первому/последнему бару (0 = выкл.). */
        SPIKE_ALERT_ROLLING_MINUTES: '3',
        SPIKE_ALERT_ROLLING_MAX_MINUTES: '10',
        SPIKE_ALERT_THRESHOLD_PCT: '8',
        SPIKE_ALERT_THRESHOLD_PUMP_CONSEC_PCT: '8',
        SPIKE_ALERT_THRESHOLD_DUMP_CONSEC_PCT: '8',
        SPIKE_ALERT_THRESHOLD_ROLLING_PCT: '10',
        SPIKE_ALERT_MIN_HOLDERS: '1000',
        SPIKE_ALERT_HOLDER_NULL_SOFT: '1',
        SPIKE_ALERT_MIN_AGE_HOURS: '3',
        /** Верхний предел mint на таблицу; отбор по самым свежим снимкам (MAX(ts)), не по алфавиту mint. */
        SPIKE_ALERT_MAX_ROWS_PER_TABLE: '800',
        SPIKE_ALERT_MIN_LIQ_USD: '0',
        SPIKE_ALERT_MIN_MARKET_CAP_USD: '1500000',
        /** 0 = выкл.; поднимите (напр. 2500), чтобы приблизиться к POST lane по объёму 5m */
        SPIKE_ALERT_MIN_VOL_5M_USD: '0',
        SPIKE_ALERT_DRY_RUN: '0',
        /** Алерт только если новый бар события не старше N минут (страховка от лага коллектора). */
        SPIKE_ALERT_MAX_NEWER_BAR_AGE_MINUTES: '20',
        /** При liq_usd из снимка ниже порога — не слать |Δ%| выше LOW_LIQ_MAX_ABS_PCT. */
        SPIKE_ALERT_LOW_LIQ_GLITCH_THRESHOLD_USD: '5000',
        SPIKE_ALERT_LOW_LIQ_MAX_ABS_PCT: '55',
        SPIKE_ALERT_DISPLAY_TZ: 'Europe/Moscow',
        /** Доля отката на следующей минуте (0 = выкл.), чтобы резать одноминутные артефакты PG. */
        SPIKE_ALERT_GLITCH_NEXT_BAR_RETRACE_MIN: '0.55',
        SPIKE_ALERT_LIQ_MCAP_SANITY: '1',
        SPIKE_ALERT_LIQ_MCAP_REF_MIN_USD: '2000000',
        SPIKE_ALERT_MIN_LIQ_TO_REF_MCAP_RATIO: '0.002',
        SPIKE_ALERT_MC_PRICE_MAX_DIVERGENCE_PCT: '8',
        SPIKE_ALERT_DEXSCREENER_META: '1',
        SPIKE_ALERT_UPSERT_TOKEN_META: '1',
        /**
         * Tier-каскад по market cap (включён, см. описание в src/scripts/market-spike-telegram-watch.ts).
         * tier3 (mcap≥$7M): consec=8%, rolling=10% (крупная капа — ловим раньше)
         * tier2 (mcap≥$3M): consec=11%, rolling=12%
         * tier1 (mcap≥$1.5M): consec=14%, rolling=15% (мелкая капа — выше порог, режем шум)
         * pump в любой капе — ≥30%.
         */
        SPIKE_ALERT_TIERED_BY_MCAP: '1',
        SPIKE_ALERT_PUMP_MIN_PCT: '30',
        SPIKE_ALERT_DUMP_TIER1_MCAP_USD: '1500000',
        SPIKE_ALERT_DUMP_TIER1_MIN_PCT: '14',
        SPIKE_ALERT_DUMP_TIER1_MIN_PCT_ROLLING: '15',
        SPIKE_ALERT_DUMP_TIER2_MCAP_USD: '3000000',
        SPIKE_ALERT_DUMP_TIER2_MIN_PCT: '11',
        SPIKE_ALERT_DUMP_TIER2_MIN_PCT_ROLLING: '12',
        SPIKE_ALERT_DUMP_TIER3_MCAP_USD: '7000000',
        SPIKE_ALERT_DUMP_TIER3_MIN_PCT: '8',
        SPIKE_ALERT_DUMP_TIER3_MIN_PCT_ROLLING: '10',
        SPIKE_ALERT_LOG_MISS_BY_FILTER: '1',
        /**
         * Эскалация: повторный [UPDATE]-алерт при усилении пролива внутри cooldown.
         * — DELTA_PCT=5: новый алерт если |new pct| - |prev pct| ≥ 5 п.п.;
         * — MIN_GAP_SEC=60: между алертами по одному mint минимум 60 секунд;
         * — MAX_PER_MINT=3: не больше трёх UPDATE-апдейтов в одном цикле жизни алерта;
         * — TIER_CHANGE_FORCES_UPDATE=1: при переходе в более жёсткий tier шлём апдейт даже при меньшей дельте.
         */
        SPIKE_ALERT_ESCALATE_ENABLED: '1',
        SPIKE_ALERT_ESCALATE_DELTA_PCT: '5',
        SPIKE_ALERT_ESCALATE_MIN_GAP_SEC: '60',
        SPIKE_ALERT_ESCALATE_MAX_PER_MINT: '3',
        SPIKE_ALERT_ESCALATE_TIER_CHANGE_FORCES_UPDATE: '1',
        /**
         * Аудит решений: пишем sent/update/miss/skip в PG-таблицу `market_spike_events`
         * (CREATE TABLE IF NOT EXISTS при старте; graceful fallback в stdout если БД отказала).
         */
        SPIKE_ALERT_AUDIT_DB_ENABLED: '1',
        SPIKE_ALERT_AUDIT_LOG_SKIPS: '0',
      },
    },
  ],
};
