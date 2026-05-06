/** VPS `/opt/solana-alpha`: Живой Оскар + дашборд + сборщики снимков (PM2 читает этот файл). */
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'live-oscar-dashboard',
      cwd: root,
      script: 'npm',
      args: 'run --silent dashboard',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      merge_logs: true,
      time: true,
      env: {
        HOST: '0.0.0.0',
        PORT: '3008',
        /** Должен совпадать с `isOrganizerPaperStorePath` в dashboard-server (имя `organizer-paper.jsonl`). */
        STORE_PATH: path.join(root, 'data/paper2/organizer-paper.jsonl'),
        PAPER2_DIR: path.join(root, 'data/paper2'),
        DASHBOARD_LIVE_OSCAR_JSONL: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        /** Только колонка Live Oscar на `/papertrader2` (без пустых pt1-плиток). */
        DASHBOARD_PAPER2_LIVE_OSCAR_ONLY: '1',
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
      max_memory_restart: '300M',
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
      max_memory_restart: '300M',
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
      max_memory_restart: '300M',
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
      max_memory_restart: '300M',
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
      max_memory_restart: '300M',
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
        NODE_ENV: 'production',
        JUPITER_WATCHER_ENQUEUE_RPC: '0',
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
      max_memory_restart: '300M',
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
      script: 'npm',
      args: 'run --silent live-oscar',
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
        NODE_ENV: 'production',
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
        /** Live §3.3: должно совпадать с `LIVE_MAX_POSITION_USD`. Первая нога **$55**, вторая **$25** → **$80**. */
        PAPER_POSITION_USD: '80',
        /** 55/80 — первая нога $55; вторая $25 через scale-in (`LIVE_ENTRY_SCALE_IN_*`). */
        PAPER_ENTRY_FIRST_LEG_FRACTION: '0.6875',
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
        /** Пост-lane: мин. возраст пула в снимке 48 ч / 2 дня (паритет всех prod стратегий); верхняя граница не задана. */
        PAPER_POST_MIN_AGE_MIN: '2880',
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
        PAPER_DIP_COOLDOWN_MIN: '30',
        PAPER_DIP_COOLDOWN_MIN_SCALP: '20',
        /** 0 = без паузы после убыточного выхода по mint. */
        PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS: '0',

        PAPER_DIP_RECOVERY_VETO_ENABLED: '1',
        PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN: '30,60',
        PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT: '12',

        /** Live: без tp-regime классов на входе; режимы A/B по IDEALIZED_OSCAR_STACK_SPEC §8.2–§9.2. */
        PAPER_TP_REGIME_ENABLED: '0',
        /** Режим A/B вкл.: A до первого DCA (включая после scale-in второй ноги); B только после DCA — ужесточённая сетка TP + env ниже. */
        PAPER_LIVE_EXIT_MODE_AB: '1',
        PAPER_LIVE_EXIT_MODE_B_TRAIL_DROP: '0.12',
        PAPER_LIVE_EXIT_MODE_B_TRAIL_TRIGGER_X: '1.06',
        PAPER_LIVE_EXIT_MODE_B_TIMEOUT_HOURS: '4',
        PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP: '-0.07',
        /**
         * Режим B — «после боли» (IDEALIZED §9.2): та же ступень +5% к средней, но продаём большую долю остатка
         * за ступень и ограничиваем число ступеней — быстрее выйти в зелёный/около нуля.
         */
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_STEP_PNL: '0.05',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_SELL_FRACTION: '0.50',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.02',
        PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS: '4',

        /** Live Oscar: без DCA между ногами — только $20 + отложенные $10 по коридору Jupiter. */
        PAPER_DCA_LEVELS: '',
        /** Режим A: kill-stop до второй ноги (см. также режим B −7%). */
        PAPER_DCA_KILLSTOP: '-0.05',
        /**
         * Режим A — «полная лестница» (IDEALIZED §9.2): +5% к средней; 15% остатка за ступень;
         * retrace-защита после 1-й ступени 2.5%.
         */
        PAPER_TP_LADDER: '',
        PAPER_TP_GRID_STEP_PNL: '0.05',
        PAPER_TP_GRID_SELL_FRACTION: '0.15',
        PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL: '0.025',
        PAPER_TP_X: '100',
        PAPER_SL_X: '0',
        PAPER_TRAIL_MODE: 'ladder_retrace',
        PAPER_TRAIL_DROP: '0.10',
        PAPER_TRAIL_TRIGGER_X: '1.10',
        /** Live Oscar — тайм-аут позиции 8 ч. */
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

        PAPER_HOLDERS_LIVE_ENABLED: '1',
        PAPER_HOLDERS_USE_QN_ADDON: '0',
        PAPER_HOLDERS_TTL_MS: '90000',
        PAPER_HOLDERS_NEG_TTL_MS: '15000',
        PAPER_HOLDERS_MAX_PER_TICK: '10',
        PAPER_HOLDERS_TIMEOUT_MS: '4000',
        PAPER_HOLDERS_INCLUDE_TOKEN2022: '1',
        PAPER_HOLDERS_ON_FAIL: 'db_fallback',
        PAPER_HOLDERS_DB_WRITEBACK: '1',
        /** Прогрев `tokens.holder_count` для до N кандидатов с нулём в SQL до основного eval (см. dip-clones). */
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
        PAPER_PRICE_VERIFY_EXIT_ENABLED: '1',
        PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL: '1',
        /** После N defer pre-exit Jupiter verify по TIMEOUT — один проход без block_on_fail (см. live_exit_verify_defer). */
        PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION: '60',

        PAPER_SIM_AUDIT_ENABLED: '1',
        PAPER_SIM_SAMPLE_PCT: '5',
        PAPER_SIM_MAX_WALL_MS: '8000',
        PAPER_SIM_BUILD_TIMEOUT_MS: '5000',
        PAPER_SIM_USE_JUPITER_BUILD: '1',
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

        /** W8.0 §9 rollout — шаг 3: `live` + микролимиты §3.3 (sendTransaction + confirm); см. RUNBOOK §0.2 и [`W8.0_live_oscar_trading_bot.md`](docs/strategy/specs/W8.0_live_oscar_trading_bot.md) §9. */
        LIVE_STRATEGY_ENABLED: '1',
        LIVE_EXECUTION_MODE: 'live',
        LIVE_STRATEGY_PROFILE: 'oscar',
        LIVE_STRATEGY_ID: 'live-oscar',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        LIVE_HEARTBEAT_INTERVAL_MS: '60000',
        /** Файл keypair торгового кошелька на VPS (`chmod 600`). После замены файла задайте LIVE_WALLET_PUBKEY (совпадает с проверкой в коде). */
        LIVE_WALLET_SECRET: path.join(root, 'data/live/live-oscar-micro.keypair.json'),
        LIVE_WALLET_PUBKEY: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
        LIVE_SIM_ENABLED: '1',
        LIVE_SIM_TIMEOUT_MS: '12000',
        LIVE_SIM_CREDITS_PER_CALL: '30',
        /** W8.0 §10 — max Jupiter quote age (ms) before sign/send; `0` = disable (see `loadLiveOscarConfig`). */
        LIVE_QUOTE_MAX_AGE_MS: '8000',
        /**
         * Telegram ALERT при сбое Jupiter-probe в трекере или расхождении PG vs Jupiter; см. `src/core/telegram/jupiter-alerts.ts`.
         * `0` = выкл. Circuit breaker (price-verify): `JUPITER_QUOTE_CIRCUIT_TELEGRAM=0`.
         * Троттлинг per-mint: `LIVE_JUPITER_TRACKER_TG_THROTTLE_MS` (default 300000).
         */
        LIVE_JUPITER_TRACKER_TELEGRAM: '1',
        /** Jupiter quote + swap: max execution tolerances (bps). */
        LIVE_DEFAULT_SLIPPAGE_BPS: '300',
        /**
         * Jupiter `/swap/v1/swap`: cap priority fee at **0.0001 SOL** (100_000 lamports) via `priorityLevelWithMaxLamports`.
         * Optional override: `LIVE_JUPITER_SWAP_PRIORITY_LEVEL` = medium | high | veryHigh (default medium).
         */
        LIVE_JUPITER_PRIORITY_MAX_SOL: '0.0001',
        /** Полный нотионал (= `PAPER_POSITION_USD`); SOL на swap — из Jupiter quote по USD-нотации ноги. */
        LIVE_MAX_POSITION_USD: '80',
        LIVE_MAX_OPEN_POSITIONS: '5',
        /**
         * Phase 5: гейт «свободный SOL ≥ k·X» + capital_skip / CAPITAL_ROTATE — выкл.
         * (Оценка free SOL через getBalance расходилась с реальностью; swap и так использует кошелёк.)
         * Включить прежнее W8.0-p5: LIVE_PHASE5_FREE_SOL_GATE_ENABLED=1 (опц. LIVE_CAPITAL_ROTATE_ENABLED=1).
         */
        LIVE_PHASE5_FREE_SOL_GATE_ENABLED: '0',
        LIVE_KILL_AFTER_CONSEC_FAIL: '3',
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
        LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD: '22',
        /** После `live_position_close`: через N мс дожать остаток mint на кошельке (`sell_full`). 0 = выкл. */
        LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS: '60000',

        /** Двухногий вход: вторая доля после задержки, если Jupiter в коридоре к цене первой ноги (`src/live/entry-scale-in.ts`). */
        LIVE_ENTRY_SCALE_IN_ENABLED: '1',
        /** 5 с — успевает сработать частичный TP по сетке до второй ноги (трекер оценивает TP раньше scale-in). */
        LIVE_ENTRY_SCALE_IN_DELAY_MS: '5000',
        /** Коридор второй ноги к якорю первой ноги (USD/token): до +5% / до −7% (меньше перекоса «вниз = жирная позиция» vs узкий +1/−2). */
        LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT: '5',
        LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT: '7',
        LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS: '5',
        LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS: '2000',

        /** Периодический хвост на кошельке + force-close зависших open (`src/live/periodic-self-heal.ts`). */
        LIVE_PERIODIC_SELF_HEAL_MS: '1800000',
        LIVE_PERIODIC_SWEEP_MIN_USD: '0.25',
        LIVE_PERIODIC_STUCK_GRACE_HOURS: '0.5',
        /** `1` = продавать любые SPL не в open выше min USD (осторожно: скам-airdrops). */
        LIVE_PERIODIC_SWEEP_UNKNOWN_CHAIN_ONLY: '0',
      },
    },
  ],
};
