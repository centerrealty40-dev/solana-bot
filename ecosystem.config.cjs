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

/** Advice / health / ALERT (live-oscar, collector-watch, snapshot stale, pg coverage). */
const OPERATOR_TELEGRAM_CHAT_ID = '-1003878024799';
/** Spike tiered pump/dump watch — отдельный бот, отдельный канал. */
const SPIKE_TELEGRAM_CHAT_ID = '-1003633176769';
/** Pullback + retrace (блоки 1–2–3) — отдельный бот, общий dips-канал. */
const DIPS_TELEGRAM_CHAT_ID = '-1003504887486';

/**
 * live-oscar (`name: live-oscar`): entry notional vs max cap with DCA.
 * Boot fails if PAPER_POSITION_USD exceeds LIVE_MAX_POSITION_USD (see src/live/main.ts).
 *
 * Prod entry split $300+$300 = $600; DCA −10%/−20% × $200; max $1000 per mint.
 */
const LIVE_OSCAR_ENTRY_NOTIONAL_USD = '600';
const LIVE_OSCAR_MAX_POSITION_USD = '1000';

/** 1.11.281 — discovery SQL + priority mints → DexScreener enrich (не trading whitelist). */
const DISCOVERY_COLLECTOR_PIN_PATH = path.join(root, 'data/live/discovery-collector-pin-mints.txt');
const DISCOVERY_COLLECTOR_PIN_ENV = {
  PAPER2_SNAPSHOT_DISCOVERY_PIN: '1',
  PAPER2_SNAPSHOT_DISCOVERY_PIN_PATH: DISCOVERY_COLLECTOR_PIN_PATH,
  PAPER2_SNAPSHOT_DISCOVERY_PIN_MAX: '200',
};

/**
 * Локальный дневной потолок QN (solana-rpc-meter / provider cache) — выкл.
 * Учёт credits в data/quicknode-usage.json остаётся; hard stop только от плана в кабинете QuickNode.
 */
const QUICKNODE_NO_DAILY_CAP_ENV = {
  QUICKNODE_DAILY_ENFORCE: '0',
  QUICKNODE_DAILY_ENFORCE_PROVIDER: '0',
};

const PM2_APPS = [
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
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        HOST: '0.0.0.0',
        PORT: '3008',
        /** Должен совпадать с `isOrganizerPaperStorePath` в dashboard-server (имя `organizer-paper.jsonl`). */
        STORE_PATH: path.join(root, 'data/paper2/organizer-paper.jsonl'),
        PAPER2_DIR: path.join(root, 'data/paper2'),
        DASHBOARD_LIVE_OSCAR_JSONL: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        DASHBOARD_COPY_TRADER_JSONL: path.join(root, 'data/copytrader/journal.jsonl'),
        DASHBOARD_COPY_TRADER_STATE_PATH: path.join(root, 'data/copytrader/state.json'),
        DASHBOARD_PUMPSWAP_COMBO_JSONL: path.join(root, 'data/pumpswap-combo/journal.jsonl'),
        DASHBOARD_PUMPSWAP_COMBO_FOLLOW_JSONL: path.join(root, 'data/pumpswap-combo-follow/paper-journal.jsonl'),
        /** Вторая плитка «Wallet» в шапке `/papertrader2` — баланс copy-trader (бывший risky). */
        DASHBOARD_COPY_TRADER_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        DASHBOARD_LIVE_OSCAR_RISKY_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        /** Wallet tiles: same RPC chain as live-oscar (Helius when QN TLS/meter blocks). */
        LIVE_WALLET_PUBKEY: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
        SOLANA_RPC_HELIUS_PREFER: '1',
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
      max_memory_restart: '1024M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        RAYDIUM_COLLECTOR_INTERVAL_MS: '30000',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DISCOVERY_COLLECTOR_PIN_ENV,
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
      max_memory_restart: '1024M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        METEORA_COLLECTOR_INTERVAL_MS: '30000',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DISCOVERY_COLLECTOR_PIN_ENV,
      },
    },
    // sa-orca disabled 2026-05-26: orca-collector runaway CPU since 2025-05-24; negligible for live-oscar (pumpswap lane).
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
      max_memory_restart: '1024M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        MOONSHOT_COLLECTOR_INTERVAL_MS: '30000',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DISCOVERY_COLLECTOR_PIN_ENV,
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
      max_memory_restart: '1024M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PUMPSWAP_COLLECTOR_INTERVAL_MS: '30000',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DISCOVERY_COLLECTOR_PIN_ENV,
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
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        /** W6.13 — detective ledger: высокий потолок; фактический лимит — план QuickNode в кабинете. */
        SA_QN_GLOBAL_CREDITS_PER_DAY: '50000000',
        SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY: '50000000',
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
        /** [ALERT][dex_collectors] — 429, тики, сеть, tick failed, fatal, log silence. */
        TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        COLLECTOR_WATCH_POLL_MS: '15000',
        COLLECTOR_WATCH_TELEGRAM: '1',
        COLLECTOR_WATCH_SILENCE_MAX_MS: '480000',
      },
    },
    {
      name: 'sa-rate-429-report',
      cwd: root,
      script: 'scripts-tmp/rate-429-halfhour-report.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '80M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        /** [REPORT][agent_429] — сводка 429 каждые 30 мин для агента / triage. */
        TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        RATE_429_REPORT_INTERVAL_MS: '1800000',
        RATE_429_REPORT_POLL_MS: '60000',
        RATE_429_REPORT_TELEGRAM: '1',
      },
    },
    {
      name: 'sa-snapshot-freshness-watch',
      cwd: root,
      script: 'scripts-tmp/snapshot-freshness-watch.mjs',
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
        /** [ALERT][snapshot_stale] при age PG snapshots > SNAPSHOT_FRESHNESS_MAX_AGE_SEC. */
        TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        SNAPSHOT_FRESHNESS_POLL_MS: '300000',
        SNAPSHOT_FRESHNESS_MAX_AGE_SEC: '600',
        SNAPSHOT_FRESHNESS_REPEAT_ALERT_MS: '3600000',
        /** sa-orca off — do not treat stale orca_pair_snapshots as prod incident. */
        SNAPSHOT_FRESHNESS_SKIP_SOURCES: 'orca',
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
      max_memory_restart: '1024M',
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
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        NODE_ENV: 'production',
        /** Billable RPC: QuickNode (`SA_RPC_HTTP_URL` в .env). Helius — только fallback при QN budget block. */
        SOLANA_RPC_HELIUS_FALLBACK_ENABLED: '1',
        SOLANA_RPC_HELIUS_PREFER: '0',
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
        /** 1.11.244: быстрее reeval для SQL-pool mint'ов; priority tier — `PAPER_PRIORITY_DISCOVERY_REEVAL_SEC`. */
        PAPER_DISCOVERY_REEVAL_SEC: '30',
        /** 1.11.244: шире SQL-пул при малом числе активных монет. */
        PAPER_SNAPSHOT_CANDIDATE_LIMIT: '500',
        PAPER_TRACK_INTERVAL_MS: '30000',
        PAPER_FOLLOWUP_TICK_MS: '60000',
        PAPER_DRY_RUN: 'false',
        /**
         * Staged-entry: сплит **$300+$300** (10 с, +3%/−10% к 1-й ноге); staged avg −7%/−14% выкл; DCA −10%/−20% × $200.
         */
        PAPER_POSITION_USD: LIVE_OSCAR_ENTRY_NOTIONAL_USD,
        PAPER_ENTRY_FIRST_LEG_FRACTION: '0.5',
        PAPER_LIVE_STAGED_ENTRY_ENABLED: '1',
        PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS: '10000',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_UP_PCT: '3',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_DOWN_PCT: '10',
        PAPER_LIVE_STAGED_ENTRY_AVG_COOLDOWN_MS: '180000',
        PAPER_LIVE_STAGED_ENTRY_AVG_SECOND_COOLDOWN_MS: '300000',
        PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT: '7',
        PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD: '0',
        PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT: '14',
        PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD: '0',
        /** 0 = signal-kill off (не путать с PAPER_TIMEOUT_HOURS 48h). */
        PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS: '0',
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
        /** Min liq post-lane / discovery ($30k). */
        PAPER_POST_MIN_LIQ_USD: '30000',
        /** 1.11.244: $10k vol5m отрезал тихие проливы (MANIFEST −17% при v5m=$7k). Код-default 2500. */
        PAPER_POST_MIN_VOL_5M_USD: '2500',
        PAPER_POST_MIN_BUYS_5M: '4',
        PAPER_POST_MIN_SELLS_5M: '3',
        PAPER_POST_MIN_BS: '0.95',
        /**
         * Discovery SQL pool: от $1.3M (коридор low-lane). Prod-входы — mcap ≥ $3M (tier prod).
         * Не путать с low-only: $1.3M–$3M используют отдельные dip/vol (см. PAPER_LIVE_OSCAR_LOW_*).
         */
        PAPER_DISCOVERY_MIN_MARKET_CAP_USD: '1300000',
        /** Не сканировать discovery pool / eval для mcap > $50M (экономия PG/CPU). Открытые позиции — исключение. */
        PAPER_DISCOVERY_MAX_MARKET_CAP_USD: '50000000',
        /** 1.11.306 — узкий коридор $1.3M–$3M: dip −30%, vol1h ≥$75k, сплит 2×$200, DCA $200/ступень (max $800). */
        PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED: '1',
        PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD: '1300000',
        PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD: '3000000',
        PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT: '-30',
        PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD: '75000',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD: '200',
        PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD: '400',
        PAPER_LIVE_OSCAR_LOW_MCAP_DCA_LEVELS: '-10:0.5,-20:0.5',
        /** Prod tier (mcap ≥ $3M): near-miss runner — dip −18%, vol1h ≥$25k. Low tier $1.3–3M без изменений. */
        PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT: '-18',
        PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD: '25000',
        PAPER_VOL_5M_1H_GUARD_ENABLED: '1',
        PAPER_VOL_1H_MIN_USD: '36000',
        PAPER_VOL_5M_SPIKE_MAX_MULT: '7',
        /** `0` — без порога по holders в globalGate / dip-clones (код не трогаем). */
        PAPER_MIN_HOLDER_COUNT: '0',

        PAPER_DIP_LOOKBACK_MIN: '120',
        PAPER_DIP_LOOKBACK_WINDOWS_MIN: '120,360,720',
        /** Live Oscar only: мин. глубина просадки от high окна (OR 120/360/720 мин). −20 = −20%.
         *  1.11.283: возврат к −20% — меньше входов (было −16 с 1.11.242). */
        PAPER_DIP_MIN_DROP_PCT: '-20',
        PAPER_DIP_MAX_DROP_PCT: '-50',
        PAPER_DIP_MIN_IMPULSE_PCT: '12',
        /** 1.11.283: паритет с PAPER_POST_MIN_AGE_MIN (36 ч). Было 0 — volume-leader inject обходил post SQL age. */
        PAPER_DIP_MIN_AGE_MIN: '2160',
        /** Глобальный gate discovery/dip: возраст токена (мин), не только age_min пула. */
        PAPER_MIN_TOKEN_AGE_MIN: '2160',
        PAPER_DIP_COOLDOWN_MIN: '30',
        PAPER_DIP_COOLDOWN_MIN_SCALP: '20',
        /** После **любого** полного закрытия по mint — legacy blunt cooldown; выкл. при hybrid re-entry (dip12 + 20m). */
        PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED: 'false',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES: '10',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS: '0',
        /**
         * Re-entry после полного выхода: только если цена ≤ last_exit×(1−12%).
         * `LIVE_REENTRY_GATE_MAX_AGE_HOURS` — после N ч гейт снимается (без timer-fallback).
         */
        LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT: '12',
        /** >0 включает price-only re-entry path (timer bypass убран в коде). */
        LIVE_REENTRY_MAX_WAIT_MINUTES: '20',
        LIVE_REENTRY_GATE_MAX_AGE_HOURS: '4',
        /** После убыточного / stress-выхода: dip ≥30% от last exit. */
        LIVE_REENTRY_LOSS_MIN_DROP_FROM_LAST_EXIT_PCT: '30',
        LIVE_REENTRY_HYBRID_DISABLE_TIMER_AFTER_LOSS: '1',
        /** Loss re-entry cooldown выкл. — вместо него permanent denylist (`LIVE_NEGATIVE_TRADE_DENY_*`). */
        LIVE_MINT_LOSS_REENTRY_COOLDOWN_ENABLED: '0',

        PAPER_DIP_RECOVERY_VETO_ENABLED: '1',
        PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN: '30,60',
        PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT: '12',
        /** Live Oscar guard: не покупать первую ногу по сигналу, если цена уже у локального high. */
        PAPER_DIP_LOCAL_HIGH_VETO_ENABLED: '1',
        PAPER_DIP_LOCAL_HIGH_VETO_WINDOWS_MIN: '30,60,120',
        PAPER_DIP_LOCAL_HIGH_VETO_MAX_DISTANCE_PCT: '2',
        /** Trend structure veto — stale runner / multi-day downtrend (1.11.249). Off until backtest OK. */
        PAPER_TREND_STRUCTURE_VETO_ENABLED: '0',
        PAPER_TREND_VETO_LOOKBACK_DAYS: '14',
        PAPER_TREND_VETO_MIN_PG_SAMPLES: '36',
        PAPER_TREND_VETO_NO_HIGH_BREAK_ENABLED: '1',
        PAPER_TREND_VETO_MIN_DAYS_SINCE_HIGH_BREAK: '7',
        PAPER_TREND_VETO_DECLINE_ENABLED: '1',
        PAPER_TREND_VETO_MAX_PX_VS_HIGH_14D: '0.75',
        PAPER_TREND_VETO_MAX_SLOPE_7D_PCT: '0',
        PAPER_TREND_VETO_PEAK_TOUCH_TOLERANCE_PCT: '1',
        /** Post-crash fast path — entry vs crash peak after spike+drop (swarms-class). */
        PAPER_POST_CRASH_FAST_PATH_ENABLED: '1',
        PAPER_POST_CRASH_FAST_PATH_LOOKBACK_MIN: '180',
        PAPER_POST_CRASH_FAST_PATH_MIN_PG_SAMPLES: '8',
        PAPER_POST_CRASH_FAST_PATH_MIN_DROP_PCT: '-20',
        PAPER_POST_CRASH_FAST_PATH_MAX_DROP_PCT: '-50',
        PAPER_POST_CRASH_FAST_PATH_MIN_VOL_SPIKE_MULT: '5',
        PAPER_POST_CRASH_FAST_PATH_STABILIZE_MIN: '25',
        PAPER_POST_CRASH_FAST_PATH_MAX_AGE_MIN: '240',
        PAPER_POST_CRASH_FAST_PATH_MAX_KNIFE_15M_PCT: '-8',
        PAPER_POST_CRASH_FAST_PATH_BYPASS_LOCAL_HIGH_VETO: '1',

        /**
         * Policy A+ (1.11.167): четыре «хирургических» правила пропуска кандидатов,
         * выявленные по корреляционному анализу 119 закрытых сделок Live Oscar.
         * На исторической выборке оставляет 46/119 трейдов (-61%), повышает win-rate
         * с 56% до 70% и поднимает Σ PnL с −$70 до **+$658** (см. CHANGELOG 1.11.167).
         *
         *   1. `BOUNCE_FROM_MIN_30M_MAX_PCT` — не входить если цена уже отскочила
         *      более чем на 2.5% от 30-минутного минимума (мы должны быть «на дне»).
         *   2. `PRICE_CHANGE_1H_MIN_PCT` — не входить если за последний час падение
         *      больше чем 20% (вход в свободное падение).
         *   3. `VOL_1H_MAX_USD` — не входить если 1ч-объём > $1M (хайп / pump-and-dump).
         *   4. `PRICE_CHANGE_30M_MIN_PCT` + `PRICE_CHANGE_WINDOW_MIN` — не входить если за
         *      последние 15 мин (было 30) падение больше чем 10%.
         *
         * Каждое правило независимо отключается флагом `*_ENABLED=0`. Метрики
         * вычисляются из `*_pair_snapshots` PG: цена now, 30 мин и 1 ч назад,
         * минимум за последние 30 мин, объём 1 ч (`volume_1h`).
         */
        PAPER_POLICY_A_PLUS_ENABLED: '1',
        PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_ENABLED: '1',
        PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT: '2.5',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_ENABLED: '1',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_MIN_PCT: '-20',
        PAPER_POLICY_A_PLUS_VOL_1H_ENABLED: '1',
        PAPER_POLICY_A_PLUS_VOL_1H_MAX_USD: '1000000',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_ENABLED: '1',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_WINDOW_MIN: '15',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT: '-7',
        /**
         * Volume Sybil guard (1.11.216): блокирует dead→spike→dead wash-паттерн
         * по истории `volume_5m` в PG snapshots (lookback 6h, recent 45m).
         */
        PAPER_VOLUME_SYBIL_GUARD_ENABLED: '1',
        PAPER_VOLUME_SYBIL_LOOKBACK_HOURS: '6',
        PAPER_VOLUME_SYBIL_RECENT_MINUTES: '45',
        PAPER_VOLUME_SYBIL_BASELINE_P10_MAX_USD: '3000',
        PAPER_VOLUME_SYBIL_MIN_BASELINE_SAMPLES: '25',
        PAPER_VOLUME_SYBIL_MIN_RECENT_VOL5M_USD: '8000',
        PAPER_VOLUME_SYBIL_SPIKE_RATIO_MIN: '6',
        PAPER_VOLUME_SYBIL_DEAD_VOL5M_USD: '2500',
        /** 1.11.245: p10 alone ловил живые монеты (MANIFEST); нужны dead_frac + p50 + vol1h exempt. */
        PAPER_VOLUME_SYBIL_MIN_DEAD_FRACTION: '0.55',
        PAPER_VOLUME_SYBIL_VOL1H_ALIVE_EXEMPT_USD: '36000',
        /**
         * Volume Ephemeral guard (1.11.219): блокирует монеты с объёмом, сжатым
         * в узкое почасовое окно (разовый burst — паттерн GOAT).
         */
        PAPER_VOLUME_EPHEMERAL_GUARD_ENABLED: '1',
        PAPER_VOLUME_EPHEMERAL_LOOKBACK_HOURS: '24',
        PAPER_VOLUME_EPHEMERAL_MIN_ACTIVE_HOUR_VOL5M_USD: '8000',
        PAPER_VOLUME_EPHEMERAL_MAX_ACTIVE_HOURS: '4',
        PAPER_VOLUME_EPHEMERAL_MIN_PEAK_VOL5M_USD: '20000',
        PAPER_VOLUME_EPHEMERAL_MIN_HOURS_WITH_DATA: '2',
        PAPER_VOLUME_EPHEMERAL_SPARSE_HOURS_BUFFER: '2',
        PAPER_VOLUME_EPHEMERAL_TAIL_BLOCK_ENABLED: '1',
        PAPER_VOLUME_EPHEMERAL_TAIL_MAX_PEAK_RATIO: '0.3',
        /**
         * PG data coverage (1.11.222): block near-entry when PG minute history is gapped/thin;
         * ADVICE `live_oscar_pg_data_coverage` in Telegram when skip due to incomplete data.
         */
        PAPER_PG_DATA_COVERAGE_GUARD_ENABLED: '1',
        PAPER_PG_DATA_COVERAGE_LOOKBACK_HOURS: '24',
        /** Mint/sybil checks use last 6h during outage; full 24h tier auto-restores when PG healthy. */
        PAPER_PG_DATA_COVERAGE_RECENT_HOURS: '6',
        PAPER_PG_DATA_COVERAGE_MIN_RECENT_HOURS_WITH_DATA: '4',
        PAPER_PG_DATA_COVERAGE_MIN_HOUR_RATIO: '0.5',
        PAPER_PG_DATA_COVERAGE_STRICT_MIN_HOUR_RATIO: '0.75',
        PAPER_PG_DATA_COVERAGE_MIN_SYSTEM_HOUR_RATIO: '0.7',
        PAPER_PG_DATA_COVERAGE_MIN_MINUTES_PER_HOUR: '45',
        PAPER_PG_DATA_COVERAGE_MAX_GAP_MINUTES: '30',
        PAPER_PG_DATA_COVERAGE_BLOCK_ON_PG_STALE: '1',
        PAPER_PG_DATA_COVERAGE_STRICT_AFTER_RECOVERY_HOURS: '24',
        PAPER_PG_DATA_COVERAGE_AUTO_ESCALATE: '1',
        LIVE_PG_DATA_COVERAGE_TELEGRAM_ENABLED: '1',
        LIVE_PG_DATA_COVERAGE_TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        LIVE_PG_DATA_COVERAGE_TELEGRAM_COOLDOWN_MS: '1800000',
        /** TG: блок volume ephemeral guard — подозрительный разовый всплеск объёма. */
        LIVE_VOLUME_EPHEMERAL_TELEGRAM_ENABLED: '1',
        LIVE_VOLUME_EPHEMERAL_TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        LIVE_VOLUME_EPHEMERAL_TELEGRAM_COOLDOWN_MS: '1800000',
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
         * DCA −10% / −20%, по $200 (~0.333333 × $600 `PAPER_POSITION_USD`).
         * Max invested $600 + $200 + $200 = $1000 ladder; cap $1000 (`LIVE_MAX_POSITION_USD`).
         */
        PAPER_DCA_LEVELS: '-10:0.333333,-20:0.333333',
        /** No price kill — timed loss exits only (salvage24 / h48_loss). */
        PAPER_DCA_KILLSTOP: '0',
        /**
         * Variant A v2 hybrid (1.11.272): infinite +5% TP grid, 10% remainder per rung,
         * partial trail @+10%, DCA resets TP rungs. In-flight v3 scratch / v1 / wave_b unchanged.
         */
        PAPER_TP_LADDER: '',
        PAPER_TP_GRID_STEP_PNL: '0.05',
        PAPER_TP_GRID_SELL_FRACTION: '0.10',
        /** Пусто = 10% остатка на каждой ступени (+5%, +10%, …). НЕ ставить `'0'` — парсер даёт [0] = 0% sell. */
        PAPER_TP_GRID_SELL_FRACTION_PROFILE: '',
        PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0',
        PAPER_TP_X: '100',
        PAPER_SL_X: '0',
        PAPER_TRAIL_MODE: 'peak',
        PAPER_TRAIL_DROP: '0.12',
        PAPER_TRAIL_TRIGGER_X: '1.35',
        /** salvage24 + h48 loss; smart48 off — no forced 96h on winners. */
        PAPER_TIMEOUT_HOURS: '48',
        PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED: '0',
        PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_FRACTION: '0.5',
        /** 1.11.304: thin market after 1st TP → flush remainder (combo peak≥+8%, cur≥+2.5%). */
        PAPER_LIVE_OSCAR_THIN_VOL_EXIT_ENABLED: '1',
        /** Wave B on for new opens — escalating TP ladder (+2.5% steps). Variant A off. */
        PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B: '1',
        PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION: '0.20',
        PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A: '0',
        PAPER_LIVE_OSCAR_VARIANT_A_SALVAGE24_ENABLED: '1',
        PAPER_LIVE_OSCAR_VARIANT_A_SALVAGE24_MIN_PEAK_PCT: '5',
        PAPER_LIVE_OSCAR_VARIANT_A_SMART48_ENABLED: '0',
        LIVE_MINT_SCRATCH_REENTRY_ENABLED: '0',
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

        /**
         * 1.11.231 — holders live re-enabled с QN add-on **fallback'ом на GPA**.
         *   - `USE_QN_ADDON=1` пробует `qn_fetchTokenHolders` (Pro/Token API). При `addon_unsupported` → GPA.
         *   - `ON_FAIL=warn` означает: при RPC-ошибке холдеров **не блокируем** покупку — пишем `holders_unknown` в decision, но даём войти. Раньше было `db_fallback` (использовался устаревший snapshot `holder_count`).
         *   - холдеры запрашиваются ТОЛЬКО для кандидатов, прошедших dip/recovery/vol/sybil (cheapPass=true).
         *     Это ~5 уникальных mint'ов в сутки → ~250-500 RPC-calls/мес — копейки от Pro tier.
         *   - `SNAPSHOT_WARMUP_MAX=0` (как раньше) — не прогреваем holders для всех snapshot rows.
         */
        /**
         * 1.11.232 — holders ВЫКЛЮЧЕНЫ полностью.
         * Решение пользователя: «не нужен нам никакой holder count» — этот сигнал
         * неточный (live-резолв давал n/a, GPA дорогой и шумный), решения принимаются
         * по ликвидности/объёмам/буй-флоу. Все pipeline-вызовы становятся no-op.
         */
        PAPER_HOLDERS_LIVE_ENABLED: '0',
        PAPER_HOLDERS_USE_QN_ADDON: '0',
        PAPER_HOLDERS_TTL_MS: '90000',
        PAPER_HOLDERS_NEG_TTL_MS: '15000',
        PAPER_HOLDERS_MAX_PER_TICK: '0',
        PAPER_HOLDERS_TIMEOUT_MS: '4000',
        PAPER_HOLDERS_INCLUDE_TOKEN2022: '1',
        PAPER_HOLDERS_ON_FAIL: 'warn',
        PAPER_HOLDERS_DB_WRITEBACK: '0',
        PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX: '0',
        PAPER_HOLDERS_GPA_CREDITS_PER_CALL: '100',
        /**
         * 1.11.232 — Runner Mode (параллельный путь к dip-windows).
         *
         * Включает обнаружение «магнитов открытого интереса» по 1ч/12ч/24ч динамике
         * объёма / buy-flow / ликвидности. Работает рядом с dip-фильтром, не заменяя его:
         * dip-логика продолжает ловить настоящие проливы, runner ловит свежие импульсы
         * (новые pump.fun, а также «отыграть второй раз» старые монеты).
         *
         * Anti-stale: `STALE_VOL_RATIO_MAX=0.5` режет TripleT-подобные случаи, где
         * vol_1h уже сильно ниже среднего часа за сутки.
         */
        PAPER_RUNNER_MODE_ENABLED: '0',
        PAPER_RUNNER_MIN_PG_SAMPLES_24H: '36',
        PAPER_RUNNER_MIN_VOL_1H_USD: '80000',
        PAPER_RUNNER_MIN_VOL_12H_USD: '400000',
        PAPER_RUNNER_VELOCITY_MIN_X: '1.5',
        PAPER_RUNNER_MIN_VOL_5M_PEAK_1H_USD: '20000',
        PAPER_RUNNER_BS_1H_MIN: '0.95',
        PAPER_RUNNER_BS_12H_MIN: '1.0',
        PAPER_RUNNER_LIQ_VS_P25_MIN: '0.85',
        PAPER_RUNNER_PRICE_HOLD_MIN: '0.6',
        PAPER_RUNNER_MIN_MCAP_USD: '1000000',
        PAPER_RUNNER_MAX_MCAP_USD: '30000000',
        PAPER_RUNNER_MIN_LIQ_USD: '80000',
        PAPER_RUNNER_STALE_VOL_RATIO_MAX: '0.5',
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
        /**
         * 1.11.230 — Jupiter Pro: бампим 429-retry 5 → 8. Внутренний cap 12 (см. `jupiter-http.ts`).
         * Free-эндпоинт даёт <1 RPS, Pro — 50+ RPS, поэтому 429 от **`/quote`** изредка приходит даже на Pro;
         * экспоненциальный backoff (150 → 270 → 486 ms…) уверенно прокатывает их.
         */
        JUPITER_QUOTE_429_MAX_RETRIES: '8',
        JUPITER_QUOTE_429_INITIAL_BACKOFF_MS: '150',

        /**
         * 1.11.231 — pre-check Jupiter `priceImpactPct` ПЕРЕД simulate.
         * Если impact > порога, не идём в simulate — экономим QN credits + simulate time.
         *   `LIVE_BUY_MAX_PRICE_IMPACT_PCT=1.5` → блочить buy при impact > 1.5%.
         *   `LIVE_SELL_MAX_PRICE_IMPACT_PCT=0` (off) — для выходов важно протолкнуть даже при высоком impact.
         */
        LIVE_BUY_MAX_PRICE_IMPACT_PCT: '1.5',
        LIVE_SELL_MAX_PRICE_IMPACT_PCT: '0',

        /**
         * 1.11.234 — Anti-chase guard для buy-pipeline.
         *
         * Когда retry'и происходят с лагом, цена может уйти. Если внутри одного
         * `runSolToTokenPipeline` quote ушёл по цене ВЫШЕ anchor (первого quote
         * этого вызова) больше чем на `LIVE_BUY_MAX_CHASE_PCT` %, abort.
         * На следующем discovery-tick'е либо decision пере-снимется на свежей
         * цене, либо recovery-veto / local-high-veto заблокируют entry.
         *
         * Default 3% — позволяет нормальный intra-retry drift (~1-1.5%), но
         * блокирует реальный chase (когда цена реально ушла на 3%+ за пару
         * секунд между retry'ями).
         * `0` — выключить проверку.
         */
        LIVE_BUY_MAX_CHASE_PCT: '3',

        /**
         * 1.11.235 — Telegram heartbeat: слать `[HEALTH][live_oscar_pulse]` сообщения
         * только когда есть отклонения. Пользователь жаловался: "не надо мне присылать,
         * нужно только сообщения, когда есть проблемы".
         *
         * Что считается отклонением (триггерит pulse):
         *   - `stats.errors > 0` (runtime errors в дискавери/трекере)
         *   - `consec_sim_fail > 0` (streak неудачных симуляций — QN/Jupiter проблема)
         *   - `snapshot stale` (PG-снимки отстают от now() > порога)
         *
         * `snapshot_stale` ALERT — отправляется ВСЕГДА отдельным каналом
         * (он не зависит от этого флага, это диагностика реальной PG-проблемы).
         *
         * `0` (или не задано) — старое поведение, слать pulse каждые ~10 минут.
         * `1` — silent при нормальной работе.
         */
        LIVE_TELEGRAM_HEALTH_PULSE_ONLY_ON_ALERT: '1',

        /**
         * 1.11.231 — TTL для кэша `getTokenAccountsByOwner` (баланс SPL-кошелька).
         * После каждого confirmed buy/sell кэш явно инвалидируется. Между ними он
         * безопасно живёт 15s — устраняет 5-10× избыточных `getTokenAccountsByOwner` calls/min.
         */
        LIVE_WALLET_SPL_BALANCE_CACHE_TTL_MS: '15000',

        PAPER_SIM_CREDS_PER_CALL: '30',
        PAPER_SIM_STRICT_BUDGET: '0',

        PAPER_IMPULSE_CONFIRM_ENABLED: '1',
        PAPER_IMPULSE_DIP_POLICY: 'parallel_and',
        PAPER_IMPULSE_PG_MIN_DROP_PCT: '12',
        PAPER_IMPULSE_RPC_MAX_PER_MIN: '60',
        QN_FEATURE_BUDGET_IMPULSE_CONFIRM: '50000',
        IMPULSE_QN_ROLLING_MAX_CREDITS: '200000',

        PAPER_LIQ_WATCH_ENABLED: '1',
        PAPER_LIQ_WATCH_FORCE_CLOSE: '1',
        PAPER_LIQ_WATCH_DRAIN_PCT: '25',
        PAPER_LIQ_WATCH_MIN_AGE_MIN: '1',
        PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES: '2',
        PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS: '120000',
        PAPER_LIQ_WATCH_RPC_FALLBACK: '1',
        PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE: '1',
        PAPER_LIQ_WATCH_STAMP_ON_TRACK: '0',

        /**
         * 1.11.309 — flash crash kill (aggressive): velocity + post-fill guard; blocks DCA after trigger.
         * Fractions negative in env (e.g. -0.06 = −6%%). Not a static avg stop.
         */
        PAPER_FLASH_CRASH_KILL_ENABLED: '1',
        PAPER_FLASH_CRASH_KILL_DROP_30S_PCT: '-0.06',
        PAPER_FLASH_CRASH_KILL_DROP_60S_PCT: '-0.08',
        PAPER_FLASH_CRASH_KILL_DROP_180S_PCT: '-0.12',
        PAPER_FLASH_CRASH_KILL_POST_DCA_WARN_PCT: '-0.05',
        PAPER_FLASH_CRASH_KILL_POST_DCA_FULL_PCT: '-0.07',
        PAPER_FLASH_CRASH_KILL_POST_DCA_WARN_WINDOW_MS: '120000',
        PAPER_FLASH_CRASH_KILL_POST_DCA_FULL_WINDOW_MS: '180000',
        PAPER_FLASH_CRASH_KILL_QUOTE_DISCOUNT_PCT: '0.08',
        PAPER_FLASH_CRASH_KILL_QUOTE_DROP_60S_PCT: '-0.05',
        PAPER_FLASH_CRASH_KILL_PARTIAL_SELL_FRACTION: '0.75',
        PAPER_FLASH_CRASH_KILL_DCA_BLOCK_MS: '300000',

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
        /** 1.11.244 — priority dip-watch tier (open + near-ready + recent eval + SQL pool). Whitelist entry off (`LIVE_MINT_WHITELIST_ENABLED=0`). */
        PAPER_PRIORITY_DISCOVERY_ENABLED: '1',
        PAPER_PRIORITY_DISCOVERY_REEVAL_SEC: '15',
        PAPER_PRIORITY_DISCOVERY_LOOKBACK_MIN: '120',
        PAPER_PRIORITY_DISCOVERY_RECENT_EVAL_MIN: '180',
        PAPER_PRIORITY_DISCOVERY_MAX_MINTS: '200',
        PAPER_PRIORITY_DISCOVERY_JUPITER_REFRESH: '1',
        PAPER_PRIORITY_DISCOVERY_JUPITER_MAX_PER_TICK: '25',
        /** 1.11.251 — near-miss dip: Jupiter refresh если PG dip в (min, min+gap] (minute bucket отстаёт). */
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_REFRESH: '1',
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_GAP_PCT: '4',
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_MAX_PER_TICK: '15',
        /** Priority tier BS 0.75 (global POST_MIN_BS остаётся 0.98). */
        PAPER_PRIORITY_DISCOVERY_MIN_BS: '0.75',
        /** 1.11.274 — Volume Leader tier: top-N by 24h peak vol_1h, canonical pool = max volume. */
        PAPER_VOLUME_LEADER_ENABLED: '1',
        PAPER_VOLUME_LEADER_TOP_N: '50',
        PAPER_VOLUME_LEADER_REEVAL_SEC: '15',
        PAPER_VOLUME_LEADER_LOOKBACK_HOURS: '24',
        PAPER_VOLUME_LEADER_QUERY_CACHE_SEC: '60',
        /** 1.11.283: откат 90→30m + меньше top-N — реже inject молодых раннеров. */
        PAPER_VOLUME_LEADER_SNAPSHOT_LOOKBACK_MIN: '30',
        /** 1.11.275 — Snapshot sanity: dead pool / liq≈0 at high mcap before canonical pick. */
        PAPER_DISCOVERY_SNAPSHOT_SANITY_ENABLED: '1',
        PAPER_DISCOVERY_SNAPSHOT_SANITY_REF_MCAP_MIN_USD: '2000000',
        PAPER_DISCOVERY_SNAPSHOT_SANITY_MIN_LIQ_TO_MCAP_RATIO: '0.002',
        PAPER_DISCOVERY_SNAPSHOT_SANITY_MIN_LIQ_SHARE_OF_MINT_MAX: '0.10',
        PAPER_DISCOVERY_SNAPSHOT_SANITY_ZERO_LIQ_MAX_MCAP_USD: '500000',
        /** 1.11.276 — Jupiter cross-check price/mcap for volume-leader tier. */
        PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_ENABLED: '1',
        PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MAX_PER_TICK: '20',
        PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MAX_DIVERGENCE_PCT: '35',
        PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MIN_DIVERGENCE_PCT: '0.5',
        PAPER_WHITELIST_SNAPSHOT_LOOKBACK_MIN: '60',
        ...DISCOVERY_COLLECTOR_PIN_ENV,
        /** Минимальный интервал (мс) между повторными `universe_miss` / `tick_skip` по одному mint. */
        LIVE_DISCOVERY_DEEP_AUDIT_UNIVERSE_MISS_MIN_MS: '60000',
        /** `0` — входы без whitelist; permanent denylist отключён (см. LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED). */
        LIVE_MINT_WHITELIST_ENABLED: '0',
        /** Permanent denylist: блок повторных входов + автодопись после убыточного закрытия. */
        LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED: '0',
        /** Любой убыточный полный выход → mint в permanent denylist (не cooldown). */
        LIVE_NEGATIVE_TRADE_DENY_ENABLED: '1',
        /** Variant A: 24h mint block after salvage24 / h48_loss (not permanent denylist). */
        LIVE_MINT_TIMED_LOSS_COOLDOWN_ENABLED: '1',
        LIVE_MINT_TIMED_LOSS_COOLDOWN_MS: String(24 * 3600 * 1000),
        /** First-mint-probe: не deny при убытке (stub сохранён). */
        LIVE_FIRST_MINT_PROBE_DENY_ON_LOSS_ENABLED: '0',
        /** `0` — не слать ADVICE `live_oscar_staged_signal`. */
        LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_ENABLED: '0',
        /** Suppress dips-channel coin TG when wallet SOL cannot fund buy_open leg. */
        LIVE_DISCOVERY_TG_SUPPRESS_ON_INSUFFICIENT_SOL: '1',
        /** `0` — не слать ADVICE `live_oscar_local_high_veto`. */
        LIVE_LOCAL_HIGH_VETO_TELEGRAM_ENABLED: '0',
        /** Любой net PnL < 0 при закрытии → denylist (`0` = без порога в USD). */
        LIVE_NEGATIVE_TRADE_DENY_MIN_LOSS_USD: '0',
        /**
         * Первый live-вход по mint: split 300+300, kill −5% от сигнала; без deny при убытке.
         * Прибыльное закрытие → `live-oscar-mint-graduated.txt`.
         */
        LIVE_MINT_FIRST_PROBE_ENABLED: '1',
        LIVE_MINT_FIRST_PROBE_KILL_DROP_PCT: '5',
        LIVE_MINT_GRADUATED_PATH: path.join(root, 'data/live/live-oscar-mint-graduated.txt'),
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
        LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        /** После N подряд убытков — удаление из whitelist; `0` = выкл (denylist тоже выкл). */
        LIVE_MINT_WHITELIST_REMOVE_AFTER_CONSEC_LOSSES: '0',
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
        TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        LIVE_HEARTBEAT_INTERVAL_MS: '1800000',
        /** PG snapshot age in pulse + `[ALERT][snapshot_stale]` on heartbeat when stale. */
        SNAPSHOT_FRESHNESS_MAX_AGE_SEC: '600',
        SNAPSHOT_FRESHNESS_SKIP_SOURCES: 'orca',
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
        /**
         * 1.11.230 — Smart retry classification (A.2).
         *
         * Если внутри общего retry-envelope (10 попыток для buy / sell) Jupiter возвращает
         * **slippage class** `sim_err` (`InstructionError[*,{"Custom":1}]`, `0x1771`,
         * текст «Slippage tolerance exceeded»), мы:
         *   1) считаем slippage-class attempts ОТДЕЛЬНО от общего счётчика;
         *   2) бампим `slippageBps` на `LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS` каждый retry,
         *      капируем на `LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS` (даём Jupiter Pro собрать
         *      route с приемлемым price impact на разных пулах);
         *   3) кэпируем по `LIVE_*_SIM_SLIPPAGE_RETRY_ATTEMPTS` — если уже несколько раз
         *      подряд получили slippage-class на тот же intent, дальнейшие повторы
         *      бесполезны (route стабилен, пул просто не выдаёт нужный fill).
         *
         * Buy: 3 попытки (50 → 100 → 150 bps) — потеряем меньше QN-кредитов на
         * глухих маршрутах, чем при 11 одинаковых сим-фейлах. Sell: 6 попыток
         * (50 → 100 → 150 → 200 → 250 → 300 bps) — выходить надо обязательно,
         * адаптивный slippage помогает протолкнуть TP/SL в просадке.
         */
        LIVE_BUY_SIM_SLIPPAGE_RETRY_ATTEMPTS: '2',
        LIVE_SELL_SIM_SLIPPAGE_RETRY_ATTEMPTS: '5',
        LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS: '50',
        LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS: '300',
        /**
         * 1.11.230 — Staged-add sim_err cooldown (A.1).
         *
         * После `LIVE_STAGED_ADD_SIM_ERR_THRESHOLD` подряд идущих `sim_err`
         * на одну `(mint, intentKind)` следующая попытка `staged_avg` /
         * `entry_split` / `dca_add` (а также `buy_open`) блокируется на
         * `LIVE_STAGED_ADD_SIM_ERR_COOLDOWN_MS` мс. Это останавливает «петли»,
         * когда tracker каждые 30с заходит в pipeline на застрявший mint
         * и сжигает кредиты QN на 11 одинаковых симуляциях. Cooldown сбрасывается
         * на первый же успешный заход в pipeline.
         */
        LIVE_STAGED_ADD_SIM_ERR_THRESHOLD: '3',
        LIVE_STAGED_ADD_SIM_ERR_COOLDOWN_MS: '1800000',
        /**
         * 1.11.231 — после N cooldown-rearm'ов auto-denylist. `0` = выкл (заготовка в коде).
         */
        LIVE_STAGED_ADD_AUTO_DENYLIST_ENABLED: '0',
        LIVE_STAGED_ADD_AUTO_DENYLIST_REARMS_THRESHOLD: '5',
        LIVE_STAGED_ADD_AUTO_DENYLIST_TELEGRAM_ENABLED: '1',

        /**
         * 1.11.231 — adaptive Jupiter priority fee при congestion.
         *
         * Если получили 5+ confirm_timeout подряд за 10 минут — boost'аем
         * `liveJupiterPriorityMaxLamports` × 2.5 и держим 30 минут. Потом обратно.
         * Спасает от того, что наши tx залипают в очереди валидаторов при congestion.
         */
        LIVE_ADAPTIVE_PRIORITY_FEE_ENABLED: '1',
        LIVE_ADAPTIVE_PRIORITY_FEE_THRESHOLD: '5',
        LIVE_ADAPTIVE_PRIORITY_FEE_WINDOW_MS: '600000',
        LIVE_ADAPTIVE_PRIORITY_FEE_BOOST_FACTOR: '2.5',
        LIVE_ADAPTIVE_PRIORITY_FEE_HOLD_MS: '1800000',

        /**
         * 1.11.231 — Daily Telegram-сводка по live-oscar (см. `daily-summary.ts`).
         *   Запускается раз в сутки в 00:00 MSK (`HOUR_MSK=0`), читает JSONL за 24 ч,
         *   шлёт 1 message с discovery funnel + buy/sell + sim_err + cooldown rearms.
         */
        LIVE_DAILY_SUMMARY_ENABLED: '1',
        LIVE_DAILY_SUMMARY_HOUR_MSK: '0',
        LIVE_DAILY_SUMMARY_MAX_BYTES: '52428800',

        /**
         * 1.11.231 — file-watch для whitelist + permanent-denylist:
         * реактивное (fs.watch) обновление + Telegram-уведомление с diff (+added, -removed).
         */
        LIVE_MINT_FILE_WATCH_TELEGRAM_ENABLED: '1',
        LIVE_MINT_FILE_WATCH_DEBOUNCE_MS: '500',
        /**
         * 1.11.230 — Jupiter Pro: больше MTM probe (size = max(MIN, min(MAX, remUsd * FRACTION))).
         * Точная цена в tracker → tighter TP/SL. Раньше: [5..45] @12% (тонкая по большим позициям).
         * Сейчас: [20..200] @10% — на $1000 позиции probe = $100 (vs $45 раньше).
         */
        LIVE_TRACKER_MTM_PROBE_MIN_USD: '20',
        LIVE_TRACKER_MTM_PROBE_MAX_USD: '200',
        LIVE_TRACKER_MTM_PROBE_FRACTION: '0.10',
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
        LIVE_MAX_POSITION_USD: LIVE_OSCAR_MAX_POSITION_USD,
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
        /** Live-only: не открывать новые позиции при «просадке» BTC (Binance 1h/4h/24h/72h); `0` = выкл. см. `LIVE_BTC_GATE_ENABLED`. */
        LIVE_BTC_GATE_ENABLED: '1',
        /** Level-2 BTC gate: 1h/4h/24h/72h + drawdown от пика 72h (п.п.; `0` = выкл. для конкретного окна). */
        LIVE_BTC_BLOCK_1H_DRAWDOWN_PCT: '1',
        LIVE_BTC_BLOCK_4H_DRAWDOWN_PCT: '2.5',
        LIVE_BTC_BLOCK_24H_DRAWDOWN_PCT: '2',
        /** 72h/peak выкл. — не блокировать buy_open из‑за давней просадки при отскоке на 1h/4h. */
        LIVE_BTC_BLOCK_72H_DRAWDOWN_PCT: '0',
        LIVE_BTC_BLOCK_PEAK_72H_DRAWDOWN_PCT: '0',
        /** ret1h ≥ 0 → только 1h+4h; 24h не режет покупки на отскоке. */
        LIVE_BTC_RECOVERY_SKIP_LONG_WINDOWS: '1',
        LIVE_BTC_RECOVERY_MIN_RET_1H_PCT: '0',
        /** Telegram в канал дайвов (`LIVE_MINT_WHITELIST_TELEGRAM_*`): блок/снятие BTC gate. `0` = выкл. */
        LIVE_BTC_GATE_TELEGRAM_ENABLED: '1',
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

        /** Периодический self-heal выкл.: хвосты только один раз после close (`LIVE_POST_CLOSE_TAIL_SWEEP_*`). */
        LIVE_PERIODIC_SELF_HEAL_MS: '0',
        LIVE_PERIODIC_SWEEP_MIN_USD: '0.25',
        /** `0` по умолчанию: не продавать обычные live open только по возрасту. `1` — ручной opt-in старого PERIODIC_HEAL force-close. */
        LIVE_PERIODIC_STUCK_FORCE_CLOSE_ENABLED: '0',
        LIVE_PERIODIC_STUCK_GRACE_HOURS: '0.5',
        /** `1` = продавать любые SPL не в open выше min USD (осторожно: скам-airdrops). */
        LIVE_PERIODIC_SWEEP_UNKNOWN_CHAIN_ONLY: '0',
      },
    },
    /**
     * Три канала: advice (`OPERATOR_*`), pumps (`SPIKE_*`), dips (`PULLBACK_*` / `RETRACE_*`).
     * Секреты ботов — только в `.env` хоста.
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
        SPIKE_ALERT_MINT_COOLDOWN_MINUTES: '5',
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
        SPIKE_ALERT_CANONICAL_POOL_BY_MAX_LIQ: '1',
        SPIKE_ALERT_PRIMARY_PAIR_REFRESH: '1',
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
        SPIKE_ALERT_ESCALATE_ENABLED: '1',
        SPIKE_ALERT_ESCALATE_DELTA_PCT: '5',
        SPIKE_ALERT_ESCALATE_MIN_GAP_SEC: '60',
        SPIKE_ALERT_ESCALATE_MAX_PER_MINT: '8',
        SPIKE_ALERT_ESCALATE_TIER_CHANGE_FORCES_UPDATE: '1',
        SPIKE_ALERT_AUDIT_DB_ENABLED: '1',
        SPIKE_ALERT_AUDIT_LOG_SKIPS: '0',
        SPIKE_ALERT_TELEGRAM_CHAT_ID: SPIKE_TELEGRAM_CHAT_ID,
      },
    },
    {
      name: 'market-pullback-telegram-watch',
      cwd: root,
      script: 'npm',
      args: 'run --silent market-pullback-telegram-watch',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PULLBACK_ALERT_TELEGRAM_CHAT_ID: DIPS_TELEGRAM_CHAT_ID,
        PULLBACK_ALERT_POLL_INTERVAL_MS: '20000',
        PULLBACK_ALERT_POLL_SEND_DEDUPE_MS: '120000',
        RETRACE_PULLBACK_CHANNEL_DEDUPE_PEAK_BUCKET_MIN: '15',
        PULLBACK_ALERT_SCAN_MINUTES: '90',
        PULLBACK_ALERT_MIN_RISE_PCT: '6',
        PULLBACK_ALERT_MIN_RETRACE_FROM_PEAK_PCT: '10',
        PULLBACK_ALERT_MIN_HOLDERS: '1000',
        PULLBACK_ALERT_HOLDER_NULL_SOFT: '1',
        PULLBACK_ALERT_MIN_AGE_HOURS: '8',
        PULLBACK_ALERT_MAX_ROWS_PER_TABLE: '800',
        PULLBACK_ALERT_MIN_LIQ_USD: '0',
        PULLBACK_ALERT_MIN_MARKET_CAP_USD: '1000000',
        PULLBACK_ALERT_MIN_VOL_5M_USD: '0',
        PULLBACK_ALERT_DRY_RUN: '0',
        PULLBACK_ALERT_MAX_NEWER_BAR_AGE_MINUTES: '25',
        PULLBACK_ALERT_DISPLAY_TZ: 'Europe/Moscow',
        PULLBACK_ALERT_CANONICAL_POOL_BY_MAX_LIQ: '1',
      },
    },
    {
      name: 'retrace-alert-watch',
      cwd: root,
      script: 'npm',
      args: 'run --silent retrace-alert-watch',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        RETRACE_ALERT_TELEGRAM_CHAT_ID: DIPS_TELEGRAM_CHAT_ID,
        RETRACE_ALERT_POLL_INTERVAL_MS: '20000',
        RETRACE_ALERT_POLL_SEND_DEDUPE_MS: '120000',
        RETRACE_PULLBACK_CHANNEL_DEDUPE_PEAK_BUCKET_MIN: '15',
        RETRACE_ALERT_SCAN_MINUTES: '120',
        RETRACE_ALERT_MIN_MCAP_USD: '1000000',
        RETRACE_ALERT_MIN_PUMP_PCT: '6',
        RETRACE_ALERT_MIN_RETRACE_FROM_PEAK_PCT: '10',
        RETRACE_ALERT_MAX_EVENT_AGE_MINUTES: '15',
        RETRACE_ALERT_MAX_ROWS_PER_TABLE: '800',
        RETRACE_ALERT_MIN_AGE_HOURS: '8',
        RETRACE_ALERT_MIN_HOLDERS: '0',
        RETRACE_ALERT_HOLDER_NULL_SOFT: '1',
        RETRACE_ALERT_DISPLAY_TZ: 'Europe/Moscow',
        RETRACE_ALERT_CANONICAL_POOL_BY_MAX_LIQ: '1',
        RETRACE_ALERT_DRY_RUN: '0',
      },
    },
    /**
     * Stealth copy-trader — отдельный процесс, журнал и (в live) кошелёк.
     * Не импортирует live-oscar; env-блок без LIVE_* / PAPER_* / whitelist Oscar.
     */
    {
      name: 'copy-trader',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/copy-trader.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 8000,
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        NODE_ENV: 'production',
        COPY_TRADER_STRICT_ISOLATION: '1',
        /** Исполнение: бывший live-oscar-risky (Phantom base58 или JSON в этом файле на VPS). */
        COPY_TRADER_WALLET_SECRET: path.join(root, 'data/live/live-oscar-risky.keypair.json'),
        COPY_TRADER_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        COPY_TRADER_USE_RISKY_WALLET: '1',
        /** Лидер: адрес в файле (не execution wallet). */
        COPY_TRADER_TARGET_WALLET_PATH: path.join(root, 'data/copytrader/target-wallet.txt'),
        COPY_TRADER_EXECUTION_MODE: 'live',
        COPY_TRADER_POSITION_USD: '950',
        /** 0 = unlimited (proportional adds/sells only; no cap rows in state). */
        COPY_TRADER_MAX_POSITION_USD: '0',
        COPY_TRADER_MAX_ADDS_PER_MINT: '0',
        COPY_TRADER_MAX_OPEN_POSITIONS: '0',
        COPY_TRADER_MIN_PROPORTIONAL_ADD_USD: '0',
        COPY_TRADER_BUY_DELAY_MS: '30000',
        COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT: '3',
        /** Split entry: $350 probe (350/950) + $600 dip @ leader−4%. */
        COPY_TRADER_ENTRY_PROBE_FRACTION: '0.3684210526315789',
        COPY_TRADER_ENTRY_DIP_DISCOUNT_PCT: '4',
        COPY_TRADER_ENTRY_DIP_CONFIRM_TICKS: '2',
        COPY_TRADER_ENTRY_DIP_VS_PROBE_PCT: '2',
        COPY_TRADER_ENTRY_MIN_DEPLOY_FRACTION: '0.99',
        COPY_TRADER_ADD_PRICE_MAX_PREMIUM_PCT: '0',
        /** Skip new entries/adds when Dex mcap < $1M (existing positions e.g. GO unchanged). */
        COPY_TRADER_MIN_MCAP_USD: '1000000',
        COPY_TRADER_BUY_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_BUY_RETRY_DEFER_LOG_MS: '60000',
        /** Slippage-class sell: retry same bps every 6s up to 2h (no wait for next leader sell). */
        COPY_TRADER_SELL_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_SELL_RETRY_INTERVAL_MS: '6000',
        COPY_TRADER_SELL_RETRY_DEFER_LOG_MS: '30000',
        COPY_TRADER_MIN_PROPORTIONAL_SELL_FRACTION: '0',
        COPY_TRADER_SELL_DELAY_MIN_MS: '20000',
        COPY_TRADER_SELL_DELAY_MAX_MS: '30000',
        COPY_TRADER_POLL_INTERVAL_MS: '12000',
        COPY_TRADER_SLIPPAGE_BPS: '400',
        COPY_TRADER_JOURNAL_PATH: path.join(root, 'data/copytrader/journal.jsonl'),
        COPY_TRADER_STATE_PATH: path.join(root, 'data/copytrader/state.json'),
        COPY_TRADER_TELEGRAM_ENABLED: '0',
        /** Poll + parse leader txs on QuickNode; Helius — fallback при QN budget block. */
        SOLANA_RPC_HELIUS_PREFER: '0',
        SOLANA_RPC_HELIUS_FALLBACK_ENABLED: '1',
      },
    },
    /**
     * Combo #1 AUTONOMOUS — forensic mix of 3 reference PumpSwap dip bots (PG signals only).
     * NO leader wallet / copy. Leader mirror → pumpswap-combo-follow-* only.
     */
    {
      name: 'pumpswap-combo-bot',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/pumpswap-combo-bot.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 8000,
      max_memory_restart: '180M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        /** Isolated wallet — not live-oscar / copy-trader. Direct PumpSwap AMM execution (no Jupiter). */
        PUMPSWAP_COMBO_STRATEGY_ID: 'pumpswap-combo',
        PUMPSWAP_COMBO_JOURNAL_PATH: path.join(root, 'data/pumpswap-combo/journal.jsonl'),
        PUMPSWAP_COMBO_STATE_PATH: path.join(root, 'data/pumpswap-combo/state.json'),
        PUMPSWAP_COMBO_WALLET_SECRET: path.join(root, 'data/pumpswap-combo/wallet.keypair.json'),
        PUMPSWAP_COMBO_WALLET_PUBKEY: 'FLmdN27ovXDwjNJuZPWvu3XwM4nPfU4Apr971Q4Rk13p',
        PUMPSWAP_COMBO_LEG_USD: '3',
        PUMPSWAP_COMBO_PORTFOLIO_STOP_LOSS_USD: '50',
        PUMPSWAP_COMBO_LOSS_COOLDOWN_MS: '600000',
        PUMPSWAP_COMBO_LOSS_ALERT_USD: '5',
        PUMPSWAP_COMBO_POLL_MS: '5000',
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        PUMPSWAP_COMBO_WATCHLIST_MAX: '100',
        PUMPSWAP_COMBO_WATCHLIST_PG_LOOKBACK_MIN: '360',
        PUMPSWAP_COMBO_WATCHLIST_RPC_REFRESH: '4',
        PUMPSWAP_COMBO_WATCHLIST_STREAM_PREFER: '0',
        PUMPSWAP_COMBO_WATCHLIST_RPC_PER_TICK: '4',
        PUMPSWAP_COMBO_WATCHLIST_RPC_DELAY_MS: '120',
        PUMPSWAP_COMBO_METERED_RPC: '1',
        PUMPSWAP_COMBO_RPC_MIN_GAP_MS: '55',
        PUMPSWAP_COMBO_BALANCE_CACHE_MS: '10000',
        PUMPSWAP_COMBO_EXIT_MARK_TTL_MS: '20000',
        PUMPSWAP_COMBO_EXIT_MARK_MAX_STALE_MS: '45000',
        PUMPSWAP_COMBO_EXIT_QUOTES_PER_TICK: '2',
        PUMPSWAP_COMBO_MAX_CONCURRENT_OPENS: '15',
        PUMPSWAP_COMBO_MIN_LIQ_USD: '35000',
        PUMPSWAP_COMBO_MIN_VOL_5M_USD: '0',
        PUMPSWAP_COMBO_MIN_MCAP_USD: '100000',
        PUMPSWAP_COMBO_MAX_MCAP_USD: '3000000',
        PUMPSWAP_COMBO_DUMP_MIN_PCT: '5',
        PUMPSWAP_COMBO_DUMP_MAX_PCT: '22',
        PUMPSWAP_COMBO_DUMP_FRESHNESS_MS: '180000',
        PUMPSWAP_COMBO_PROBE_MAX_DIP_PCT: '5',
        PUMPSWAP_COMBO_ADD_DIP_MIN_PCT: '15',
        PUMPSWAP_COMBO_ADD_DIP_MAX_PCT: '35',
        PUMPSWAP_COMBO_MAX_BUY_LEGS: '3',
        PUMPSWAP_COMBO_ADD_MIN_GAP_MS: '0',
        PUMPSWAP_COMBO_TP1_PCT: '13',
        PUMPSWAP_COMBO_TP1_SELL_FRAC: '0.70',
        PUMPSWAP_COMBO_TP2_PCT: '25',
        PUMPSWAP_COMBO_SL_SINGLE_PCT: '20',
        PUMPSWAP_COMBO_SL_MULTI_PCT: '22',
        PUMPSWAP_COMBO_SL_PRE_DCA_PCT: '35',
        PUMPSWAP_COMBO_SLIPPAGE_BPS: '300',
        /** QuickNode only — Helius monthly cap exhausted. */
        SOLANA_RPC_HELIUS_PREFER: '0',
        SOLANA_RPC_HELIUS_FALLBACK_ENABLED: '0',
      },
    },
    /**
     * Combo #2 paper — mirror hnu5 buys/DCA; pool-quote exit ladder ahead of leader.
     * Validates tp1/tp2 vs stop_loss before live wallet.
     */
    {
      name: 'pumpswap-combo-follow-paper',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/pumpswap-combo-follow-bot.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 8000,
      max_memory_restart: '200M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        QN_FEATURE_BUDGET_DISABLED: '1',
        PUMPSWAP_COMBO_FOLLOW_EXECUTION_MODE: 'paper',
        PUMPSWAP_COMBO_FOLLOW_STRATEGY_ID: 'pumpswap-combo-follow-paper',
        PUMPSWAP_COMBO_FOLLOW_JOURNAL_PATH: path.join(root, 'data/pumpswap-combo-follow/paper-journal.jsonl'),
        PUMPSWAP_COMBO_FOLLOW_STATE_PATH: path.join(root, 'data/pumpswap-combo-follow/paper-state.json'),
        PUMPSWAP_COMBO_FOLLOW_TARGET_WALLET: 'hnu5iBK8UoHb51UFsH1RYTUAYdrhjHvV5YMTf9T1CYN',
        PUMPSWAP_COMBO_FOLLOW_LEG_USD: '3',
        PUMPSWAP_COMBO_FOLLOW_MAX_BUY_LEGS: '3',
        PUMPSWAP_COMBO_FOLLOW_EXIT_LEAD_PCT: '2',
        PUMPSWAP_COMBO_FOLLOW_EXIT_LADDER: '13:0.7,25:1',
        PUMPSWAP_COMBO_FOLLOW_SL_SINGLE_PCT: '20',
        PUMPSWAP_COMBO_FOLLOW_SL_MULTI_PCT: '22',
        PUMPSWAP_COMBO_FOLLOW_SL_PRE_DCA_PCT: '45',
        PUMPSWAP_COMBO_FOLLOW_SL_MODE: 'while_leader_holds_off',
        PUMPSWAP_COMBO_FOLLOW_PORTFOLIO_STOP_LOSS_USD: '50',
        PUMPSWAP_COMBO_FOLLOW_BUY_DELAY_MS: '0',
        PUMPSWAP_COMBO_FOLLOW_POLL_MS: '5000',
        PUMPSWAP_COMBO_FOLLOW_SIGNATURE_LIMIT: '25',
        PUMPSWAP_COMBO_FOLLOW_MIN_LEADER_BUY_USD: '20',
        PUMPSWAP_COMBO_FOLLOW_SLIPPAGE_BPS: '300',
        SOLANA_RPC_HELIUS_PREFER: '0',
        SOLANA_RPC_HELIUS_FALLBACK_ENABLED: '1',
      },
    },
    /**
     * Combo #2 LIVE — mirror hnu5 buys/DCA; ladder exits 2% ahead via direct PumpSwap AMM.
     * Isolated wallet: data/pumpswap-combo-follow/wallet.keypair.json
     */
    {
      name: 'pumpswap-combo-follow-live',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/pumpswap-combo-follow-bot.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 8000,
      max_memory_restart: '200M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        QN_FEATURE_BUDGET_DISABLED: '1',
        PUMPSWAP_COMBO_FOLLOW_EXECUTION_MODE: 'live',
        PUMPSWAP_COMBO_FOLLOW_STRATEGY_ID: 'pumpswap-combo-follow-live',
        PUMPSWAP_COMBO_FOLLOW_JOURNAL_PATH: path.join(root, 'data/pumpswap-combo-follow/journal.jsonl'),
        PUMPSWAP_COMBO_FOLLOW_STATE_PATH: path.join(root, 'data/pumpswap-combo-follow/state.json'),
        PUMPSWAP_COMBO_FOLLOW_WALLET_SECRET: path.join(root, 'data/pumpswap-combo-follow/wallet.keypair.json'),
        PUMPSWAP_COMBO_FOLLOW_WALLET_PUBKEY: 'HcV3BhmKQN5hhFWiKWoRfzuYM2C6ftPjqQC67wo27DDo',
        PUMPSWAP_COMBO_FOLLOW_TARGET_WALLET: 'hnu5iBK8UoHb51UFsH1RYTUAYdrhjHvV5YMTf9T1CYN',
        PUMPSWAP_COMBO_FOLLOW_EXIT_POLICY: 'oscar_wave_b',
        PUMPSWAP_COMBO_FOLLOW_POSITION_USD: '600',
        PUMPSWAP_COMBO_FOLLOW_DCA_LEVELS: '-10:0.333333,-20:0.333333',
        PUMPSWAP_COMBO_FOLLOW_DCA_KILLSTOP_PCT: '50',
        PUMPSWAP_COMBO_FOLLOW_WAVE_B_TRAIL_SELL_FRACTION: '0.20',
        PUMPSWAP_COMBO_FOLLOW_MIRROR_LEADER_ADDS: '0',
        PUMPSWAP_COMBO_FOLLOW_MAX_BUY_LEGS: '3',
        PUMPSWAP_COMBO_FOLLOW_LEG_USD: '3',
        PUMPSWAP_COMBO_FOLLOW_EXIT_LEAD_PCT: '2',
        PUMPSWAP_COMBO_FOLLOW_EXIT_LADDER: '13:0.7,25:1',
        PUMPSWAP_COMBO_FOLLOW_SL_SINGLE_PCT: '20',
        PUMPSWAP_COMBO_FOLLOW_SL_MULTI_PCT: '22',
        PUMPSWAP_COMBO_FOLLOW_SL_PRE_DCA_PCT: '45',
        PUMPSWAP_COMBO_FOLLOW_SL_MODE: 'while_leader_holds_off',
        PUMPSWAP_COMBO_FOLLOW_PORTFOLIO_STOP_LOSS_USD: '50',
        PUMPSWAP_COMBO_FOLLOW_BUY_DELAY_MS: '0',
        PUMPSWAP_COMBO_FOLLOW_POLL_MS: '5000',
        PUMPSWAP_COMBO_FOLLOW_SIGNATURE_LIMIT: '25',
        PUMPSWAP_COMBO_FOLLOW_MIN_LEADER_BUY_USD: '20',
        PUMPSWAP_COMBO_FOLLOW_SLIPPAGE_BPS: '300',
        PUMPSWAP_COMBO_FOLLOW_TREASURY_USDC_MIN_PCT: '15',
        PUMPSWAP_COMBO_FOLLOW_TREASURY_USDC_MAX_PCT: '30',
        PUMPSWAP_COMBO_FOLLOW_TREASURY_USDC_PCT: '20',
        PUMPSWAP_COMBO_FOLLOW_TREASURY_MIN_FREE_SOL: '0.08',
        SOLANA_RPC_HELIUS_PREFER: '0',
        SOLANA_RPC_HELIUS_FALLBACK_ENABLED: '1',
      },
    },
];

module.exports = {
  apps: PM2_APPS,
};
