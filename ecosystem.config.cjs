/** VPS `/opt/solana-alpha`: Живой Оскар + дашборд + сборщики снимков (PM2 читает этот файл). */
const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });
/** Проброс в `env` каждого PM2-приложения, чтобы ключ был в `process.env` даже если дочерний процесс не подхватил `.env` так, как ожидается. */
const JUPITER_API_KEY_PM2 = (process.env.JUPITER_API_KEY || '').trim();
const PM2_JUPITER_KEY_ENV = JUPITER_API_KEY_PM2 ? { JUPITER_API_KEY: JUPITER_API_KEY_PM2 } : {};
/** Alchemy (или иной primary) из `.env` — ключ не в git; перекрывает stale PM2 QN URL при reload. */
const SA_RPC_HTTP_URL_PM2 = (process.env.SA_RPC_HTTP_URL || '').trim();
const LIVE_RPC_HTTP_URL_PM2 = (process.env.LIVE_RPC_HTTP_URL || SA_RPC_HTTP_URL_PM2).trim();
const COPY_TRADER_RPC_URL_PM2 = (process.env.COPY_TRADER_RPC_URL || SA_RPC_HTTP_URL_PM2).trim();
const PM2_SOLANA_RPC_ENV = SA_RPC_HTTP_URL_PM2
  ? {
      SA_RPC_HTTP_URL: SA_RPC_HTTP_URL_PM2,
      LIVE_RPC_HTTP_URL: LIVE_RPC_HTTP_URL_PM2,
      COPY_TRADER_RPC_URL: COPY_TRADER_RPC_URL_PM2,
      SOLANA_RPC_HTTP_URL: SA_RPC_HTTP_URL_PM2,
      ALCHEMY_HTTP_URL: SA_RPC_HTTP_URL_PM2,
    }
  : {};
if (!JUPITER_API_KEY_PM2) {
  console.warn(
    '[ecosystem.config.cjs] JUPITER_API_KEY пуст — Jupiter api.jup.ag free-tier (1 RPS); optional key from .env if present.',
  );
}
/**
 * Jupiter Developer Platform ($25/mo, ~10 RPS with `JUPITER_API_KEY` in VPS `.env`).
 * PM2 passes key via `PM2_JUPITER_KEY_ENV`; tier flag tunes watcher concurrency/delays.
 * Rollback: `JUPITER_DEVELOPER_TIER=0` + `JUPITER_WATCHER_REQUEST_DELAY_MS=1250`.
 */
const JUPITER_DEVELOPER_TIER = '1';
const JUPITER_DEVELOPER_TIER_ENV = { JUPITER_DEVELOPER_TIER };
/** sa-jupiter: 3 workers × 500 ms ≈ 6 RPS (headroom for live-oscar hot-tick / discovery). */
const JUPITER_WATCHER_REQUEST_DELAY_MS = '500';
const JUPITER_WATCHER_QUOTE_CONCURRENCY = '3';
const JUPITER_SWAP_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_BUILD_URL = 'https://api.jup.ag/swap/v1/swap';
/**
 * Shared Jupiter Pro execution envelope — tight slippage + max retries (subscription underutilized).
 * Used by live-oscar-preset-c and copy-trader; live-oscar sets same keys inline (10 bps base).
 */
const JUPITER_PRO_TRADING_ENV = {
  ...JUPITER_DEVELOPER_TIER_ENV,
  JUPITER_QUOTE_429_MAX_RETRIES: '12',
  JUPITER_QUOTE_429_INITIAL_BACKOFF_MS: '100',
  LIVE_JUPITER_QUOTE_URL: JUPITER_SWAP_QUOTE_URL,
  LIVE_JUPITER_SWAP_URL: JUPITER_SWAP_BUILD_URL,
  LIVE_JUPITER_PRIORITY_MAX_SOL: '0.0001',
  LIVE_JUPITER_SWAP_PRIORITY_LEVEL: 'high',
  LIVE_BUY_SIM_RETRY_ATTEMPTS: '20',
  LIVE_BUY_SIM_RETRY_DELAY_MS: '150',
  LIVE_SELL_SIM_RETRY_ATTEMPTS: '20',
  LIVE_SELL_SIM_RETRY_DELAY_MS: '150',
  LIVE_BUY_SIM_SLIPPAGE_RETRY_ATTEMPTS: '10',
  LIVE_SELL_SIM_SLIPPAGE_RETRY_ATTEMPTS: '15',
  LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS: '10',
  LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS: '100',
};

/** Advice / health / ALERT (live-oscar, collector-watch, snapshot stale, pg coverage). */
const OPERATOR_TELEGRAM_CHAT_ID = '-1003878024799';
/** Spike tiered pump/dump watch — отдельный бот, отдельный канал. */
const SPIKE_TELEGRAM_CHAT_ID = '-1003633176769';
/** Pullback + retrace (блоки 1–2–3) — отдельный бот, общий dips-канал. */
const DIPS_TELEGRAM_CHAT_ID = '-1003504887486';
/** Neural Chain News RU — HL TWAP whale alerts + HL Oscar trade pings. */
const HL_NEWS_TELEGRAM_CHAT_ID = '-1003801824851';

/** HL TWAP live + paper — paths on VPS (secrets in `.env`). */
const HL_TWAP_DATA_DIR = path.join(root, 'data/hl-twap');
/** HL Oscar dip-buy perp bot — paper default (secrets in `.env`). */
const HL_OSCAR_DATA_DIR = path.join(root, 'data/hl-oscar-perp');
const HL_OSCAR_PERP_ENV = {
  NODE_ENV: 'production',
  HL_OSCAR_ENABLED: '1',
  HL_OSCAR_LIVE_ENABLED: '1',
  HL_OSCAR_DRY_RUN: '0',
  HL_OSCAR_LEVERAGE: '2',
  HL_OSCAR_MARGIN_USD: '50',
  HL_OSCAR_NOTIONAL_USD: '100',
  HL_OSCAR_POSITION_NOTIONAL_USD: '100',
  /** Single-shot $100 gross on signal ($50 margin @ 2x). Set 1 for staged 30/30/40 DCA. */
  HL_OSCAR_STAGED_ENTRY: '0',
  HL_OSCAR_DIP_MIN_PCT: '-7',
  HL_OSCAR_LEG2_DROP_PCT: '5',
  HL_OSCAR_LEG3_DROP_PCT: '10',
  HL_OSCAR_DIP_MIN_IMPULSE_PCT: '10',
  HL_OSCAR_TIME_STOP_HOURS: '12',
  HL_OSCAR_MAX_OPEN_POSITIONS: '10',
  HL_OSCAR_MIN_DAY_VOLUME_USD: '100000',
  HL_OSCAR_POLL_MS: '60000',
  HL_OSCAR_CANDLE_REFRESH_MS: '300000',
  HL_OSCAR_SCAN_BATCH_SIZE: '25',
  HL_OSCAR_DRAWDOWN_STOP_USD: '500',
  HL_OSCAR_DRAWDOWN_CHECK_MS: '60000',
  HL_OSCAR_JOURNAL_JSONL: path.join(HL_OSCAR_DATA_DIR, 'live.jsonl'),
  HL_OSCAR_HEARTBEAT_PATH: path.join(HL_OSCAR_DATA_DIR, 'heartbeat.json'),
  HL_OSCAR_SLIPPAGE_TOLERANCE: '0.01',
  /** Position kill −45% vs avg (2x lev: exits before ~−100% ROE liquidation). */
  HL_OSCAR_KILL_PCT: '45',
  /** Staged signal kill −45% from signal anchor. */
  HL_OSCAR_STAGED_KILL_DROP_PCT: '45',
  HL_OSCAR_TELEGRAM_CHAT_ID: HL_NEWS_TELEGRAM_CHAT_ID,
  HL_OSCAR_TELEGRAM_ENABLED: '1',
  /** Majors → dedicated hl-oscar-majors bot; alt Oscar skips BTC/ETH. */
  HL_OSCAR_DENYLIST_EXTRA: 'BTC,ETH',
};
/** HL Oscar Majors (BTC+ETH knife Mode A) — paper default until smoke passes. */
const HL_MAJORS_DATA_DIR = path.join(root, 'data/hl-oscar-majors');
const HL_MAJORS_ENV = {
  NODE_ENV: 'production',
  HL_MAJORS_ENABLED: '1',
  HL_MAJORS_LIVE_ENABLED: '1',
  HL_MAJORS_DRY_RUN: '0',
  HL_MAJORS_LEVERAGE: '2',
  HL_MAJORS_MARGIN_USD: '50',
  HL_MAJORS_STAGED_ENTRY: '0',
  HL_MAJORS_DIP_MIN_PCT: '-6',
  HL_MAJORS_DIP_MIN_IMPULSE_PCT: '0',
  HL_MAJORS_DIP_WINDOWS_MIN: '120,360,720',
  HL_MAJORS_DIP_COOLDOWN_MIN: '30',
  HL_MAJORS_BTC_TP_RUNGS: '0.02,0.03,0.04',
  HL_MAJORS_ETH_TP_RUNGS: '0.015,0.02,0.025',
  HL_MAJORS_BTC_TRAIL_ARM_FRAC: '0.02',
  HL_MAJORS_BTC_TRAIL_STEP_DROP_FRAC: '0.01',
  HL_MAJORS_ETH_TRAIL_ARM_FRAC: '0.015',
  HL_MAJORS_ETH_TRAIL_STEP_DROP_FRAC: '0.008',
  HL_MAJORS_TP_SELL_FRAC: '0.5',
  HL_MAJORS_TRAIL_SELL_FRAC: '0.25',
  HL_MAJORS_TIME_STOP_HOURS: '12',
  HL_MAJORS_KILL_PCT: '15',
  HL_MAJORS_STAGED_KILL_DROP_PCT: '10',
  HL_MAJORS_MAX_OPEN_POSITIONS: '2',
  HL_MAJORS_WHITELIST: 'BTC,ETH',
  HL_MAJORS_MIN_DAY_VOLUME_USD: '1000000',
  HL_MAJORS_POLL_MS: '60000',
  HL_MAJORS_CANDLE_REFRESH_MS: '300000',
  HL_MAJORS_SCAN_BATCH_SIZE: '2',
  HL_MAJORS_DRAWDOWN_STOP_USD: '300',
  HL_MAJORS_DRAWDOWN_CHECK_MS: '60000',
  HL_MAJORS_JOURNAL_JSONL: path.join(HL_MAJORS_DATA_DIR, 'live.jsonl'),
  HL_MAJORS_HEARTBEAT_PATH: path.join(HL_MAJORS_DATA_DIR, 'heartbeat.json'),
  HL_MAJORS_SLIPPAGE_TOLERANCE: '0.01',
  HL_MAJORS_TELEGRAM_CHAT_ID: HL_NEWS_TELEGRAM_CHAT_ID,
  HL_MAJORS_TELEGRAM_ENABLED: '1',
};
const HL_TWAP_LIVE_ENV = {
  NODE_ENV: 'production',
  HL_TWAP_LIVE_ENABLED: '0',
  HL_TWAP_PAPER_ENABLED: '1',
  HL_TWAP_UNRESTRICTED: '1',
  HL_TWAP_SHORT_MIN_MINUTES: '9',
  HL_TWAP_MICRO_MIN_MINUTES: '15',
  HL_TWAP_MICRO_MAX_MINUTES: '15',
  HL_TWAP_HOLD_TO_END: '1',
  HL_TWAP_EXIT_EARLY_MINUTES: '0',
  HL_TWAP_EXIT_ADAPTIVE: '0',
  HL_TWAP_EXEC_SLICE_USD: '500',
  HL_TWAP_EXEC_SLICE_GAP_MS: '2000',
  HL_TWAP_ULTRA_SHORT_EXIT_SLICES: '2',
  HL_TWAP_MICRO_EXIT_SLICES: '2',
  HL_TWAP_STANDARD_EXIT_SLICES: '3',
  HL_TWAP_LIVE_JSONL: path.join(HL_TWAP_DATA_DIR, 'live.jsonl'),
  HL_TWAP_AUDIT_JSONL: path.join(HL_TWAP_DATA_DIR, 'signals.jsonl'),
  HL_TWAP_HEARTBEAT_PATH: path.join(HL_TWAP_DATA_DIR, 'heartbeat.json'),
  HL_TWAP_POLL_INTERVAL_MS: '2000',
  HL_TWAP_HEARTBEAT_MS: '60000',
  HL_TWAP_LIVE_NOTIONAL_USD: '50',
  HL_TWAP_LIVE_MARGIN_LEV3_USD: '50',
  HL_TWAP_LIVE_MARGIN_LEV5_USD: '50',
  HL_TWAP_LIVE_MARGIN_LEV7_USD: '50',
  HL_TWAP_LIVE_MARGIN_MAX_USD: '50',
  HL_TWAP_LIVE_MARGIN_MIN_USD: '50',
  HL_TWAP_LIVE_LEVERAGE: '50',
  HL_TWAP_LIVE_LADDER_MODE: 'off',
  HL_TWAP_LIVE_LADDER_DCA_PCT_OF_INITIAL: '0',
  HL_TWAP_LIVE_DYNAMIC_MARGIN_DCA_RESERVE: '0',
  HL_TWAP_LIVE_LADDER_STEP_PCT: '2',
  HL_TWAP_LIVE_LADDER_SLICE_PCT: '30',
  HL_TWAP_LIVE_COIN_MAX_LEGS: '2',
  HL_TWAP_LIVE_MAX_BOOK_GROSS_USD: '5000',
  HL_TWAP_LIVE_DYNAMIC_MARGIN: '0',
  HL_TWAP_COIN_MOMENTUM_GATE: '0',
  HL_TWAP_LIVE_COIN_PRIOR_LOSS_BLOCK: '0',
  HL_TWAP_COIN_BLOCKLIST: 'IP',
  HL_TWAP_BTC_ALIGNED_GATE: '0',
  HL_TWAP_MIN_IMPACT_PCT_HOUR: '5',
  HL_TWAP_LIVE_OPEN_MIN_FILL_RATIO: '0.70',
  HL_TWAP_LIVE_SLIPPAGE_TOLERANCE: '0.003',
  HL_TWAP_LIVE_DRAWDOWN_STOP_USD: '1000',
  HL_TWAP_LIVE_DRAWDOWN_CHECK_MS: '60000',
  HL_TWAP_BALANCE_HOURLY_TELEGRAM: '1',
};

/**
 * live-oscar (`name: live-oscar`): split notional (leg1+leg2) vs max cap (all legs).
 * Boot fails if PAPER_POSITION_USD exceeds LIVE_MAX_POSITION_USD (see src/live/main.ts).
 *
 * 1.11.494 — 3-leg staged entry ($200/$300 only): prod/low $200+$200+$300=$700; micro $300+$200+$300=$800; scalp_wave $300.
 * 1.11.497 — micro: no leg-2 @ −5%; $300 open + $300 staged_avg @ −10% = $600 max.
 * 1.11.499 — «Живой Оскар» canon: prod/low $500+$300+$200=$1000; micro re-enables leg-2 @ −5%: $300+$200+$100=$600; scalp_wave $300; half8_runner flat TP ON.
 * 1.11.505 — prod ≥$3M: 6×$300 entry split @5s (+3/−5% corridor); avg −5% $300, −20% $300; max $2400.
 * 1.11.512 — prod avg −20% leg $300→$500; LIVE_MAX_POSITION_USD $2400→$2600.
 * 1.11.513 — prod 7×$300 entry split; avg −5% $400, −20% $600 (+$100/tier); low avg −10% $350; max $3100 / low $850.
 * 1.11.515 — sim E+2: prod avg1 −10% $400 (was −5%); dip−10% before +8% → 50% @ +5% vs avg (half8_runner).
 * 1.11.517 — E+2 parity low/micro avg −10%; DIP10_FIRST_TP5 tier-agnostic on wave_b half8_runner.
 * 1.11.524 — low $2–3M: 3×$300 entry ($900), avg −10% $350 (max $1250); 10s delay + corridor unchanged.
 * 1.11.522 — low $2–3M: 3×$300 entry ($900) — superseded by 1.11.524.
 * 1.11.518 — prod tiered max position by mcap at entry: $3–5M $3100, $5–8M $2800, $8–12M $2100, ≥$12M $1500; low $2–3M $850 unchanged.
 * 1.11.506 — partial entry slice when wallet SOL short (reserve 0.05 SOL, min partial $50).
 * 1.11.500 — min mcap $2M; micro/scalp_wave OFF; low $2M–$3M: 2×$250 @ 10s (+3/−5% corridor), avg −10% $250; prod ≥$3M: 3×$400 @ 10s, avg −5%/$300 + −20%/$300.
 */
const LIVE_OSCAR_ENTRY_SPLIT_USD = '2100';
const LIVE_OSCAR_MAX_POSITION_USD = '3100';

/** live-oscar-preset-c: single $50 entry @ −10% (no DCA legs). */
const PRESET_C_ENTRY_USD = '50';
const PRESET_C_STAGED_LEG_USD = '50';
const PRESET_C_MAX_POSITION_USD = '50';

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

/**
 * Prod RPC: **Alchemy only** — URL в `.env` (`SA_RPC_HTTP_URL`, опционально `LIVE_RPC_HTTP_URL`, `COPY_TRADER_RPC_URL`).
 * Ключ Alchemy не коммитить; QuickNode/Helius URL в `.env` остаются как резерв, но не используются пока флаги ниже = `0`.
 */
const SOLANA_RPC_ALCHEMY_ONLY_ENV = {
  SOLANA_RPC_HELIUS_PREFER: '0',
  SOLANA_RPC_HELIUS_FALLBACK_ENABLED: '0',
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
        ...PM2_SOLANA_RPC_ENV,
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        HOST: '0.0.0.0',
        PORT: '3008',
        /** Должен совпадать с `isOrganizerPaperStorePath` в dashboard-server (имя `organizer-paper.jsonl`). */
        STORE_PATH: path.join(root, 'data/paper2/organizer-paper.jsonl'),
        PAPER2_DIR: path.join(root, 'data/paper2'),
        DASHBOARD_LIVE_OSCAR_JSONL: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        DASHBOARD_COPY_TRADER_JSONL: path.join(root, 'data/copytrader/journal.jsonl'),
        DASHBOARD_COPY_TRADER_STATE_PATH: path.join(root, 'data/copytrader/state.json'),
        /** SuperBot / live-oscar-preset-c journal (HcV3BhmK wallet, отдельный PM2). */
        DASHBOARD_SUPERBOT_JSONL: path.join(root, 'data/live/live-oscar-preset-c.jsonl'),
        /** Вторая плитка «Wallet» в шапке `/papertrader2` — баланс copy-trader (бывший risky). */
        DASHBOARD_COPY_TRADER_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        DASHBOARD_LIVE_OSCAR_RISKY_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        /** DCA Trader Risky (dc-trader) — tile 3 on `/papertrader2`. */
        DASHBOARD_DC_TRADER_JSONL: '/opt/dc-trader/data/trader-journal.jsonl',
        DASHBOARD_DC_TRADER_STATE_PATH: '/opt/dc-trader/data/trader-state.json',
        DASHBOARD_DC_TRADER_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        /** BasePulse (Base L2) — tile 5; journal synced from 72.62.152.201. */
        DASHBOARD_BASEPULSE_JSONL: path.join(root, 'data/basepulse/basepulse-journal.jsonl'),
        /** Wallet tiles: Alchemy via `.env` `SA_RPC_HTTP_URL` (Helius/QN fallback off). */
        LIVE_WALLET_PUBKEY: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
        ...SOLANA_RPC_ALCHEMY_ONLY_ENV,
        DASHBOARD_PAPER_OSCAR_V21_JSONL: path.join(root, 'data/paper2/paper-oscar-v21.jsonl'),
        DASHBOARD_PAPER_OSCAR_V22_JSONL: path.join(root, 'data/paper2/paper-oscar-v22.jsonl'),
        DASHBOARD_PAPER_OSCAR_RISKY_JSONL: path.join(root, 'data/paper2/paper-oscar-risky.jsonl'),
        /**
         * QuickNode Admin API → Telegram:
         * - `QUICKNODE_HOURLY_REMAINING_TELEGRAM=1` — не чаще 1×/ч `[ALERT][quicknode-balance]` (интервал ≥1h в коде + cooldown ниже).
         * - `QUICKNODE_USAGE_TELEGRAM` (общая дневная сводка) и milestones — выкл., чтобы не шумели.
         */
        QUICKNODE_USAGE_TELEGRAM: '0',
        QUICKNODE_HOURLY_REMAINING_TELEGRAM: '0',
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
        PUMPSWAP_COLLECTOR_INTERVAL_MS: '60000',
        PUMPSWAP_COLLECTOR_ENRICH_MAX_RETRIES: '1',
        PAPER2_SNAPSHOT_SOLO_FETCH_MAX_PER_TICK: '12',
        PAPER2_SNAPSHOT_BATCH_CHUNKS_MAX_PER_TICK: '8',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DISCOVERY_COLLECTOR_PIN_ENV,
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
        ...JUPITER_DEVELOPER_TIER_ENV,
        NODE_ENV: 'production',
        JUPITER_QUOTE_API_URL: JUPITER_SWAP_QUOTE_URL,
        JUPITER_WATCHER_ENQUEUE_RPC: '0',
        /** Developer 10 RPS: 3 parallel workers, 500 ms per worker (~6 RPS). Was 1000 ms serial. */
        JUPITER_WATCHER_REQUEST_DELAY_MS,
        JUPITER_WATCHER_QUOTE_CONCURRENCY,
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
        ...JUPITER_DEVELOPER_TIER_ENV,
        ...PM2_SOLANA_RPC_ENV,
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        NODE_ENV: 'production',
        /** Billable RPC: Alchemy (`SA_RPC_HTTP_URL` / `LIVE_RPC_HTTP_URL` в `.env`). QN/Helius — резерв, fallback off. */
        ...SOLANA_RPC_ALCHEMY_ONLY_ENV,
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
         * 1.11.515 — prod ≥$3M: 7×$300 entry split @5s (+3/−5% corridor); avg −10% $400, −20% $600; max $3100.
         */
        PAPER_POSITION_USD: LIVE_OSCAR_ENTRY_SPLIT_USD,
        PAPER_ENTRY_FIRST_LEG_FRACTION: '0.5',
        PAPER_LIVE_STAGED_ENTRY_ENABLED: '1',
        PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG3_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG4_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG5_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG6_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG7_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS: '5000',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_UP_PCT: '3',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_DOWN_PCT: '5',
        /** 0 = timed corridor splits (not dip-triggered leg-2). */
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_TARGET_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_AVG_COOLDOWN_MS: '0',
        PAPER_LIVE_STAGED_ENTRY_AVG_SECOND_COOLDOWN_MS: '300000',
        PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT: '10',
        PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD: '400',
        PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT: '20',
        PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD: '600',
        /** Signal kill: full exit when price ≤ −N% from signal anchor. */
        PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT: '50',
        PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS: '0',
        /**
         * 1.11.476 — entry-wait window (HOURS) for the staged −10%-from-signal trigger.
         * '0' = OFF (DEFAULT) → timing governed only by SIGNAL_TTL_MS above (=0 = no limit),
         * i.e. byte-for-byte current live entry timing. Set to '1' to drop the signal anchor
         * after a 1h −10% wait (overrides SIGNAL_TTL_MS). Plumbing shipped default-OFF; owner
         * flips when ready. Rollback: set back to '0' (or remove) → current behaviour.
         */
        PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS: '0',
        /**
         * 1.11.466 — observability-only: если возраст использованной PG-цены на входе > N мс,
         * журналируем метрику `live_stale_price_warn` (priceAgeMs, mint, lane). НЕ меняет торговлю.
         * База для замера 30–90s слепоты перед гибридом Shyft (Этап 1). Опц. троттлед-алерт:
         * LIVE_OSCAR_STALE_PRICE_TELEGRAM_ENABLED=1 (default OFF). 0 = выключить варн.
         */
        PAPER_LIVE_OSCAR_STALE_PRICE_WARN_MS: '45000',
        /**
         * 1.11.467 — Этап 1.1: Shyft Yellowstone gRPC SHADOW-стрим (observability only, default OFF).
         * При '1' один gRPC-консьюмер подписывается на swap-tx по watched/open mint'ам (узкий
         * accountInclude, НЕ firehose) и пишет журнал `live_shyft_shadow_price` рядом с PG-ценой на
         * точках входа/MTM — измеряет лаг PG vs стрим. Стрим-цена НИГДЕ не участвует в гейтах/eval/
         * исполнении. При OFF торговля байт-в-байт = текущая. Креды: SHYFT_GRPC_ENDPOINT (default
         * https://grpc.fra.shyft.to) + SHYFT_GRPC_TOKEN (x-token) в .env (НЕ сюда).
         * 1.11.470 — включён ('1') для наблюдения (сбор лага PG); прочие Shyft-флаги остаются '0'.
         */
        PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED: '1',
        PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_AGE_MS: '60000',
        PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_MINTS: '256',
        /**
         * 1.11.468 — Этап 1.2: Shyft stream-цена PRIMARY для live-oscar (MTM открытых позиций +
         * discovery dip-eval), freshness-gate `SHYFT_MAX_STALE_MS` + fallback на PG/Jupiter. Master
         * флаг default OFF — при OFF источник цены байт-в-байт = текущий PG/Jupiter. Требует включённый
         * Stage 1.1 shadow-консьюмер (PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=1 + SHYFT_GRPC_TOKEN), чтобы
         * было что брать как primary. Раскатка: сначала только MTM (SHYFT_PRICE_PRIMARY_MTM_ENABLED=1,
         * default), затем discovery (SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED=1, default 0).
         */
        SHYFT_PRICE_PRIMARY_ENABLED: '0',
        SHYFT_PRICE_PRIMARY_MTM_ENABLED: '1',
        SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED: '0',
        SHYFT_MAX_STALE_MS: '5000',
        /**
         * 1.11.469 — Этап 1.3: mcap/liq кандидата из Shyft DeFi API (`/v0/pools/get_by_token`) с
         * TTL-кэшем + fallback на PG/pump.fun. Override `refMcap` (tier) + входы snapshot mcap/liq-гейта.
         * Default OFF — при OFF источник mcap/liq байт-в-байт = текущий PG. Ключ DeFi REST API:
         * SHYFT_DEFI_API_KEY (или SHYFT_API_KEY) в .env; SHYFT_DEFI_API_BASE default https://defi.shyft.to.
         */
        SHYFT_DEFI_MCAP_ENABLED: '0',
        SHYFT_DEFI_MCAP_TTL_MS: '12000',
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
         * Discovery SQL pool: от $2M (min tradeable mcap). Prod — mcap ≥ $3M; low $2M–$3M.
         * Micro/scalp_wave lanes disabled (1.11.500).
         */
        PAPER_DISCOVERY_MIN_MARKET_CAP_USD: '2000000',
        /** Не сканировать discovery pool / eval для mcap > $50M (экономия PG/CPU). Открытые позиции — исключение. */
        PAPER_DISCOVERY_MAX_MARKET_CAP_USD: '50000000',
        /** 1.11.500 — micro lane OFF (min mcap $2M). */
        PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED: '0',
        PAPER_LIVE_OSCAR_MICRO_MCAP_MIN_USD: '500000',
        PAPER_LIVE_OSCAR_MICRO_MCAP_MAX_USD: '1300000',
        PAPER_LIVE_OSCAR_MICRO_MCAP_DIP_MIN_DROP_PCT: '-30',
        PAPER_LIVE_OSCAR_MICRO_MCAP_VOL_1H_MIN_USD: '20000',
        /** 1.11.516 — micro (lane OFF): 2×$150 entry; avg −10% $210 (max staged $510); TP2 = global DIP10_FIRST_TP5. */
        PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD: '150',
        PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD: '150',
        PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD: '300',
        PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD: '210',
        PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_DROP_PCT: '10',
        PAPER_LIVE_OSCAR_MICRO_MCAP_DCA_LEVELS: '',
        /** 1.11.523 — low $2M–$3M: 3×$300 @ 10s (+3/−5% corridor), avg −10% $350 (max $1250); TP2 = global DIP10_FIRST_TP5. */
        PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED: '1',
        PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD: '2000000',
        PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD: '3000000',
        PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT: '-30',
        PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD: '35000',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD: '300',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD: '300',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG3_USD: '300',
        PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD: '900',
        PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_DROP_PCT: '10',
        PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD: '350',
        PAPER_LIVE_OSCAR_LOW_MCAP_DCA_LEVELS: '',
        /** 1.11.500 — scalp_wave lane OFF. */
        PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED: '0',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_AGE_MIN: '720',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_MCAP_USD: '800000',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD: '30000000',
        PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MIN_DROP_PCT: '-15',
        PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MAX_DROP_PCT: '-8',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_IMPULSE_PCT: '8',
        PAPER_LIVE_OSCAR_SCALP_WAVE_VOL_1H_MIN_USD: '25000',
        PAPER_LIVE_OSCAR_SCALP_WAVE_POSITION_USD: '300',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_CONCURRENT: '3',
        PAPER_LIVE_OSCAR_SCALP_WAVE_TP_PCT: '0.1',
        PAPER_LIVE_OSCAR_SCALP_WAVE_KILL_PCT: '0.1',
        PAPER_LIVE_OSCAR_SCALP_WAVE_TIME_STOP_HOURS: '3',
        /** Prod tier (mcap ≥ $3M): near-miss runner — dip −18%, vol1h ≥$25k. Low tier $2M–$3M — см. PAPER_LIVE_OSCAR_LOW_*. */
        PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT: '-18',
        PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD: '25000',
        /** Prod sub-tier boundary + max caps (signal mcap at entry → scaled slices). 1.11.519. */
        PAPER_LIVE_OSCAR_PROD_MCAP_BAND_12M_USD: '12000000',
        PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD: '3100',
        PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD: '2100',
        PAPER_VOL_5M_1H_GUARD_ENABLED: '1',
        /** 1.11.476: 36000→35000 (owner approved volume expansion; prod tier vol 25000 unchanged). */
        PAPER_VOL_1H_MIN_USD: '35000',
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
        /** После убыточного закрытия — 10 мин cooldown (не denylist). Работает вместе с hybrid re-entry gate. */
        PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED: 'true',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES: '10',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS: '0',
        /**
         * Re-entry после выхода: цена ≤ last_exit×(1−10%) (после loss cooldown 10m).
         */
        LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT: '10',
        LIVE_REENTRY_MAX_WAIT_MINUTES: '240',
        LIVE_REENTRY_GATE_MAX_AGE_HOURS: '4',
        LIVE_REENTRY_LOSS_MIN_DROP_FROM_LAST_EXIT_PCT: '10',
        LIVE_REENTRY_HYBRID_DISABLE_TIMER_AFTER_LOSS: '1',
        LIVE_MINT_LOSS_REENTRY_COOLDOWN_ENABLED: '0',
        /**
         * After KILLSTOP/stress exit: re-buy on modest bounce from short-window low (SPCX 1.8M→1.87M).
         */
        LIVE_STRESS_REENTRY_ENABLED: '1',
        LIVE_STRESS_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT: '40',
        LIVE_STRESS_REENTRY_RECOVERY_VETO_MAX_BOUNCE_PCT: '8',
        LIVE_STRESS_REENTRY_RECOVERY_VETO_MAX_WINDOW_MIN: '30',
        LIVE_STRESS_REENTRY_DIP_MAX_DROP_PCT: '-65',

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
        PAPER_POST_CRASH_FAST_PATH_STABILIZE_MIN: '15',
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

        /** DCA выкл — только сплит $1000+$500. */
        PAPER_DCA_LEVELS: '',
        /** Absolute kill −50% vs entry market (avg или market). Wave B: trail + TP ladder работают после +7.5%; жёсткий стоп −50% действует всегда. (Значение факт: -0.50 = −50%; ранее комментарий ошибочно говорил −9%.) */
        PAPER_DCA_KILLSTOP: '-0.50',
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
        /** Wave B: after +2.5%/+5% TP rungs, peel 50% of remainder once at breakeven rollback. */
        PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_ENABLED: '1',
        PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_FRACTION: '0.5',
        PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_PNL_FRAC: '0',
        /** Post-TP1 de-risk: после 1-й TP при просадке −15% vs avg — продать 50% остатка (backtest +$121 vs baseline). */
        PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_DERISK_ENABLED: '0',
        PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_DERISK_PNL_FRAC: '-0.15',
        PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_DERISK_FRACTION: '0.5',
        /** Post-TP1 scratch/re-entry: honest A/B on 363-trade cohort (real simWaveBStep) — НЕ альфа: реалистично ≈ нейтрален (+$571 шум), теряет −$5k на 36% scratch-без-reentry, churn-баг геометрии порогов. Выключено в 1.11.465. */
        PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_ENABLED: '0',
        PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_DROP_PCT: '15',
        PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_DROP_PCT: '30',
        PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_USD: '1500',
        /** 1.11.304: thin market after 1st TP → flush remainder (combo peak≥+8%, cur≥+2.5%). */
        PAPER_LIVE_OSCAR_THIN_VOL_EXIT_ENABLED: '1',
        /** Wave B on for new opens. Variant A off. */
        PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B: '1',
        PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION: '0.20',
        /**
         * 1.11.475 — TRADING-BEHAVIOR (одобрено владельцем): flat-take ВКЛ. NEW wave-B opens получают
         * ранний/плоский тейк вместо эскалирующей лесенки (CF-оптимизатор: лесенка — убыточный рычаг,
         * ранний/плоский тейк — режим-устойчивый выигрыш). Открытые на момент включения позиции НЕ
         * переклеймляются (остаются на лесенке) — безопасный переход. Режим `half8_runner`: продать 50%
         * на каждом +8% + defensive-trail на остаток (раннер); kill −50% и брейкэвен-пол остаются.
         * Wave-B тайм-стоп 12ч применяется ТОЛЬКО к новым (заклеймлённым) позициям. OFF → байт-в-байт лесенка.
         * 1.11.499 — ВКЛ по «Живой Оскар» канону (продать 50% @ +8%, раннер на трейле).
         */
        PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP: '1',
        PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP_MODE: 'half8_runner',
        /** E+2 TP2: signal −10% before +8% half8 → 50% partial @ +5% vs avg (policy-only exit). */
        PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_ENABLED: '1',
        PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_PARTIAL_PNL_FRAC: '0.05',
        PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_PARTIAL_FRACTION: '0.5',
        PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_SIGNAL_DROP_PCT: '10',
        PAPER_LIVE_OSCAR_WAVE_B_TIME_STOP_HOURS: '12',
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
        /** 1.11.520 — Jupiter Pro: tighter verify quote (was 400 bps free-tier cushion). */
        PAPER_PRICE_VERIFY_MAX_SLIP_BPS: '150',
        PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT: '8.0',
        PAPER_PRICE_VERIFY_TIMEOUT_MS: '2500',
        PAPER_PRICE_VERIFY_QUOTE_URL: JUPITER_SWAP_QUOTE_URL,
        PAPER_PRICE_VERIFY_EXIT_ENABLED: '1',
        PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL: '1',
        /** После N defer pre-exit Jupiter verify по TIMEOUT — один проход без block_on_fail (см. live_exit_verify_defer). */
        PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION: '60',
        /** Min ms between partial TP sells on same mint. Pro tier: 1000 (was 5000). */
        LIVE_PARTIAL_TP_MIN_INTERVAL_MS: '1000',
        /** 1.11.502 — split large live exits (partial TP, kill, full close) into ≤$250 slices. */
        LIVE_EXIT_SLICE_MAX_USD: '250',
        LIVE_EXIT_SLICE_DELAY_MS: '5000',

        PAPER_SIM_AUDIT_ENABLED: '1',
        PAPER_SIM_SAMPLE_PCT: '5',
        PAPER_SIM_MAX_WALL_MS: '8000',
        PAPER_SIM_BUILD_TIMEOUT_MS: '5000',
        PAPER_JUPITER_SWAP_URL: JUPITER_SWAP_BUILD_URL,
        PAPER_SIM_USE_JUPITER_BUILD: '1',
        /**
         * 1.11.520 — Jupiter Pro ($25/mo): max 429 retries (cap 12 in `jupiter-http.ts`), fast backoff.
         */
        JUPITER_QUOTE_429_MAX_RETRIES: '12',
        JUPITER_QUOTE_429_INITIAL_BACKOFF_MS: '100',

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
         * 1.11.418 — disabled on live-oscar (premature SPCX exit at −1.85%%).
         * Fractions negative in env (e.g. -0.06 = −6%%). Not a static avg stop.
         */
        PAPER_FLASH_CRASH_KILL_ENABLED: '0',
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
        PAPER_PRIORITY_DISCOVERY_JUPITER_MAX_PER_TICK: '5',
        /** 1.11.251 — near-miss dip: Jupiter refresh если PG dip в (min, min+gap] (minute bucket отстаёт). */
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_REFRESH: '1',
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_GAP_PCT: '4',
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_MAX_PER_TICK: '5',
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
        /** Permanent denylist: ручной seed only; авто-deny после убытка выкл. */
        LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED: '0',
        /** Убыточный выход → 10m cooldown, не denylist. */
        LIVE_NEGATIVE_TRADE_DENY_ENABLED: '0',
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
        /** Единый размер $1000+$500 на все mint; thin-vol probe split выкл. */
        LIVE_MINT_FIRST_PROBE_ENABLED: '0',
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
         * 1.11.520 — Developer 10 RPS: persistent retry x20, base slippage 10 bps, delay 150 ms.
         */
        LIVE_BUY_SIM_RETRY_ATTEMPTS: '20',
        LIVE_BUY_SIM_RETRY_DELAY_MS: '150',
        LIVE_SELL_SIM_RETRY_ATTEMPTS: '20',
        LIVE_SELL_SIM_RETRY_DELAY_MS: '150',
        /** 1.11.458 — hot tick: executable sell quote for open positions every 2s; kill pre-arm + fast tracker trigger. */
        LIVE_OPEN_HOT_TICK_ENABLED: '1',
        LIVE_OPEN_HOT_TICK_INTERVAL_MS: '2000',
        LIVE_OPEN_HOT_EXEC_PRICE_MAX_AGE_MS: '5000',
        LIVE_OPEN_HOT_PROBE_MIN_USD: '20',
        LIVE_OPEN_HOT_PROBE_MAX_USD: '200',
        LIVE_OPEN_HOT_PROBE_FRACTION: '0.10',
        LIVE_OPEN_HOT_INTER_MINT_DELAY_MS: '100',
        LIVE_KILLSTOP_PREARM_BUFFER_PCT: '1',
        LIVE_KILLSTOP_PREARM_TTL_MS: '8000',
        /** 1.11.504 — immediate TG on Jupiter 429 burst/exhaust. */
        JUPITER_429_BURST_TELEGRAM: '1',
        JUPITER_429_BURST_THRESHOLD: '4',
        JUPITER_429_BURST_WINDOW_MS: '60000',
        JUPITER_429_EXHAUST_TELEGRAM: '1',
        TELEGRAM_COOLDOWN_ALERT_JUPITER_429_BURST_MS: '300000',
        TELEGRAM_COOLDOWN_ALERT_JUPITER_429_EXHAUST_MS: '120000',
        /**
         * 1.11.503 — Smart retry classification (A.2), tighter slippage envelope.
         *
         * Внутри общего retry-envelope (15 попыток buy/sell) на slippage-class `sim_err`:
         *   1) slippage-class attempts отдельно от общего счётчика;
         *   2) bump `slippageBps` +10 bps каждый retry, cap 100 bps;
         *   3) buy slippage-cap 8 (10→20→…→100), sell 12 — exits должны пройти.
         */
        LIVE_BUY_SIM_SLIPPAGE_RETRY_ATTEMPTS: '10',
        LIVE_SELL_SIM_SLIPPAGE_RETRY_ATTEMPTS: '15',
        LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS: '10',
        LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS: '100',
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
        LIVE_STAGED_ADD_SIM_ERR_THRESHOLD: '5',
        /** Pro tier: shorter cooldown (was 30m credit-save); still stops infinite sim loops. */
        LIVE_STAGED_ADD_SIM_ERR_COOLDOWN_MS: '600000',
        /**
         * 1.11.231 — после N cooldown-rearm'ов auto-denylist. `0` = выкл (заготовка в коде).
         */
        LIVE_STAGED_ADD_AUTO_DENYLIST_ENABLED: '0',
        LIVE_STAGED_ADD_AUTO_DENYLIST_REARMS_THRESHOLD: '5',
        LIVE_STAGED_ADD_AUTO_DENYLIST_TELEGRAM_ENABLED: '1',

        /**
         * 1.11.503 — adaptive priority fee OFF: фиксированный cap 0.0001 SOL + level high.
         */
        LIVE_ADAPTIVE_PRIORITY_FEE_ENABLED: '0',
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
         * Сейчас: [20..200] @10% — на $1500 позиции probe = $150 (vs $45 раньше).
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
         * Jupiter quote + swap: max execution tolerance (bps). 1.11.503:
         * **10 bps** (0.1%) base + adaptive bump до 100 bps на slippage-class retry.
         */
        LIVE_DEFAULT_SLIPPAGE_BPS: '10',
        LIVE_JUPITER_QUOTE_URL: JUPITER_SWAP_QUOTE_URL,
        LIVE_JUPITER_SWAP_URL: JUPITER_SWAP_BUILD_URL,
        /**
         * Jupiter `/swap/v1/swap`: cap priority fee at **0.0001 SOL** (100_000 lamports) via `priorityLevelWithMaxLamports`.
         * `high` — агрессивный приоритет в рамках cap (1.11.503: veryHigh → high).
         */
        LIVE_JUPITER_PRIORITY_MAX_SOL: '0.0001',
        LIVE_JUPITER_SWAP_PRIORITY_LEVEL: 'high',
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
        /** Fee/rent reserve kept on wallet; spendable SOL = balance − this (0.05 SOL). */
        LIVE_FREE_SOL_BUFFER_LAMPORTS: '50000000',
        /** Partial entry slice when full leg unaffordable; below this USD → hard block (1.11.506). */
        LIVE_PARTIAL_BUY_MIN_USD: '50',
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
        /** `0` — только короткие окна 1ч/4ч (24ч давал ложные block/clear при recovery). */
        LIVE_BTC_BLOCK_24H_DRAWDOWN_PCT: '0',
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
        /** Только kill/trail/TP/breakeven Jupiter sells; heal/tail/flash/timeout blocked. */
        LIVE_POLICY_ONLY_EXITS: '1',
        /** 0 = off. Optional re-buy block after PERIODIC_HEAL journal-only close (ms). */
        LIVE_POLICY_POST_HEAL_CHURN_BLOCK_MS: '0',
      },
    },
    /**
     * Preset C — isolated Live Oscar on SuperBot wallet (HcV3BhmK…).
     * Entry: TG-gated pullback → pending scalp (−5% / −10% / −20% DCA). Exit: preset_c_scalp_v1.
     * Does NOT share discovery path with `live-oscar`.
     */
    {
      name: 'live-oscar-preset-c',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/live-oscar-preset-c.ts',
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
        ...JUPITER_PRO_TRADING_ENV,
        ...PM2_SOLANA_RPC_ENV,
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        NODE_ENV: 'production',
        ...SOLANA_RPC_ALCHEMY_ONLY_ENV,
        PAPER_STRATEGY_KIND: 'dip',
        PAPER_STRATEGY_ID: 'live-oscar-preset-c',
        PAPER_TRADES_PATH: path.join(root, 'data/paper2/_live_oscar_preset_c_unused.jsonl'),
        PAPER_HEARTBEAT_INTERVAL_MS: '30000',
        PAPER_DISCOVERY_INTERVAL_MS: '15000',
        PAPER_TRACK_INTERVAL_MS: '30000',
        PAPER_FOLLOWUP_TICK_MS: '60000',
        PAPER_DRY_RUN: 'false',
        /** Preset C scalp: deferred entry −10% only ($50 single leg), dedicated exit (not wave B). */
        PRESET_C_SCALP_MODE: '1',
        PRESET_C_SCALP_ENTRY_DROP_PCT: '10',
        PRESET_C_SCALP_DCA_DROP_PCT: '10',
        PRESET_C_SCALP_DCA2_DROP_PCT: '20',
        PRESET_C_SCALP_ENTRY_USD: '50',
        PRESET_C_SCALP_DCA_USD: '0',
        PRESET_C_SCALP_DCA2_USD: '0',
        PRESET_C_SCALP_TP2_PCT: '5',
        PRESET_C_SCALP_TP_MID_PCT: '10',
        PRESET_C_SCALP_TP3_PCT: '15',
        PRESET_C_SCALP_KILL_PCT: '50',
        PRESET_C_SCALP_TRAIL_RETRACE_PCT: '2.5',
        PRESET_C_SCALP_TRAIL_SELL_FRAC: '0.5',
        PAPER_POSITION_USD: PRESET_C_ENTRY_USD,
        PAPER_ENTRY_FIRST_LEG_FRACTION: '1',
        PAPER_LIVE_STAGED_ENTRY_ENABLED: '0',
        PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD: '0',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD: '0',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS: '0',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_TARGET_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD: '0',
        PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD: '0',
        /** Legacy wave_b opens (drooling/FARM): third avg leg at −20% / $100. */
        PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT: '20',
        PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD: '100',
        PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT: '50',
        PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS: '0',
        PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS: '1',
        PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED: '0',
        SHYFT_PRICE_PRIMARY_ENABLED: '0',
        SHYFT_DEFI_MCAP_ENABLED: '0',
        PAPER_ENABLE_LAUNCHPAD_LANE: 'false',
        PAPER_ENABLE_MIGRATION_LANE: 'false',
        PAPER_ENABLE_POST_LANE: 'true',
        PAPER_POST_MIN_AGE_MIN: '480',
        PAPER_POST_MAX_AGE_MIN: '0',
        PAPER_POST_MIN_LIQ_USD: '30000',
        PAPER_DISCOVERY_MIN_MARKET_CAP_USD: '3000000',
        PAPER_DISCOVERY_MAX_MARKET_CAP_USD: '300000000',
        /** Phase tiers (micro / low / scalp_wave / prod) — same mcap bands as live-oscar. */
        PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED: '1',
        PAPER_LIVE_OSCAR_MICRO_MCAP_MIN_USD: '3000000',
        PAPER_LIVE_OSCAR_MICRO_MCAP_MAX_USD: '1300000',
        PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD: '50',
        PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD: '50',
        PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD: PRESET_C_ENTRY_USD,
        PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD: PRESET_C_STAGED_LEG_USD,
        PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED: '1',
        PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD: '1300000',
        PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD: '3000000',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD: '50',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD: '50',
        PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD: PRESET_C_ENTRY_USD,
        PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD: PRESET_C_STAGED_LEG_USD,
        PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED: '0',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_AGE_MIN: '720',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_MCAP_USD: '3000000',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD: '30000000',
        PAPER_PRIORITY_DISCOVERY_ENABLED: '0',
        PAPER_VOLUME_LEADER_ENABLED: '0',
        PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B: '0',
        PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION: '0.20',
        PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A: '0',
        PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP: '0',
        PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP_MODE: 'half8_runner',
        PAPER_LIVE_OSCAR_WAVE_B_TIME_STOP_HOURS: '12',
        PAPER_FLASH_CRASH_KILL_ENABLED: '0',
        LIVE_STRATEGY_ENABLED: '1',
        /** Live on-chain buys when telegram gate passes. */
        LIVE_EXECUTION_MODE: 'live',
        LIVE_SIMULATE_BUYS_ONLY: '0',
        LIVE_STRATEGY_PROFILE: 'oscar',
        LIVE_STRATEGY_ID: 'live-oscar-preset-c',
        LIVE_TRADES_PATH: path.join(root, 'data/live/live-oscar-preset-c.jsonl'),
        LIVE_DISCOVERY_AUDIT_JSONL: '1',
        LIVE_DISCOVERY_DEEP_AUDIT_JSONL: '0',
        LIVE_MINT_WHITELIST_ENABLED: '0',
        LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED: '0',
        LIVE_MINT_BLACKLIST_ENABLED: '1',
        LIVE_MINT_BLACKLIST_PATH: path.join(root, 'data/live/live-oscar-preset-c-mint-blacklist.txt'),
        LIVE_MINT_GRADUATED_PATH: path.join(root, 'data/live/live-oscar-preset-c-mint-graduated.txt'),
        LIVE_MINT_WHITELIST_PATH: path.join(root, 'data/live/live-oscar-preset-c-mint-whitelist.txt'),
        LIVE_MINT_PERMANENT_DENYLIST_PATH: path.join(
          root,
          'data/live/live-oscar-preset-c-permanent-denylist.txt',
        ),
        LIVE_MINT_PERMANENT_DENYLIST_SEED_PATH: path.join(
          root,
          'data/live/live-oscar-preset-c-permanent-denylist.seed.txt',
        ),
        LIVE_OPEN_SNAPSHOT_PATH: path.join(root, 'data/live/live-oscar-preset-c-open-snapshot.json'),
        LIVE_DISCOVERY_HEALTH_SNAPSHOT_PATH: path.join(
          root,
          'data/live/live-oscar-preset-c-discovery-health.json',
        ),
        SIGNAL_LAB_ENABLED: '0',
        MTM_SHADOW_ENABLED: '0',
        TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        LIVE_HEARTBEAT_INTERVAL_MS: '1800000',
        LIVE_TELEGRAM_HEARTBEAT: '0',
        LIVE_DAILY_SUMMARY_ENABLED: '0',
        /**
         * SuperBot wallet — one-line base58 in `.keypair.txt` (Phantom export) or CLI JSON in `.keypair.json`.
         * Place on VPS with `chmod 600`; loader auto-detects format and `.txt`/`.json` sibling fallback.
         */
        LIVE_WALLET_SECRET: path.join(root, 'data/live/live-oscar-preset-c.keypair.txt'),
        LIVE_WALLET_PUBKEY: 'HcV3BhmKQN5hhFWiKWoRfzuYM2C6ftPjqQC67wo27DDo',
        LIVE_SIM_ENABLED: '1',
        LIVE_MAX_POSITION_USD: PRESET_C_MAX_POSITION_USD,
        LIVE_MAX_OPEN_POSITIONS: '55',
        LIVE_KILL_AFTER_CONSEC_FAIL: '0',
        LIVE_PHASE5_FREE_SOL_GATE_ENABLED: '0',
        LIVE_BTC_GATE_ENABLED: '1',
        /** Level-2 BTC gate: 1h/4h/24h/72h + drawdown от пика 72h (п.п.; `0` = выкл. для конкретного окна). */
        LIVE_BTC_BLOCK_1H_DRAWDOWN_PCT: '1',
        LIVE_BTC_BLOCK_4H_DRAWDOWN_PCT: '2.5',
        /** `0` — только короткие окна 1ч/4ч (24ч давал ложные block/clear при recovery). */
        LIVE_BTC_BLOCK_24H_DRAWDOWN_PCT: '0',
        /** 72h/peak выкл. — не блокировать buy_open из‑за давней просадки при отскоке на 1h/4h. */
        LIVE_BTC_BLOCK_72H_DRAWDOWN_PCT: '0',
        LIVE_BTC_BLOCK_PEAK_72H_DRAWDOWN_PCT: '0',
        /** ret1h ≥ 0 → только 1h+4h; 24h не режет покупки на отскоке. */
        LIVE_BTC_RECOVERY_SKIP_LONG_WINDOWS: '1',
        LIVE_OPEN_HOT_TICK_ENABLED: '1',
        /** Pro tier: 100 bps base (was 50); adaptive bump to 100 bps cap via JUPITER_PRO_TRADING_ENV. */
        LIVE_DEFAULT_SLIPPAGE_BPS: '100',
        PRESET_C_DISCOVERY_SCAN_MINUTES: '360',
        PRESET_C_DISCOVERY_MIN_HOLDERS: '1000',
        PRESET_C_DISCOVERY_MIN_AGE_HOURS: '8',
        PRESET_C_DISCOVERY_MINT_COOLDOWN_MS: '1800000',
        /** Buy only after dips/retrace channel watcher recorded send in dedupe JSON. */
        PRESET_C_TELEGRAM_GATE_ENABLED: '1',
        PRESET_C_TELEGRAM_GATE_SOURCES: 'pullback,retrace,spike',
        PRESET_C_TELEGRAM_GATE_MAX_AGE_MS: '3600000',
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
     * HyperLiquid TWAP — Telegram signal watch + live/paper execution.
     * Secrets (`HL_TWAP_*` keys, wallet) in `.env` on VPS.
     */
    {
      name: 'hl-twap-telegram-watch',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/hl-twap-telegram-watch.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 100,
      min_uptime: 10_000,
      restart_delay: 5000,
      max_memory_restart: '512M',
      kill_timeout: 15_000,
      merge_logs: true,
      time: true,
      env: {
        ...HL_TWAP_LIVE_ENV,
      },
    },
    /**
     * HyperLiquid Oscar dip-buy perp bot — PAPER by default (HL_OSCAR_LIVE_ENABLED=0).
     * Same HL wallet/API as hl-twap via `.env` (HL_TWAP_* fallback).
     */
    {
      name: 'hl-oscar-perp-watch',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/hl-oscar-perp-watch.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 100,
      min_uptime: 10_000,
      restart_delay: 5000,
      max_memory_restart: '512M',
      kill_timeout: 15_000,
      merge_logs: true,
      time: true,
      env: {
        ...HL_OSCAR_PERP_ENV,
      },
    },
    /**
     * HyperLiquid Oscar Majors — BTC+ETH knife Mode A (paper default).
     * Enable live: HL_MAJORS_LIVE_ENABLED=1 + HL_MAJORS_DRY_RUN=0 in `.env`.
     */
    {
      name: 'hl-oscar-majors-watch',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/hl-oscar-majors-watch.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 100,
      min_uptime: 10_000,
      restart_delay: 5000,
      max_memory_restart: '512M',
      kill_timeout: 15_000,
      merge_logs: true,
      time: true,
      env: {
        ...HL_MAJORS_ENV,
      },
    },
    /**
     * Unified watchdog: hl-twap, live-oscar, copy-trader.
     * PM2 status + heartbeat.json every 30s → auto-restart + [ALERT][strategy_watch].
     */
    {
      name: 'strategy-process-watch',
      cwd: root,
      script: 'scripts-tmp/strategy-process-watch.mjs',
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
        TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        STRATEGY_PROCESS_WATCH_POLL_MS: '30000',
        STRATEGY_PROCESS_WATCH_AUTO_RESTART: '1',
        STRATEGY_PROCESS_WATCH_TELEGRAM: '1',
        STRATEGY_PROCESS_WATCH_ALERT_REPEAT_MIN: '15',
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
        ...JUPITER_PRO_TRADING_ENV,
        ...PM2_SOLANA_RPC_ENV,
        NODE_ENV: 'production',
        COPY_TRADER_STRICT_ISOLATION: '1',
        /** Исполнение: бывший live-oscar-risky (Phantom base58 или JSON в этом файле на VPS). */
        COPY_TRADER_WALLET_SECRET: path.join(root, 'data/live/live-oscar-risky.keypair.json'),
        COPY_TRADER_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        COPY_TRADER_USE_RISKY_WALLET: '1',
        /** Лидер: адрес в файле (не execution wallet). */
        COPY_TRADER_TARGET_WALLET_PATH: path.join(root, 'data/copytrader/target-wallet.txt'),
        COPY_TRADER_EXECUTION_MODE: 'live',
        COPY_TRADER_POSITION_USD: '1000',
        /** 0 = unlimited (proportional adds/sells only; no cap rows in state). */
        COPY_TRADER_MAX_POSITION_USD: '0',
        COPY_TRADER_MAX_ADDS_PER_MINT: '0',
        COPY_TRADER_MAX_OPEN_POSITIONS: '0',
        COPY_TRADER_MIN_PROPORTIONAL_ADD_USD: '0',
        COPY_TRADER_BUY_DELAY_MS: '30000',
        COPY_TRADER_ENTRY_PROBE_BUY_DELAY_MS: '0',
        COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT: '3',
        /** Split entry: $500 probe (50%) + $500 dip @ leader−10%. */
        COPY_TRADER_ENTRY_PROBE_FRACTION: '0.5',
        COPY_TRADER_ENTRY_DIP_DISCOUNT_PCT: '10',
        COPY_TRADER_ENTRY_DIP_CONFIRM_TICKS: '2',
        COPY_TRADER_ENTRY_DIP_VS_PROBE_PCT: '0',
        COPY_TRADER_ENTRY_MIN_DEPLOY_FRACTION: '0.99',
        COPY_TRADER_ADD_PRICE_MAX_PREMIUM_PCT: '0',
        COPY_TRADER_ALLOW_LATE_ENTRY_ON_LEADER_REBUY: '1',
        /** Mcap $500k–$1M: $300+$300; ≥$1M: $500+$500 (unchanged). */
        COPY_TRADER_MIN_MCAP_USD: '500000',
        COPY_TRADER_ENTRY_FULL_MCAP_USD: '1000000',
        COPY_TRADER_ENTRY_MID_POSITION_USD: '600',
        COPY_TRADER_ENTRY_MID_LEG_USD: '300',
        COPY_TRADER_BUY_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_BUY_RETRY_DEFER_LOG_MS: '60000',
        /** Slippage-class sell: retry same bps every 6s up to 2h (no wait for next leader sell). */
        COPY_TRADER_SELL_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_SELL_RETRY_INTERVAL_MS: '3000',
        COPY_TRADER_SELL_RETRY_DEFER_LOG_MS: '30000',
        /** Pro tier: minimal Jupiter throttling (was 2s / 12s credit-save). */
        COPY_TRADER_MIN_SELL_INTERVAL_MS: '500',
        COPY_TRADER_ENTRY_DIP_JUPITER_MIN_INTERVAL_MS: '2000',
        COPY_TRADER_MIN_PROPORTIONAL_SELL_FRACTION: '0',
        /** Exit soon after leader sell (was 20–30s anti-panic; now match manual jup.ag speed). */
        COPY_TRADER_SELL_DELAY_MIN_MS: '0',
        COPY_TRADER_SELL_DELAY_MAX_MS: '2000',
        COPY_TRADER_POLL_INTERVAL_MS: '12000',
        /** Pro tier: 100 bps base slippage (was 400 free-tier). Sell retry envelope via JUPITER_PRO_TRADING_ENV. */
        COPY_TRADER_SLIPPAGE_BPS: '100',
        COPY_TRADER_JOURNAL_PATH: path.join(root, 'data/copytrader/journal.jsonl'),
        COPY_TRADER_STATE_PATH: path.join(root, 'data/copytrader/state.json'),
        COPY_TRADER_TELEGRAM_ENABLED: '0',
        /** Poll + parse leader txs: Alchemy (`COPY_TRADER_RPC_URL` или `SA_RPC_HTTP_URL` в `.env`). QN/Helius — резерв, fallback off. */
        ...SOLANA_RPC_ALCHEMY_ONLY_ENV,
      },
    },
    /**
     * Hourly Alchemy RPC usage → Telegram (internal meter; no public Alchemy billing API on free tier).
     */
    {
      name: 'sa-alchemy-usage-watch',
      cwd: root,
      script: 'scripts-tmp/alchemy-usage-hourly-telegram.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10_000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        ...PM2_SOLANA_RPC_ENV,
        ALCHEMY_USAGE_TELEGRAM: '1',
        ALCHEMY_USAGE_INTERVAL_MS: '3600000',
        ALCHEMY_EST_CU_PER_RPC: '27',
        TELEGRAM_COOLDOWN_REPORT_ALCHEMY_USAGE_MS: '3600000',
      },
    },
];

module.exports = {
  apps: PM2_APPS,
};
