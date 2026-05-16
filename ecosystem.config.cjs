/** VPS `/opt/solana-alpha`: Живой Оскар + дашборд + сборщики снимков (PM2 читает этот файл). */
const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });
/** Проброс в `env` каждого PM2-приложения, чтобы ключ был в `process.env` даже если дочерний процесс не подхватил `.env` так, как ожидается. */
const JUPITER_API_KEY_PM2 = (process.env.JUPITER_API_KEY || '').trim();
const PM2_JUPITER_KEY_ENV = JUPITER_API_KEY_PM2 ? { JUPITER_API_KEY: JUPITER_API_KEY_PM2 } : {};
if (!JUPITER_API_KEY_PM2) {
  console.warn(
    '[ecosystem.config.cjs] JUPITER_API_KEY пуст в .env при разборе конфига — в merged env не попадёт Pro-ключ (проверьте файл на VPS и `pm2 reload`).',
  );
}
const JUPITER_PRO_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_PRO_SWAP_URL = 'https://api.jup.ag/swap/v1/swap';

/**
 * live-oscar (`name: live-oscar`): full notional for paper ticket and live cap.
 * Must equal sum of staged legs (`PAPER_LIVE_STAGED_ENTRY_*_USD`); boot fails if
 * `PAPER_POSITION_USD` ≠ `LIVE_MAX_POSITION_USD` (see `src/live/main.ts`).
 *
 * 1.11.167: notional bumped 800 → 1000 (3-leg DCA $700 / $150 @ −7% / $150 @ −14%
 * after Policy A+ entry filter cuts trade volume; remaining trades are higher
 * conviction → larger position with deeper averaging budget).
 */
const LIVE_OSCAR_FULL_NOTIONAL_USD = '1000';

module.exports = {
  apps: [
    {
      name: 'live-oscar-dashboard',
      cwd: root,
      /**
       * Не `npm run dashboard`: PM2 держит PID npm/tsx-обёртки — при `reload` слушатель на PORT может
       * не успеть освободиться → EADDRINUSE и тысячи рестартов. Прямой запуск tsx CLI = один node-процесс.
       */
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'scripts-tmp/dashboard-server.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      kill_timeout: 10000,
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        HOST: '0.0.0.0',
        PORT: '3008',
        /** Должен совпадать с `isOrganizerPaperStorePath` в dashboard-server (имя `organizer-paper.jsonl`). */
        STORE_PATH: path.join(root, 'data/paper2/organizer-paper.jsonl'),
        PAPER2_DIR: path.join(root, 'data/paper2'),
        DASHBOARD_LIVE_OSCAR_JSONL: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        DASHBOARD_LIVE_OSCAR_RISKY_JSONL: path.join(root, 'data/live/pt1-oscar-live-risky.jsonl'),
        /** Вторая плитка «Wallet» в шапке `/papertrader2` — баланс risky-кошелька (RPC как у основного Wallet). */
        DASHBOARD_LIVE_OSCAR_RISKY_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        DASHBOARD_PAPER_OSCAR_V21_JSONL: path.join(root, 'data/paper2/paper-oscar-v21.jsonl'),
        DASHBOARD_PAPER_OSCAR_V22_JSONL: path.join(root, 'data/paper2/paper-oscar-v22.jsonl'),
        DASHBOARD_PAPER_OSCAR_RISKY_JSONL: path.join(root, 'data/paper2/paper-oscar-risky.jsonl'),
        /**
         * QuickNode Admin API → Telegram:
         * - `QUICKNODE_HOURLY_REMAINING_TELEGRAM=1` — не чаще 1×/ч `[ALERT][quicknode-balance]` (интервал ≥1h в коде + cooldown ниже).
         * - `QUICKNODE_USAGE_TELEGRAM` (общая дневная сводка) и milestones — выкл., чтобы не шумели.
         */
        QUICKNODE_USAGE_TELEGRAM: '0',
        QUICKNODE_HOURLY_REMAINING_TELEGRAM: '1',
        QUICKNODE_HOURLY_REMAINING_TELEGRAM_MS: '3600000',
        QUICKNODE_HOURLY_RECENT_MINUTES_LIST: '10,30,60',
        /** В конец `[ALERT][quicknode-balance]` — метрики discovery за окно из `data/live-discovery-health.json` (live-oscar). */
        QUICKNODE_HOURLY_APPEND_OSCAR_HEALTH: '1',
        QUICKNODE_BILLING_MILESTONES: '0',
        /** Дублирующая страховка в sender: один и тот же subtag не чаще 1 ч даже при двух процессах / перезапусках. */
        TELEGRAM_COOLDOWN_ALERT_QUICKNODE_BALANCE_MS: '3600000',
      },
    },
    {
      name: 'sa-raydium',
      cwd: root,
      script: 'scripts-tmp/raydium-collector.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
      },
    },
    {
      name: 'sa-meteora',
      cwd: root,
      script: 'scripts-tmp/meteora-collector.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
      },
    },
    {
      name: 'sa-orca',
      cwd: root,
      script: 'scripts-tmp/orca-collector.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        /** Explicit 60s — PM2 may retain removed keys across reload; override stale dump. */
        ORCA_COLLECTOR_INTERVAL_MS: '60000',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
      },
    },
    {
      name: 'sa-moonshot',
      cwd: root,
      script: 'scripts-tmp/moonshot-collector.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        MOONSHOT_COLLECTOR_INTERVAL_MS: '60000',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
      },
    },
    {
      name: 'sa-pumpswap',
      cwd: root,
      script: 'scripts-tmp/pumpswap-collector.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
      },
    },
    {
      name: 'sa-wallet-orchestrator',
      cwd: root,
      script: 'scripts-tmp/sa-wallet-orchestrator.mjs',
      args: '--daemon',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 8000,
      max_memory_restart: '220M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        /** W6.8 — Gecko multi-lane → QN → wallets; локальный потолок оркестратора см. SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY. */
        SA_ORCH_SCHEDULER_TICK_MS: '10000',
        SA_ORCH_GECKO_TARGET_CALLS_PER_MINUTE: '24',
        /** W6.13 — detective ledger (orch/backfill/sigseed); глобальный кап выше суммы подпулов при низком фактическом расходе QN. */
        SA_QN_GLOBAL_CREDITS_PER_DAY: '4000000',
        SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY: '2200000',
        SA_BACKFILL_MAX_CREDITS_PER_DAY: '500000',
        SA_ORCH_MAX_GECKO_HTTP_PER_DAY: '40000',
        SA_ORCH_MAX_RPC_PER_JOB: '1200',
        SA_ORCH_MAX_RPC_PER_POOL: '180',
        SA_ORCH_MAX_POOLS_PER_JOB: '20',
        SA_ORCH_SIG_PAGES_MAX: '4',
        SA_ORCH_MAX_TX_FETCHES_PER_POOL: '18',
        SA_ORCH_RPC_SLEEP_MS: '220',
      },
    },
    {
      name: 'sa-collector-watch',
      cwd: root,
      script: 'scripts-tmp/collector-log-watch.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '120M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        /** TELEGRAM_* из .env. Один чат: [ALERT][dex_collectors] — 429, тики, сеть, tick failed, fatal. */
        COLLECTOR_WATCH_POLL_MS: '15000',
        /** `0` — не слать dex_collectors в Telegram (логи PM2 остаются). */
        COLLECTOR_WATCH_TELEGRAM: '0',
      },
    },
    {
      name: 'sa-jupiter',
      cwd: root,
      script: 'scripts-tmp/jupiter-route-watcher.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '350M',
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        NODE_ENV: 'production',
        JUPITER_QUOTE_API_URL: JUPITER_PRO_QUOTE_URL,
        JUPITER_WATCHER_ENQUEUE_RPC: '0',
        /** Было 1250 по умолчанию в watcher — чаще quote в рамках Pro, с паузой между mint в цикле. */
        JUPITER_WATCHER_REQUEST_DELAY_MS: '650',
      },
    },
    {
      name: 'sa-direct-lp',
      cwd: root,
      script: 'scripts-tmp/direct-lp-detector.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        DIRECT_LP_ENQUEUE_RPC: '0',
      },
    },
    {
      name: 'live-oscar',
      cwd: root,
      /** Прямой `tsx` — один node-процесс под PM2 (как `live-oscar-dashboard`), без гонок `npm run` при reload. */
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/live-oscar.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 15000,
      max_memory_restart: '200M',
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        NODE_ENV: 'production',
        /** Снимок для дашборда / QuickNode hourly (дефолт в коде тот же файл). */
        LIVE_DISCOVERY_HEALTH_SNAPSHOT_PATH: path.join(root, 'data/live-discovery-health.json'),
        /**
         * Paper-слой = паритет с `pt1-oscar` (W7.2 / holders / W7.6 / W7.4).
         * W7.3 priority fee, W7.5 liq-watch, W7.8 sim-audit — **только** этот процесс (на pt1-* выкл.).
         */
        PAPER_STRATEGY_KIND: 'dip',
        PAPER_STRATEGY_ID: 'live-oscar',
        /** Unused file — live-oscar never writes paper JSONL (P4-I1). */
        PAPER_TRADES_PATH: path.join(root, 'data/paper2/_live_oscar_unused_journal.jsonl'),
        PAPER_HEARTBEAT_INTERVAL_MS: '30000',
        PAPER_DISCOVERY_INTERVAL_MS: '10000',
        PAPER_TRACK_INTERVAL_MS: '30000',
        PAPER_FOLLOWUP_TICK_MS: '60000',
        PAPER_DRY_RUN: 'false',
        /**
         * Staged-entry 1.11.167: полный нотионал **$1000** — три ноги.
         *  - leg 1: **$700** по сигналу (`FIRST_DROP_PCT=0`)
         *  - leg 2: **$150** на **−7%** от сигнала (mid-dip)
         *  - leg 3: **$150** на **−14%** от сигнала (deep-dip)
         * Signal kill: **−20%** от сигнала (запас 6пп ниже третьей ноги, чтобы leg-3 успел заполниться).
         * Окно `SIGNAL_TTL_MS` = 1ч; после первого `partial_sell` или после клина mid+deep ноги могут зануляться (см. tracker.ts staged-entry timeout suppression).
         */
        PAPER_POSITION_USD: LIVE_OSCAR_FULL_NOTIONAL_USD,
        PAPER_ENTRY_FIRST_LEG_FRACTION: '0.7',
        PAPER_LIVE_STAGED_ENTRY_ENABLED: '1',
        PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD: '700',
        PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT: '7',
        PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD: '150',
        PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT: '14',
        PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD: '150',
        PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT: '23',
        PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS: '3600000',
        PAPER_SAFETY_CHECK_ENABLED: '1',
        PAPER_PRIORITY_FEE_ENABLED: '1',
        PAPER_PRIORITY_FEE_TICKER_MS: '60000',
        PAPER_PRIORITY_FEE_MAX_AGE_MS: '600000',
        PAPER_PRIORITY_FEE_RPC_TIMEOUT_MS: '2500',
        PAPER_PRIORITY_FEE_PERCENTILE: 'p75',
        PAPER_PRIORITY_FEE_TARGET_CU: '200000',
        PAPER_PRIORITY_FEE_CACHE_PATH: path.join(root, 'data/priority-fee-cache-live-oscar.json'),
        PAPER_LIVE_MCAP_TTL_MS: '30000',

        PAPER_ENABLE_LAUNCHPAD_LANE: 'false',
        PAPER_ENABLE_MIGRATION_LANE: 'false',
        PAPER_ENABLE_POST_LANE: 'true',
        /** Пост-lane: мин. возраст пула в снимке 36 ч (паритет четырёх Oscar-плиток); верхняя граница не задана. */
        PAPER_POST_MIN_AGE_MIN: '2160',
        PAPER_POST_MAX_AGE_MIN: '0',
        PAPER_POST_MIN_LIQ_USD: '140000',
        PAPER_POST_MIN_VOL_5M_USD: '10000',
        PAPER_POST_MIN_BUYS_5M: '4',
        PAPER_POST_MIN_SELLS_5M: '3',
        PAPER_POST_MIN_BS: '0.98',
        PAPER_VOL_5M_1H_GUARD_ENABLED: '1',
        PAPER_VOL_1H_MIN_USD: '36000',
        PAPER_VOL_5M_SPIKE_MAX_MULT: '7',
        /** `0` — без порога по holders в globalGate / dip-clones (код не трогаем). */
        PAPER_MIN_HOLDER_COUNT: '0',

        PAPER_DIP_LOOKBACK_MIN: '120',
        PAPER_DIP_LOOKBACK_WINDOWS_MIN: '120,360,720',
        /** Live Oscar only: мин. глубина просадки цены от high выбранного окна (OR 120/360/720 мин). Значение −20 в env = −20%. */
        PAPER_DIP_MIN_DROP_PCT: '-20',
        PAPER_DIP_MAX_DROP_PCT: '-50',
        PAPER_DIP_MIN_IMPULSE_PCT: '12',
        PAPER_DIP_MIN_AGE_MIN: '0',
        PAPER_DIP_COOLDOWN_MIN: '30',
        PAPER_DIP_COOLDOWN_MIN_SCALP: '20',
        /** После **любого** полного закрытия по mint — 10m пауза повторного входа (имена env исторически `LOSS_`). */
        PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED: 'true',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES: '10',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS: '0',

        PAPER_DIP_RECOVERY_VETO_ENABLED: '1',
        PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN: '30,60',
        PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT: '12',
        /** Live Oscar guard: не покупать первую ногу по сигналу, если цена уже у локального high. */
        PAPER_DIP_LOCAL_HIGH_VETO_ENABLED: '1',
        PAPER_DIP_LOCAL_HIGH_VETO_WINDOWS_MIN: '30,60,120',
        PAPER_DIP_LOCAL_HIGH_VETO_MAX_DISTANCE_PCT: '2',

        /**
         * Policy A+ (1.11.167): четыре «хирургических» правила пропуска кандидатов,
         * выявленные по корреляционному анализу 119 закрытых сделок Live Oscar.
         * На исторической выборке оставляет 46/119 трейдов (-61%), повышает win-rate
         * с 56% до 70% и поднимает Σ PnL с −$70 до **+$658** (см. CHANGELOG 1.11.167).
         *
         *   1. `BOUNCE_FROM_MIN_30M_MAX_PCT` — не входить если цена уже отскочила
         *      более чем на 1% от 30-минутного минимума (мы должны быть «на дне»).
         *   2. `PRICE_CHANGE_1H_MIN_PCT` — не входить если за последний час падение
         *      больше чем 20% (вход в свободное падение).
         *   3. `VOL_1H_MAX_USD` — не входить если 1ч-объём > $1M (хайп / pump-and-dump).
         *   4. `PRICE_CHANGE_30M_MIN_PCT` — не входить если за последние 30 мин падение
         *      больше чем 10% (свежий пролив, не успели стабилизироваться).
         *
         * Каждое правило независимо отключается флагом `*_ENABLED=0`. Метрики
         * вычисляются из `*_pair_snapshots` PG: цена now, 30 мин и 1 ч назад,
         * минимум за последние 30 мин, объём 1 ч (`volume_1h`).
         */
        PAPER_POLICY_A_PLUS_ENABLED: '1',
        PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_ENABLED: '1',
        PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT: '1.0',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_ENABLED: '1',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_MIN_PCT: '-20',
        PAPER_POLICY_A_PLUS_VOL_1H_ENABLED: '1',
        PAPER_POLICY_A_PLUS_VOL_1H_MAX_USD: '1000000',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_ENABLED: '1',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT: '-10',
        /** TG: only when new local-high veto is the sole reason a live-oscar candidate is skipped. */
        LIVE_LOCAL_HIGH_VETO_TELEGRAM_ENABLED: '1',
        LIVE_LOCAL_HIGH_VETO_TELEGRAM_COOLDOWN_MS: '1800000',

        /** Live: без tp-regime классов на входе. Унифицированный профиль выхода (без A/B) — см. CHANGELOG 2026-05-13 + IDEALIZED_OSCAR_STACK_SPEC_V2 §1. */
        PAPER_TP_REGIME_ENABLED: '0',
        /**
         * Унификация A/B: единый профиль выхода. Раньше держали `PAPER_LIVE_EXIT_MODE_AB=1` с дублирующими
         * `PAPER_LIVE_EXIT_MODE_B_*`. На бэктесте (122 закрытых live-oscar сделки, retro-grid с честным slip)
         * эта пара режимов дала ровно ту же экономику, что и единый профиль с теми же базовыми `PAPER_*`,
         * но усложняла дашборд и таймлайн. Подробности — в `scripts-tmp/live-oscar-universal-strategy-v2.ts`.
         */
        PAPER_LIVE_EXIT_MODE_AB: '0',

        /**
         * Дополнительные DCA отключены: одно staged-усреднение **−6%** от сигнала
         * (см. `PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT`).
         */
        PAPER_DCA_LEVELS: '',
        /**
         * Killstop −20% к усреднённой позиции. На retro-grid kill в зоне (-15..-12)% сжигал плюсовые сделки
         * с временной просадкой, которые после восстанавливались к ступеням TP; kill ≥ −20% даёт
         * страховку от чёрного лебедя без подрезания нормальных просадок (см. retro-grid в README).
         */
        PAPER_DCA_KILLSTOP: '-0.20',
        /**
         * TP-лесенка 1.11.168: шаг **+5%** к средней, **агрессивный скальп-профиль** —
         *   ступень 1 (+5%)  → 10% остатка
         *   ступень 2 (+10%) → 30% остатка
         *   ступень 3 (+15%) → 50% остатка
         *   ступень 4 (+20%) → 70% остатка
         *   ступень 5+ (+25%, +30%, ...) → 70% остатка (последнее значение профиля
         *   тиражируется на все последующие ступени).
         * Накопленные доли позиции:
         *   step1 = 10.0%, step2 = 37.0%, step3 = 68.5%, step4 = 90.6%, step5 = 97.2%.
         * К ступени 5 продано 97.2% позиции → хвост ~2.8% уходит по TRAIL без
         * заметного price-impact, что закрывает главный leakage 1.11.167 (на $ASTEROID
         * TRAIL close съел $22 из $39 общей утечки потому что закрывали 25% позиции
         * одним sell-куском в тонком Meteora-пуле). Идея — фиксируем основной пик 5-15%
         * (где сидят ~64% наших winners по retro-выборке) большими долями, не полагаясь
         * на TRAIL для крупных пампов.
         * Лестница без верхнего лимита; `PAPER_TP_GRID_SELL_FRACTION` остаётся fallback.
         * Защита от ранних шипов: первая ступень retrace требует минимального PnL **+3%**
         * к средней (`PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL`).
         */
        PAPER_TP_LADDER: '',
        PAPER_TP_GRID_STEP_PNL: '0.05',
        PAPER_TP_GRID_SELL_FRACTION: '0.10',
        PAPER_TP_GRID_SELL_FRACTION_PROFILE: '0.10,0.30,0.50,0.70,0.70',
        PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.03',
        PAPER_TP_X: '100',
        PAPER_SL_X: '0',
        /** Trail = retrace к предыдущей взятой ступени (после ≥2 ступеней). `PAPER_TRAIL_DROP` не используется при `ladder_retrace`. */
        PAPER_TRAIL_MODE: 'ladder_retrace',
        PAPER_TRAIL_DROP: '0.10',
        PAPER_TRAIL_TRIGGER_X: '1.05',
        /** Live Oscar — тайм-аут 48 ч (двое суток); в трекере отключён после первого partial TP или DCA (см. tracker `timeoutSuppressedByProgress`). */
        PAPER_TIMEOUT_HOURS: '48',
        /** После ≥1 частичной TP-сетки: при откате к средней цене входа (xAvg≤1) один раз продать долю остатка (по умолчанию 50%). */
        PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED: '1',
        PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_FRACTION: '0.5',
        /**
         * Wave B exit для **новых** open (`liveExitPolicyId=wave_b_v1`). Открытые до деплоя
         * без policy id → `legacy_grid` + закреплённый prod-профиль в tpGridOverrides.
         */
        PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B: '1',
        PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION: '0.30',
        PAPER_PEAK_LOG_STEP_PCT: '1',

        PAPER_DIP_WHALE_ANALYSIS_ENABLED: '1',
        PAPER_DIP_REQUIRE_WHALE_TRIGGER: '0',
        PAPER_DIP_LARGE_SELL_USD: '3000',
        PAPER_DIP_RECENT_LOOKBACK_MIN: '10',
        PAPER_DIP_CAPITULATION_PCT: '0.7',
        PAPER_DIP_WHALE_SILENCE_MIN: '10',
        PAPER_DIP_GROUP_SELL_USD: '5000',
        PAPER_DIP_GROUP_MIN_SELLERS: '2',
        PAPER_DIP_GROUP_DUMP_PCT: '0.4',
        PAPER_DIP_BLOCK_CREATOR_DUMP: '1',
        PAPER_DIP_CREATOR_DUMP_LOOKBACK_MIN: '20',
        PAPER_DIP_CREATOR_DUMP_MIN_PCT: '0.05',
        PAPER_DIP_CREATOR_DUMP_MAX_PCT: '0.6',
        PAPER_DIP_DCA_PRED_MIN_SELLS_24H: '4',
        PAPER_DIP_DCA_PRED_MIN_INTERVAL_MIN: '30',
        PAPER_DIP_DCA_PRED_MIN_CHUNK_USD: '3000',
        PAPER_DIP_DCA_AGGR_MIN_SELLS_24H: '6',
        PAPER_DIP_DCA_AGGR_MAX_INTERVAL_MIN: '15',

        /** Off: live GPA/addon holders (W7.6) не используются — порог по `holder_count` из SQL-снимка коллекторов (`globalGate`). */
        PAPER_HOLDERS_LIVE_ENABLED: '0',
        PAPER_HOLDERS_USE_QN_ADDON: '0',
        PAPER_HOLDERS_TTL_MS: '90000',
        PAPER_HOLDERS_NEG_TTL_MS: '15000',
        PAPER_HOLDERS_MAX_PER_TICK: '10',
        PAPER_HOLDERS_TIMEOUT_MS: '4000',
        PAPER_HOLDERS_INCLUDE_TOKEN2022: '1',
        PAPER_HOLDERS_ON_FAIL: 'db_fallback',
        PAPER_HOLDERS_DB_WRITEBACK: '1',
        /** Прогрев `tokens.holder_count` — `0` выкл. */
        PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX: '0',
        PAPER_HOLDERS_GPA_CREDITS_PER_CALL: '100',
        /** Внутренние месячные капы QN отключены — лимит только в кабинете QuickNode. */
        QN_FEATURE_BUDGET_DISABLED: '1',
        QN_FEATURE_BUDGET_HOLDERS: '0',
        QN_FEATURE_BUDGET_PRI_FEE: '0',
        QN_FEATURE_BUDGET_SAFETY: '0',
        QN_FEATURE_BUDGET_PRICE_VERIFY: '0',
        QN_FEATURE_BUDGET_SIM: '0',
        QN_FEATURE_BUDGET_LIVE_SEND: '0',
        QN_FEATURE_BUDGET_LIQ_WATCH: '0',

        PAPER_PRICE_VERIFY_ENABLED: '1',
        PAPER_PRICE_VERIFY_BLOCK_ON_FAIL: '1',
        PAPER_PRICE_VERIFY_USE_JUPITER_PRICE: '0',
        PAPER_PRICE_VERIFY_MAX_SLIP_PCT: '4.0',
        PAPER_PRICE_VERIFY_MAX_SLIP_BPS: '400',
        PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT: '8.0',
        PAPER_PRICE_VERIFY_TIMEOUT_MS: '2500',
        PAPER_PRICE_VERIFY_QUOTE_URL: JUPITER_PRO_QUOTE_URL,
        PAPER_PRICE_VERIFY_EXIT_ENABLED: '1',
        PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL: '1',
        /** После N defer pre-exit Jupiter verify по TIMEOUT — один проход без block_on_fail (см. live_exit_verify_defer). */
        PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION: '60',

        PAPER_SIM_AUDIT_ENABLED: '1',
        PAPER_SIM_SAMPLE_PCT: '5',
        PAPER_SIM_MAX_WALL_MS: '8000',
        PAPER_SIM_BUILD_TIMEOUT_MS: '5000',
        PAPER_JUPITER_SWAP_URL: JUPITER_PRO_SWAP_URL,
        PAPER_SIM_USE_JUPITER_BUILD: '1',
        JUPITER_QUOTE_429_MAX_RETRIES: '5',
        JUPITER_QUOTE_429_INITIAL_BACKOFF_MS: '150',
        PAPER_SIM_CREDS_PER_CALL: '30',
        PAPER_SIM_STRICT_BUDGET: '0',

        PAPER_IMPULSE_CONFIRM_ENABLED: '1',
        PAPER_IMPULSE_DIP_POLICY: 'parallel_and',
        PAPER_IMPULSE_PG_MIN_DROP_PCT: '12',
        PAPER_IMPULSE_RPC_MAX_PER_MIN: '30',
        QN_FEATURE_BUDGET_IMPULSE_CONFIRM: '0',
        IMPULSE_QN_ROLLING_MAX_CREDITS: '0',

        PAPER_LIQ_WATCH_ENABLED: '1',
        PAPER_LIQ_WATCH_FORCE_CLOSE: '1',
        PAPER_LIQ_WATCH_DRAIN_PCT: '35',
        PAPER_LIQ_WATCH_MIN_AGE_MIN: '1',
        PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES: '2',
        PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS: '120000',
        PAPER_LIQ_WATCH_RPC_FALLBACK: '0',
        PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE: '1',
        PAPER_LIQ_WATCH_STAMP_ON_TRACK: '0',

        /** W8.0 §9 rollout — шаг 3: `live` + микролимиты §3.3 (sendTransaction + confirm); см. RUNBOOK §0.2 и [`W8.0_live_oscar_trading_bot.md`](docs/strategy/specs/W8.0_live_oscar_trading_bot.md) §9. */
        LIVE_STRATEGY_ENABLED: '1',
        LIVE_EXECUTION_MODE: 'live',
        LIVE_STRATEGY_PROFILE: 'oscar',
        LIVE_STRATEGY_ID: 'live-oscar',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        /** `live_discovery_eval` / `live_discovery_skip_open` в JSONL (отключить: `0`). */
        LIVE_DISCOVERY_AUDIT_JSONL: '1',
        /** Полный аудит по mint из whitelist-файла: pass/fail eval, `universe_miss`, `tick_skip`. */
        LIVE_DISCOVERY_DEEP_AUDIT_JSONL: '1',
        LIVE_DISCOVERY_DEEP_AUDIT_WHITELIST_PATH: path.join(root, 'data/live/live-oscar-mint-whitelist.txt'),
        /** Минимальный интервал (мс) между повторными `universe_miss` / `tick_skip` по одному mint. */
        LIVE_DISCOVERY_DEEP_AUDIT_UNIVERSE_MISS_MIN_MS: '60000',
        /** Разрешённые mint для новых входов; иначе skip + Telegram (см. `LIVE_MINT_WHITELIST_TELEGRAM_CATEGORY`). */
        LIVE_MINT_WHITELIST_ENABLED: '1',
        LIVE_MINT_WHITELIST_PATH: path.join(root, 'data/live/live-oscar-mint-whitelist.txt'),
        /** `ADVICE` — не ALERT (тише: учитываются тихие часы `TELEGRAM_QUIET_*`). При желании: `ALERT`. */
        LIVE_MINT_WHITELIST_TELEGRAM_CATEGORY: 'ADVICE',
        /** `0` — каждый новый проход гейтов снова шлёт TG по этому mint (без кулдауна). */
        /** Per-mint: не чаще одного `live_whitelist_miss` в N мс (дефолт в коде 5 мин). `0` = без лимита. */
        LIVE_MINT_WHITELIST_NOTIFY_COOLDOWN_MS: '300000',
        /** Ручной blacklist mint — до dip/Jupiter и без открытия позиций (файл в репозитории). */
        LIVE_MINT_BLACKLIST_ENABLED: '1',
        LIVE_MINT_BLACKLIST_PATH: path.join(root, 'data/live/live-oscar-mint-blacklist.txt'),
        /**
         * Отдельный бот для TG только по `live_whitelist_miss` и `live_whitelist_consec_loss_drop`.
         * Эти алерты всегда без тихих часов (`skipQuietHours` в коде).
         */
        LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN: '8617384935:AAEjPboG6mfzcZd_DXS5o6bUXrQicZZEz30',
        LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID: '-1003878024799',
        /** После N подряд убыточных полных закрытий по mint — удаление из whitelist + Telegram (`mint-whitelist.ts`). `0` = выкл. */
        LIVE_MINT_WHITELIST_REMOVE_AFTER_CONSEC_LOSSES: '2',
        /**
         * Shadow diagnostics (signal-lab + mtm-shadow): JSONL + опциональные отчёты; не влияет на торговые решения.
         * В PM2 выключено — снижает фоновые запросы к Jupiter lite-api; торговый путь (verify/трекер) без изменений.
         */
        SIGNAL_LAB_ENABLED: '0',
        SIGNAL_LAB_SAMPLE_PCT: '100',
        SIGNAL_LAB_PATH: path.join(root, 'data/live/signal-lab.jsonl'),
        SIGNAL_LAB_ALT_PROBE_FRACTION: '0.55',
        MTM_SHADOW_ENABLED: '0',
        MTM_SHADOW_SAMPLE_PCT: '100',
        MTM_SHADOW_PATH: path.join(root, 'data/live/mtm-shadow.jsonl'),
        MTM_SHADOW_ALT_FRACTION: '0.58',
        /**
         * Shadow dynamic kill-stop (PG `*_pair_snapshots`): пишет `dynamicKillstopShadow` в `openTrade` / `live_position_open`,
         * но **не** меняет реальные kill/DCA в трекере (только наблюдаемость).
         */
        PAPER_DYNAMIC_KILLSTOP_SHADOW_ENABLED: '1',
        PAPER_DYNAMIC_KILLSTOP_SHADOW_WINDOW_DAYS: '14',
        PAPER_DYNAMIC_KILLSTOP_SHADOW_BUFFER_PCT: '6',
        PAPER_DYNAMIC_KILLSTOP_SHADOW_MIN_KILL_DROP_PCT: '12',
        PAPER_DYNAMIC_KILLSTOP_SHADOW_MAX_KILL_DROP_PCT: '28',
        PAPER_DYNAMIC_KILLSTOP_SHADOW_SUPPORT_CLUSTER_PCT: '3',
        PAPER_DYNAMIC_KILLSTOP_SHADOW_MIN_TOUCHES: '2',
        PAPER_DYNAMIC_KILLSTOP_SHADOW_MIN_HOURLY_SAMPLES: '72',
        /** Live JSONL + `[HEALTH][live_oscar_pulse]` Telegram (uses `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`). Отключить TG: `LIVE_TELEGRAM_HEARTBEAT=0`. */
        LIVE_HEARTBEAT_INTERVAL_MS: '1800000',
        /** Файл keypair торгового кошелька на VPS (`chmod 600`). После замены файла задайте LIVE_WALLET_PUBKEY (совпадает с проверкой в коде). */
        LIVE_WALLET_SECRET: path.join(root, 'data/live/live-oscar-micro.keypair.json'),
        LIVE_WALLET_PUBKEY: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
        LIVE_SIM_ENABLED: '1',
        LIVE_SIM_TIMEOUT_MS: '12000',
        LIVE_SIM_CREDITS_PER_CALL: '30',
        /**
         * 1.11.168: persistent retry x10 на quote+swap для buy и sell с тугим slippage
         * 50bps. Эмулирует ручную торговлю в jup.ag UI — выставляем минимальный
         * допустимый slippage и долбим запросы до победы; Jupiter сам выберет момент
         * когда пул стабилен. Пауза 3с между попытками (быстрее чем 5с в 1.11.167),
         * чтобы общая retry-петля укладывалась в 30 с — за это время цена редко уйдёт
         * ниже взятой ступени TP-лесенки.
         */
        LIVE_BUY_SIM_RETRY_ATTEMPTS: '10',
        LIVE_BUY_SIM_RETRY_DELAY_MS: '3000',
        LIVE_SELL_SIM_RETRY_ATTEMPTS: '10',
        LIVE_SELL_SIM_RETRY_DELAY_MS: '3000',
        /** W8.0 §10 — max Jupiter quote age (ms) before sign/send; `0` = disable (see `loadLiveOscarConfig`). */
        LIVE_QUOTE_MAX_AGE_MS: '8000',
        /**
         * `0` — не слать `live-jupiter-tracker-diverge` / `live-jupiter-tracker-fallback` в Telegram.
         * Circuit breaker price-verify: `JUPITER_QUOTE_CIRCUIT_TELEGRAM=0` при необходимости отдельно.
         */
        LIVE_JUPITER_TRACKER_TELEGRAM: '0',
        /**
         * Jupiter quote + swap: max execution tolerance (bps). 1.11.168:
         * **100 → 50** (1% → 0.5%). Жёсткий слиппедж = больше rejection'ов
         * Jupiter quote, но persistent retry x10 их прокатает. Бенефит — мы
         * принципиально не отдаём боту больше 0.5% между quote и swap; всё
         * что выше — это price-impact самого пула (видно в `priceImpactPct`,
         * не настраивается, лечится только меньшим размером ордера → см.
         * новый sellFraction-профиль 1.11.168).
         */
        LIVE_DEFAULT_SLIPPAGE_BPS: '50',
        LIVE_JUPITER_QUOTE_URL: JUPITER_PRO_QUOTE_URL,
        LIVE_JUPITER_SWAP_URL: JUPITER_PRO_SWAP_URL,
        /**
         * Jupiter `/swap/v1/swap`: cap priority fee at **0.0001 SOL** (100_000 lamports) via `priorityLevelWithMaxLamports`.
         * `veryHigh` — максимально агрессивный приоритет в рамках cap (дороже по приоритет-фии).
         */
        LIVE_JUPITER_PRIORITY_MAX_SOL: '0.0001',
        LIVE_JUPITER_SWAP_PRIORITY_LEVEL: 'veryHigh',
        /**
         * Пауза между mint после Jupiter MTM (см. `LIVE_TRACKER_INTER_MINT_DELAY_MS`): 60 ms — ближе к ~10 RPS.
         * Полный снятие паузы: `0` (не задаём здесь без мониторинга 429).
         */
        LIVE_TRACKER_INTER_MINT_DELAY_MS: '60',
        /** Полный нотионал (= `PAPER_POSITION_USD`); SOL на swap — из Jupiter quote по USD-нотации ноги. */
        LIVE_MAX_POSITION_USD: LIVE_OSCAR_FULL_NOTIONAL_USD,
        LIVE_MAX_OPEN_POSITIONS: '30',
        /**
         * Phase 5: гейт «свободный SOL ≥ k·X» + capital_skip / CAPITAL_ROTATE — выкл.
         * (Оценка free SOL через getBalance расходилась с реальностью; swap и так использует кошелёк.)
         * Включить прежнее W8.0-p5: LIVE_PHASE5_FREE_SOL_GATE_ENABLED=1 (опц. LIVE_CAPITAL_ROTATE_ENABLED=1).
         */
        LIVE_PHASE5_FREE_SOL_GATE_ENABLED: '0',
        /** 0 = never block new buys on sim streak; transient quote misses no longer increment streak (phase4 + phase5-state). */
        LIVE_KILL_AFTER_CONSEC_FAIL: '0',
        /**
         * Гейты по оценке нативного SOL через getBalance — выкл. (пустая строка ⇒ в коде порог не задаётся).
         * Перекрывает возможные значения из `/opt/solana-alpha/.env` для PM2-процесса.
         */
        LIVE_MIN_WALLET_SOL: '',
        LIVE_MIN_WALLET_SOL_EQUITY_USD: '',
        /** Live-only: не открывать новые позиции при «просадке» BTC (Binance 1h/4h); `0` = выкл. см. `LIVE_BTC_GATE_ENABLED`. */
        LIVE_BTC_GATE_ENABLED: '1',
        /** 0 = выкл. Иначе снять exposure block (parity) после N мс — см. `LIVE_RECONCILE_BLOCK_MAX_MS` в config. */
        LIVE_RECONCILE_BLOCK_MAX_MS: '0',
        /** Live `buy_open`: не покупать mint, если на кошельке уже ≥ этой оценки USD (баланс × цена). 0 = выкл. */
        LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD: '30',
        /** После `live_position_close`: через N мс дожать остаток mint на кошельке (`sell_full`). 0 = выкл. */
        LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS: '60000',

        /** Старый 5-секундный scale-in отключён: вторая нога — только через staged-entry (`PAPER_LIVE_STAGED_ENTRY_*`, см. комментарий к `PAPER_POSITION_USD`). */
        LIVE_ENTRY_SCALE_IN_ENABLED: '0',
        /** Legacy-настройки оставлены только для risky/бумажных профилей и не активны при LIVE_ENTRY_SCALE_IN_ENABLED=0. */
        LIVE_ENTRY_SCALE_IN_DELAY_MS: '5000',
        /** Коридор второй ноги к якорю первой ноги: до +1% / до −2%; вне коридора — пауза `LIVE_ENTRY_SCALE_IN_OUT_OF_CORRIDOR_POLL_MS`. */
        LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT: '1',
        LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT: '2',
        LIVE_ENTRY_SCALE_IN_OUT_OF_CORRIDOR_POLL_MS: '30000',
        LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS: '8',
        LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS: '2000',

        /** Периодический безопасный self-heal: хвосты кошелька + диагностика stale open (`src/live/periodic-self-heal.ts`). */
        LIVE_PERIODIC_SELF_HEAL_MS: '1800000',
        LIVE_PERIODIC_SWEEP_MIN_USD: '0.25',
        /** `0` по умолчанию: не продавать обычные live open только по возрасту. `1` — ручной opt-in старого PERIODIC_HEAL force-close. */
        LIVE_PERIODIC_STUCK_FORCE_CLOSE_ENABLED: '0',
        LIVE_PERIODIC_STUCK_GRACE_HOURS: '0.5',
        /** `1` = продавать любые SPL не в open выше min USD (осторожно: скам-airdrops). */
        LIVE_PERIODIC_SWEEP_UNKNOWN_CHAIN_ONLY: '0',
      },
    },
    /**
     * Живой Oscar Risky — **снят с PM2** (не стартует при `pm2 reload ecosystem.config.cjs`). На хосте: `pm2 delete live-oscar-risky` если процесс ещё есть.
     * Paper Oscar Risky — бумага: тот же paper-слой, что у **live-oscar** (все `PAPER_*` ниже скопированы с процесса `live-oscar` в этом файле).
     * Затем смягчены только пост-gate пороги для эксперимента: vol 5m $3k, vol 1h guard $20k, мин. возраст пула 6 ч, holders ≥ 1k.
     * Живой Oscar в этом файле не менять.
     */
    {
      name: 'paper-oscar-risky',
      cwd: root,
      script: 'npm',
      args: 'run --silent paper-oscar-risky',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: '200M',
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        NODE_ENV: 'production',
        PAPER_STRATEGY_KIND: 'dip',
        PAPER_STRATEGY_ID: 'paper-oscar-risky',
        PAPER_TRADES_PATH: path.join(root, 'data/paper2/paper-oscar-risky.jsonl'),
        PAPER_HEARTBEAT_INTERVAL_MS: '30000',
        PAPER_DISCOVERY_INTERVAL_MS: '10000',
        PAPER_TRACK_INTERVAL_MS: '30000',
        PAPER_FOLLOWUP_TICK_MS: '60000',
        PAPER_DRY_RUN: 'false',
        PAPER_POSITION_USD: '600',
        PAPER_ENTRY_FIRST_LEG_FRACTION: '0.75',
        PAPER_SAFETY_CHECK_ENABLED: '1',
        PAPER_PRIORITY_FEE_ENABLED: '1',
        PAPER_PRIORITY_FEE_TICKER_MS: '60000',
        PAPER_PRIORITY_FEE_MAX_AGE_MS: '600000',
        PAPER_PRIORITY_FEE_RPC_TIMEOUT_MS: '2500',
        PAPER_PRIORITY_FEE_PERCENTILE: 'p75',
        PAPER_PRIORITY_FEE_TARGET_CU: '200000',
        PAPER_PRIORITY_FEE_CACHE_PATH: path.join(root, 'data/priority-fee-cache-paper-oscar-risky.json'),
        PAPER_LIVE_MCAP_TTL_MS: '30000',
        PAPER_ENABLE_LAUNCHPAD_LANE: 'false',
        PAPER_ENABLE_MIGRATION_LANE: 'false',
        PAPER_ENABLE_POST_LANE: 'true',
        /** Пост-lane (post_migration): смягчение min pool liq до $100k (live-oscar: $140k). */
        PAPER_POST_MIN_LIQ_USD: '100000',
        PAPER_POST_MAX_LIQ_USD: '0',
        PAPER_POST_MAX_AGE_MIN: '0',
        /** Смягчение: мин. возраст пула 6 ч (live: 36 ч). */
        PAPER_POST_MIN_AGE_MIN: '360',
        /** Смягчение: объём 5m (поле volume_5m в снимке), live: $10k. */
        PAPER_POST_MIN_VOL_5M_USD: '3000',
        PAPER_POST_MAX_VOL_5M_USD: '0',
        PAPER_POST_MIN_BUYS_5M: '4',
        PAPER_POST_MIN_SELLS_5M: '3',
        PAPER_POST_MIN_BS: '0.98',
        PAPER_VOL_5M_1H_GUARD_ENABLED: '1',
        /** Смягчение: нижний порог объёма за час (guard), live: $36k. */
        PAPER_VOL_1H_MIN_USD: '20000',
        PAPER_VOL_1H_MAX_USD: '0',
        PAPER_VOL_5M_SPIKE_MAX_MULT: '7',
        /** Смягчение: holders (live: 3000). */
        PAPER_MIN_HOLDER_COUNT: '1000',
        PAPER_GLOBAL_MAX_HOLDER_COUNT: '0',
        PAPER_DIP_LOOKBACK_MIN: '120',
        PAPER_DIP_LOOKBACK_WINDOWS_MIN: '120,360,720',
        PAPER_DIP_MIN_DROP_PCT: '-30',
        PAPER_DIP_MAX_DROP_PCT: '-50',
        PAPER_DIP_MIN_IMPULSE_PCT: '12',
        PAPER_DIP_MIN_AGE_MIN: '0',
        PAPER_DIP_COOLDOWN_MIN: '30',
        PAPER_DIP_COOLDOWN_MIN_SCALP: '20',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED: 'true',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES: '10',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS: '0',
        PAPER_DIP_RECOVERY_VETO_ENABLED: '1',
        PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN: '30,60',
        PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT: '12',
        PAPER_TP_REGIME_ENABLED: '0',
        PAPER_LIVE_EXIT_MODE_AB: '1',
        PAPER_LIVE_EXIT_MODE_B_TRAIL_DROP: '0.12',
        PAPER_LIVE_EXIT_MODE_B_TRAIL_TRIGGER_X: '1.06',
        PAPER_LIVE_EXIT_MODE_B_TIMEOUT_HOURS: '4',
        PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP: '-0.08',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_STEP_PNL: '0.025',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_SELL_FRACTION: '0.05',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.02',
        PAPER_DCA_LEVELS: '-4:0.25',
        PAPER_DCA_KILLSTOP: '-0.08',
        PAPER_TP_LADDER: '',
        PAPER_TP_GRID_STEP_PNL: '0.025',
        PAPER_TP_GRID_SELL_FRACTION: '0.05',
        PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.025',
        PAPER_TP_X: '100',
        PAPER_SL_X: '0',
        PAPER_TRAIL_MODE: 'ladder_retrace',
        PAPER_TRAIL_DROP: '0.10',
        PAPER_TRAIL_TRIGGER_X: '1.10',
        PAPER_TIMEOUT_HOURS: '8',
        PAPER_PEAK_LOG_STEP_PCT: '1',
        PAPER_DIP_WHALE_ANALYSIS_ENABLED: '1',
        PAPER_DIP_REQUIRE_WHALE_TRIGGER: '0',
        PAPER_DIP_LARGE_SELL_USD: '3000',
        PAPER_DIP_RECENT_LOOKBACK_MIN: '10',
        PAPER_DIP_CAPITULATION_PCT: '0.7',
        PAPER_DIP_WHALE_SILENCE_MIN: '10',
        PAPER_DIP_GROUP_SELL_USD: '5000',
        PAPER_DIP_GROUP_MIN_SELLERS: '2',
        PAPER_DIP_GROUP_DUMP_PCT: '0.4',
        PAPER_DIP_BLOCK_CREATOR_DUMP: '1',
        PAPER_DIP_CREATOR_DUMP_LOOKBACK_MIN: '20',
        PAPER_DIP_CREATOR_DUMP_MIN_PCT: '0.05',
        PAPER_DIP_CREATOR_DUMP_MAX_PCT: '0.6',
        PAPER_DIP_DCA_PRED_MIN_SELLS_24H: '4',
        PAPER_DIP_DCA_PRED_MIN_INTERVAL_MIN: '30',
        PAPER_DIP_DCA_PRED_MIN_CHUNK_USD: '3000',
        PAPER_DIP_DCA_AGGR_MIN_SELLS_24H: '6',
        PAPER_DIP_DCA_AGGR_MAX_INTERVAL_MIN: '15',
        PAPER_HOLDERS_LIVE_ENABLED: '0',
        PAPER_HOLDERS_USE_QN_ADDON: '0',
        PAPER_HOLDERS_TTL_MS: '90000',
        PAPER_HOLDERS_NEG_TTL_MS: '15000',
        PAPER_HOLDERS_MAX_PER_TICK: '10',
        PAPER_HOLDERS_TIMEOUT_MS: '4000',
        PAPER_HOLDERS_INCLUDE_TOKEN2022: '1',
        PAPER_HOLDERS_ON_FAIL: 'db_fallback',
        PAPER_HOLDERS_DB_WRITEBACK: '1',
        PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX: '12',
        PAPER_HOLDERS_GPA_CREDITS_PER_CALL: '100',
        QN_FEATURE_BUDGET_HOLDERS: '10000000',
        PAPER_PRICE_VERIFY_ENABLED: '1',
        PAPER_PRICE_VERIFY_BLOCK_ON_FAIL: '1',
        PAPER_PRICE_VERIFY_USE_JUPITER_PRICE: '0',
        PAPER_PRICE_VERIFY_MAX_SLIP_PCT: '4.0',
        PAPER_PRICE_VERIFY_MAX_SLIP_BPS: '400',
        PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT: '8.0',
        PAPER_PRICE_VERIFY_TIMEOUT_MS: '2500',
        PAPER_PRICE_VERIFY_QUOTE_URL: JUPITER_PRO_QUOTE_URL,
        PAPER_PRICE_VERIFY_EXIT_ENABLED: '1',
        PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL: '1',
        PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION: '60',
        PAPER_SIM_AUDIT_ENABLED: '1',
        PAPER_SIM_SAMPLE_PCT: '5',
        PAPER_SIM_MAX_WALL_MS: '8000',
        PAPER_SIM_BUILD_TIMEOUT_MS: '5000',
        PAPER_JUPITER_SWAP_URL: JUPITER_PRO_SWAP_URL,
        PAPER_SIM_USE_JUPITER_BUILD: '1',
        JUPITER_QUOTE_429_MAX_RETRIES: '5',
        JUPITER_QUOTE_429_INITIAL_BACKOFF_MS: '150',
        PAPER_SIM_CREDS_PER_CALL: '30',
        PAPER_SIM_STRICT_BUDGET: '1',
        PAPER_IMPULSE_CONFIRM_ENABLED: '1',
        PAPER_IMPULSE_DIP_POLICY: 'parallel_and',
        PAPER_IMPULSE_PG_MIN_DROP_PCT: '12',
        PAPER_IMPULSE_RPC_MAX_PER_MIN: '30',
        QN_FEATURE_BUDGET_IMPULSE_CONFIRM: '5000000',
        IMPULSE_QN_ROLLING_MAX_CREDITS: '1000000',
        PAPER_LIQ_WATCH_ENABLED: '1',
        PAPER_LIQ_WATCH_FORCE_CLOSE: '1',
        PAPER_LIQ_WATCH_DRAIN_PCT: '35',
        PAPER_LIQ_WATCH_MIN_AGE_MIN: '1',
        PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES: '2',
        PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS: '120000',
        PAPER_LIQ_WATCH_RPC_FALLBACK: '0',
        PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE: '1',
        PAPER_LIQ_WATCH_STAMP_ON_TRACK: '0',
        LIVE_ENTRY_SCALE_IN_ENABLED: '1',
        LIVE_ENTRY_SCALE_IN_DELAY_MS: '5000',
        LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT: '1',
        LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT: '2',
        LIVE_ENTRY_SCALE_IN_OUT_OF_CORRIDOR_POLL_MS: '30000',
        LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS: '8',
        LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS: '2000',
      },
    },
    /**
     * Paper Oscar IDEALIZED V2.1 — те же гейты входа/данные, что live-oscar paper-слой; выходы по §1–§7 `IDEALIZED_OSCAR_STACK_SPEC_V2.md` v2.1.
     * Полный паритет `PAPER_*` с процессом **live-oscar** задаётся общим `.env` на хосте; здесь — отличия id/журнал/kill B/кэш priority fee + scale-in для второй ноги.
     */
    {
      name: 'paper-oscar-v21',
      cwd: root,
      script: 'npm',
      args: 'run --silent paper-oscar-v21',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: '200M',
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        NODE_ENV: 'production',
        PAPER_STRATEGY_KIND: 'dip',
        PAPER_STRATEGY_ID: 'paper-oscar-v21',
        PAPER_TRADES_PATH: path.join(root, 'data/paper2/paper-oscar-v21.jsonl'),
        PAPER_HEARTBEAT_INTERVAL_MS: '30000',
        PAPER_DISCOVERY_INTERVAL_MS: '10000',
        PAPER_TRACK_INTERVAL_MS: '30000',
        PAPER_FOLLOWUP_TICK_MS: '60000',
        PAPER_DRY_RUN: 'false',
        PAPER_POSITION_USD: '120',
        PAPER_ENTRY_FIRST_LEG_FRACTION: '0.75',
        PAPER_SAFETY_CHECK_ENABLED: '1',
        PAPER_PRIORITY_FEE_ENABLED: '1',
        PAPER_PRIORITY_FEE_TICKER_MS: '60000',
        PAPER_PRIORITY_FEE_MAX_AGE_MS: '600000',
        PAPER_PRIORITY_FEE_RPC_TIMEOUT_MS: '2500',
        PAPER_PRIORITY_FEE_PERCENTILE: 'p75',
        PAPER_PRIORITY_FEE_TARGET_CU: '200000',
        PAPER_PRIORITY_FEE_CACHE_PATH: path.join(root, 'data/priority-fee-cache-paper-oscar-v21.json'),
        PAPER_LIVE_MCAP_TTL_MS: '30000',
        PAPER_ENABLE_LAUNCHPAD_LANE: 'false',
        PAPER_ENABLE_MIGRATION_LANE: 'false',
        PAPER_ENABLE_POST_LANE: 'true',
        PAPER_POST_MIN_AGE_MIN: '2160',
        PAPER_POST_MAX_AGE_MIN: '0',
        PAPER_POST_MIN_LIQ_USD: '200000',
        PAPER_POST_MIN_VOL_5M_USD: '20000',
        PAPER_POST_MIN_BUYS_5M: '4',
        PAPER_POST_MIN_SELLS_5M: '3',
        PAPER_POST_MIN_BS: '0.98',
        PAPER_VOL_5M_1H_GUARD_ENABLED: '1',
        PAPER_VOL_1H_MIN_USD: '36000',
        PAPER_VOL_5M_SPIKE_MAX_MULT: '7',
        PAPER_MIN_HOLDER_COUNT: '3000',
        PAPER_DIP_LOOKBACK_MIN: '120',
        PAPER_DIP_LOOKBACK_WINDOWS_MIN: '120,360,720',
        PAPER_DIP_MIN_DROP_PCT: '-15',
        PAPER_DIP_MAX_DROP_PCT: '-50',
        PAPER_DIP_MIN_IMPULSE_PCT: '12',
        PAPER_DIP_MIN_AGE_MIN: '0',
        /** Бумага: без кулдауна entry→entry и без post-exit паузы. */
        PAPER_DIP_COOLDOWN_MIN: '0',
        PAPER_DIP_COOLDOWN_MIN_SCALP: '0',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED: 'false',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES: '0',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS: '0',
        PAPER_DIP_RECOVERY_VETO_ENABLED: '1',
        PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN: '30,60',
        PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT: '12',
        PAPER_TP_REGIME_ENABLED: '0',
        PAPER_LIVE_EXIT_MODE_AB: '1',
        PAPER_LIVE_EXIT_MODE_B_TRAIL_DROP: '0.12',
        PAPER_LIVE_EXIT_MODE_B_TRAIL_TRIGGER_X: '1.06',
        PAPER_LIVE_EXIT_MODE_B_TIMEOUT_HOURS: '4',
        /** Spec V2.1 §5.3 — kill после усреднения в режиме B: −12% к avg (было −8%). */
        PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP: '-0.12',
        /** Докуп режима B при −6% к avg (было −4% в коде по умолчанию). */
        PAPER_IDEALIZED_OSCAR_MODE_B_ARM_FRAC: '-0.06',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_STEP_PNL: '0.05',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_SELL_FRACTION: '0.50',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.02',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS: '4',
        PAPER_DCA_LEVELS: '',
        PAPER_DCA_KILLSTOP: '-0.05',
        PAPER_TP_LADDER: '',
        PAPER_TP_GRID_STEP_PNL: '0.05',
        PAPER_TP_GRID_SELL_FRACTION: '0.15',
        PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.025',
        PAPER_TP_X: '100',
        PAPER_SL_X: '0',
        PAPER_TRAIL_MODE: 'ladder_retrace',
        PAPER_TRAIL_DROP: '0.10',
        PAPER_TRAIL_TRIGGER_X: '1.10',
        PAPER_TIMEOUT_HOURS: '8',
        PAPER_PEAK_LOG_STEP_PCT: '1',
        PAPER_DIP_WHALE_ANALYSIS_ENABLED: '1',
        PAPER_DIP_REQUIRE_WHALE_TRIGGER: '0',
        PAPER_DIP_LARGE_SELL_USD: '3000',
        PAPER_DIP_RECENT_LOOKBACK_MIN: '10',
        PAPER_DIP_CAPITULATION_PCT: '0.7',
        PAPER_DIP_WHALE_SILENCE_MIN: '10',
        PAPER_DIP_GROUP_SELL_USD: '5000',
        PAPER_DIP_GROUP_MIN_SELLERS: '2',
        PAPER_DIP_GROUP_DUMP_PCT: '0.4',
        PAPER_DIP_BLOCK_CREATOR_DUMP: '1',
        PAPER_DIP_CREATOR_DUMP_LOOKBACK_MIN: '20',
        PAPER_DIP_CREATOR_DUMP_MIN_PCT: '0.05',
        PAPER_DIP_CREATOR_DUMP_MAX_PCT: '0.6',
        PAPER_DIP_DCA_PRED_MIN_SELLS_24H: '4',
        PAPER_DIP_DCA_PRED_MIN_INTERVAL_MIN: '30',
        PAPER_DIP_DCA_PRED_MIN_CHUNK_USD: '3000',
        PAPER_DIP_DCA_AGGR_MIN_SELLS_24H: '6',
        PAPER_DIP_DCA_AGGR_MAX_INTERVAL_MIN: '15',
        PAPER_HOLDERS_LIVE_ENABLED: '0',
        PAPER_HOLDERS_USE_QN_ADDON: '0',
        PAPER_HOLDERS_TTL_MS: '90000',
        PAPER_HOLDERS_NEG_TTL_MS: '15000',
        PAPER_HOLDERS_MAX_PER_TICK: '10',
        PAPER_HOLDERS_TIMEOUT_MS: '4000',
        PAPER_HOLDERS_INCLUDE_TOKEN2022: '1',
        PAPER_HOLDERS_ON_FAIL: 'db_fallback',
        PAPER_HOLDERS_DB_WRITEBACK: '1',
        PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX: '12',
        PAPER_HOLDERS_GPA_CREDITS_PER_CALL: '100',
        QN_FEATURE_BUDGET_HOLDERS: '10000000',
        PAPER_PRICE_VERIFY_ENABLED: '1',
        PAPER_PRICE_VERIFY_BLOCK_ON_FAIL: '1',
        PAPER_PRICE_VERIFY_USE_JUPITER_PRICE: '0',
        PAPER_PRICE_VERIFY_MAX_SLIP_PCT: '4.0',
        PAPER_PRICE_VERIFY_MAX_SLIP_BPS: '400',
        PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT: '8.0',
        PAPER_PRICE_VERIFY_TIMEOUT_MS: '2500',
        PAPER_PRICE_VERIFY_QUOTE_URL: JUPITER_PRO_QUOTE_URL,
        PAPER_PRICE_VERIFY_EXIT_ENABLED: '1',
        PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL: '1',
        PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION: '60',
        PAPER_SIM_AUDIT_ENABLED: '1',
        PAPER_SIM_SAMPLE_PCT: '5',
        PAPER_SIM_MAX_WALL_MS: '8000',
        PAPER_SIM_BUILD_TIMEOUT_MS: '5000',
        PAPER_JUPITER_SWAP_URL: JUPITER_PRO_SWAP_URL,
        PAPER_SIM_USE_JUPITER_BUILD: '1',
        JUPITER_QUOTE_429_MAX_RETRIES: '5',
        JUPITER_QUOTE_429_INITIAL_BACKOFF_MS: '150',
        PAPER_SIM_CREDS_PER_CALL: '30',
        PAPER_SIM_STRICT_BUDGET: '1',
        PAPER_IMPULSE_CONFIRM_ENABLED: '1',
        PAPER_IMPULSE_DIP_POLICY: 'parallel_and',
        PAPER_IMPULSE_PG_MIN_DROP_PCT: '12',
        PAPER_IMPULSE_RPC_MAX_PER_MIN: '30',
        QN_FEATURE_BUDGET_IMPULSE_CONFIRM: '5000000',
        IMPULSE_QN_ROLLING_MAX_CREDITS: '1000000',
        PAPER_LIQ_WATCH_ENABLED: '1',
        PAPER_LIQ_WATCH_FORCE_CLOSE: '1',
        PAPER_LIQ_WATCH_DRAIN_PCT: '35',
        PAPER_LIQ_WATCH_MIN_AGE_MIN: '1',
        PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES: '2',
        PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS: '120000',
        PAPER_LIQ_WATCH_RPC_FALLBACK: '0',
        PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE: '1',
        PAPER_LIQ_WATCH_STAMP_ON_TRACK: '0',
        LIVE_ENTRY_SCALE_IN_ENABLED: '1',
        LIVE_ENTRY_SCALE_IN_DELAY_MS: '5000',
        LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT: '1',
        LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT: '2',
        LIVE_ENTRY_SCALE_IN_OUT_OF_CORRIDOR_POLL_MS: '30000',
        LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS: '8',
        LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS: '2000',
      },
    },
    /**
     * Paper Oscar V2.2 — тот же движок выходов, что **paper-oscar-v21** (IDEALIZED V2.1); более рискованный вход (ниже пороги ликвидности / холдеров / объёмов).
     */
    {
      name: 'paper-oscar-v22',
      cwd: root,
      script: 'npm',
      args: 'run --silent paper-oscar-v22',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: '200M',
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        NODE_ENV: 'production',
        PAPER_STRATEGY_KIND: 'dip',
        PAPER_STRATEGY_ID: 'paper-oscar-v22',
        PAPER_TRADES_PATH: path.join(root, 'data/paper2/paper-oscar-v22.jsonl'),
        PAPER_HEARTBEAT_INTERVAL_MS: '30000',
        PAPER_DISCOVERY_INTERVAL_MS: '10000',
        PAPER_TRACK_INTERVAL_MS: '30000',
        PAPER_FOLLOWUP_TICK_MS: '60000',
        PAPER_DRY_RUN: 'false',
        PAPER_POSITION_USD: '120',
        PAPER_ENTRY_FIRST_LEG_FRACTION: '0.75',
        PAPER_SAFETY_CHECK_ENABLED: '1',
        PAPER_PRIORITY_FEE_ENABLED: '1',
        PAPER_PRIORITY_FEE_TICKER_MS: '60000',
        PAPER_PRIORITY_FEE_MAX_AGE_MS: '600000',
        PAPER_PRIORITY_FEE_RPC_TIMEOUT_MS: '2500',
        PAPER_PRIORITY_FEE_PERCENTILE: 'p75',
        PAPER_PRIORITY_FEE_TARGET_CU: '200000',
        PAPER_PRIORITY_FEE_CACHE_PATH: path.join(root, 'data/priority-fee-cache-paper-oscar-v22.json'),
        PAPER_LIVE_MCAP_TTL_MS: '30000',
        PAPER_ENABLE_LAUNCHPAD_LANE: 'false',
        PAPER_ENABLE_MIGRATION_LANE: 'false',
        PAPER_ENABLE_POST_LANE: 'true',
        PAPER_POST_MIN_AGE_MIN: '2160',
        PAPER_POST_MAX_AGE_MIN: '0',
        PAPER_POST_MIN_LIQ_USD: '100000',
        PAPER_POST_MIN_VOL_5M_USD: '10000',
        PAPER_POST_MIN_BUYS_5M: '4',
        PAPER_POST_MIN_SELLS_5M: '3',
        PAPER_POST_MIN_BS: '0.98',
        PAPER_VOL_5M_1H_GUARD_ENABLED: '1',
        PAPER_VOL_1H_MIN_USD: '30000',
        PAPER_VOL_5M_SPIKE_MAX_MULT: '7',
        PAPER_MIN_HOLDER_COUNT: '1000',
        PAPER_DIP_LOOKBACK_MIN: '120',
        PAPER_DIP_LOOKBACK_WINDOWS_MIN: '120,360,720',
        PAPER_DIP_MIN_DROP_PCT: '-15',
        PAPER_DIP_MAX_DROP_PCT: '-50',
        PAPER_DIP_MIN_IMPULSE_PCT: '12',
        PAPER_DIP_MIN_AGE_MIN: '0',
        /** Бумага: без кулдауна entry→entry и без post-exit паузы. */
        PAPER_DIP_COOLDOWN_MIN: '0',
        PAPER_DIP_COOLDOWN_MIN_SCALP: '0',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED: 'false',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES: '0',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS: '0',
        PAPER_DIP_RECOVERY_VETO_ENABLED: '1',
        PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN: '30,60',
        PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT: '12',
        PAPER_TP_REGIME_ENABLED: '0',
        PAPER_LIVE_EXIT_MODE_AB: '1',
        PAPER_LIVE_EXIT_MODE_B_TRAIL_DROP: '0.12',
        PAPER_LIVE_EXIT_MODE_B_TRAIL_TRIGGER_X: '1.06',
        PAPER_LIVE_EXIT_MODE_B_TIMEOUT_HOURS: '4',
        /** Kill после усреднения в режиме B: −12% к avg (было −8%). */
        PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP: '-0.12',
        /** Докуп режима B при −6% к avg (было −4%). */
        PAPER_IDEALIZED_OSCAR_MODE_B_ARM_FRAC: '-0.06',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_STEP_PNL: '0.05',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_SELL_FRACTION: '0.50',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.02',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS: '4',
        PAPER_DCA_LEVELS: '',
        PAPER_DCA_KILLSTOP: '-0.05',
        PAPER_TP_LADDER: '',
        PAPER_TP_GRID_STEP_PNL: '0.05',
        PAPER_TP_GRID_SELL_FRACTION: '0.15',
        PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.025',
        PAPER_TP_X: '100',
        PAPER_SL_X: '0',
        PAPER_TRAIL_MODE: 'ladder_retrace',
        PAPER_TRAIL_DROP: '0.10',
        PAPER_TRAIL_TRIGGER_X: '1.10',
        PAPER_TIMEOUT_HOURS: '8',
        PAPER_PEAK_LOG_STEP_PCT: '1',
        PAPER_DIP_WHALE_ANALYSIS_ENABLED: '1',
        PAPER_DIP_REQUIRE_WHALE_TRIGGER: '0',
        PAPER_DIP_LARGE_SELL_USD: '3000',
        PAPER_DIP_RECENT_LOOKBACK_MIN: '10',
        PAPER_DIP_CAPITULATION_PCT: '0.7',
        PAPER_DIP_WHALE_SILENCE_MIN: '10',
        PAPER_DIP_GROUP_SELL_USD: '5000',
        PAPER_DIP_GROUP_MIN_SELLERS: '2',
        PAPER_DIP_GROUP_DUMP_PCT: '0.4',
        PAPER_DIP_BLOCK_CREATOR_DUMP: '1',
        PAPER_DIP_CREATOR_DUMP_LOOKBACK_MIN: '20',
        PAPER_DIP_CREATOR_DUMP_MIN_PCT: '0.05',
        PAPER_DIP_CREATOR_DUMP_MAX_PCT: '0.6',
        PAPER_DIP_DCA_PRED_MIN_SELLS_24H: '4',
        PAPER_DIP_DCA_PRED_MIN_INTERVAL_MIN: '30',
        PAPER_DIP_DCA_PRED_MIN_CHUNK_USD: '3000',
        PAPER_DIP_DCA_AGGR_MIN_SELLS_24H: '6',
        PAPER_DIP_DCA_AGGR_MAX_INTERVAL_MIN: '15',
        PAPER_HOLDERS_LIVE_ENABLED: '0',
        PAPER_HOLDERS_USE_QN_ADDON: '0',
        PAPER_HOLDERS_TTL_MS: '90000',
        PAPER_HOLDERS_NEG_TTL_MS: '15000',
        PAPER_HOLDERS_MAX_PER_TICK: '10',
        PAPER_HOLDERS_TIMEOUT_MS: '4000',
        PAPER_HOLDERS_INCLUDE_TOKEN2022: '1',
        PAPER_HOLDERS_ON_FAIL: 'db_fallback',
        PAPER_HOLDERS_DB_WRITEBACK: '1',
        PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX: '12',
        PAPER_HOLDERS_GPA_CREDITS_PER_CALL: '100',
        QN_FEATURE_BUDGET_HOLDERS: '10000000',
        PAPER_PRICE_VERIFY_ENABLED: '1',
        PAPER_PRICE_VERIFY_BLOCK_ON_FAIL: '1',
        PAPER_PRICE_VERIFY_USE_JUPITER_PRICE: '0',
        PAPER_PRICE_VERIFY_MAX_SLIP_PCT: '4.0',
        PAPER_PRICE_VERIFY_MAX_SLIP_BPS: '400',
        PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT: '8.0',
        PAPER_PRICE_VERIFY_TIMEOUT_MS: '2500',
        PAPER_PRICE_VERIFY_QUOTE_URL: JUPITER_PRO_QUOTE_URL,
        PAPER_PRICE_VERIFY_EXIT_ENABLED: '1',
        PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL: '1',
        PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION: '60',
        PAPER_SIM_AUDIT_ENABLED: '1',
        PAPER_SIM_SAMPLE_PCT: '5',
        PAPER_SIM_MAX_WALL_MS: '8000',
        PAPER_SIM_BUILD_TIMEOUT_MS: '5000',
        PAPER_JUPITER_SWAP_URL: JUPITER_PRO_SWAP_URL,
        PAPER_SIM_USE_JUPITER_BUILD: '1',
        JUPITER_QUOTE_429_MAX_RETRIES: '5',
        JUPITER_QUOTE_429_INITIAL_BACKOFF_MS: '150',
        PAPER_SIM_CREDS_PER_CALL: '30',
        PAPER_SIM_STRICT_BUDGET: '1',
        PAPER_IMPULSE_CONFIRM_ENABLED: '1',
        PAPER_IMPULSE_DIP_POLICY: 'parallel_and',
        PAPER_IMPULSE_PG_MIN_DROP_PCT: '12',
        PAPER_IMPULSE_RPC_MAX_PER_MIN: '30',
        QN_FEATURE_BUDGET_IMPULSE_CONFIRM: '5000000',
        IMPULSE_QN_ROLLING_MAX_CREDITS: '1000000',
        PAPER_LIQ_WATCH_ENABLED: '1',
        PAPER_LIQ_WATCH_FORCE_CLOSE: '1',
        PAPER_LIQ_WATCH_DRAIN_PCT: '35',
        PAPER_LIQ_WATCH_MIN_AGE_MIN: '1',
        PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES: '2',
        PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS: '120000',
        PAPER_LIQ_WATCH_RPC_FALLBACK: '0',
        PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE: '1',
        PAPER_LIQ_WATCH_STAMP_ON_TRACK: '0',
        LIVE_ENTRY_SCALE_IN_ENABLED: '1',
        LIVE_ENTRY_SCALE_IN_DELAY_MS: '5000',
        LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT: '1',
        LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT: '2',
        LIVE_ENTRY_SCALE_IN_OUT_OF_CORRIDOR_POLL_MS: '30000',
        LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS: '8',
        LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS: '2000',
      },
    },
    /**
     * Spike-алерты в Telegram (PG). Раньше стартовали отдельно; включено в общий ecosystem,
     * чтобы `pm2 start ecosystem.config.cjs` не терял процесс. Секреты — только в `.env` хоста.
     *
     * Канал по умолчанию: tiered mcap / минутные и rolling окна (`SPIKE_ALERT_TELEGRAM_CHAT_ID`).
     * Алерты с блоками 1–2–3 (pullback / retrace) — другой канал, см. ecosystem.market-pullback-watch.cjs и ecosystem.retrace-alert-watch.cjs.
     */
    {
      name: 'market-spike-telegram-watch',
      cwd: root,
      script: 'npm',
      args: 'run --silent market-spike-telegram-watch',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        SPIKE_ALERT_POLL_INTERVAL_MS: '20000',
        SPIKE_ALERT_POLL_SEND_DEDUPE_MS: '60000',
        SPIKE_ALERT_MINT_COOLDOWN_MINUTES: '60',
        SPIKE_ALERT_SCAN_MINUTES: '60',
        SPIKE_ALERT_ROLLING_MINUTES: '3',
        SPIKE_ALERT_ROLLING_MAX_MINUTES: '10',
        SPIKE_ALERT_THRESHOLD_PCT: '8',
        SPIKE_ALERT_THRESHOLD_PUMP_CONSEC_PCT: '8',
        SPIKE_ALERT_THRESHOLD_DUMP_CONSEC_PCT: '8',
        SPIKE_ALERT_THRESHOLD_ROLLING_PCT: '10',
        SPIKE_ALERT_MIN_HOLDERS: '1000',
        SPIKE_ALERT_HOLDER_NULL_SOFT: '1',
        SPIKE_ALERT_MIN_AGE_HOURS: '8',
        SPIKE_ALERT_MAX_ROWS_PER_TABLE: '800',
        SPIKE_ALERT_MIN_LIQ_USD: '0',
        SPIKE_ALERT_MIN_MARKET_CAP_USD: '2000000',
        SPIKE_ALERT_MIN_VOL_5M_USD: '0',
        SPIKE_ALERT_DRY_RUN: '0',
        SPIKE_ALERT_MAX_NEWER_BAR_AGE_MINUTES: '20',
        SPIKE_ALERT_LOW_LIQ_GLITCH_THRESHOLD_USD: '5000',
        SPIKE_ALERT_LOW_LIQ_MAX_ABS_PCT: '55',
        SPIKE_ALERT_DISPLAY_TZ: 'Europe/Moscow',
        SPIKE_ALERT_GLITCH_NEXT_BAR_RETRACE_MIN: '0.55',
        SPIKE_ALERT_LIQ_MCAP_SANITY: '1',
        SPIKE_ALERT_LIQ_MCAP_REF_MIN_USD: '2000000',
        SPIKE_ALERT_MIN_LIQ_TO_REF_MCAP_RATIO: '0.002',
        SPIKE_ALERT_MC_PRICE_MAX_DIVERGENCE_PCT: '8',
        SPIKE_ALERT_DEXSCREENER_META: '1',
        SPIKE_ALERT_UPSERT_TOKEN_META: '1',
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
        SPIKE_ALERT_ESCALATE_ENABLED: '0',
        SPIKE_ALERT_ESCALATE_DELTA_PCT: '5',
        SPIKE_ALERT_ESCALATE_MIN_GAP_SEC: '60',
        SPIKE_ALERT_ESCALATE_MAX_PER_MINT: '3',
        SPIKE_ALERT_ESCALATE_TIER_CHANGE_FORCES_UPDATE: '1',
        SPIKE_ALERT_AUDIT_DB_ENABLED: '1',
        SPIKE_ALERT_AUDIT_LOG_SKIPS: '0',
        /** Канал «окна + tier по mcap» (не смешивать с pullback/retrace 1–2–3). */
        SPIKE_ALERT_TELEGRAM_CHAT_ID: '-1003633176769',
      },
    },
  ],
};
