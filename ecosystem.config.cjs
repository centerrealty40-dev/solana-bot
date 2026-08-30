/** VPS `/opt/solana-alpha`: Живой Оскар + дашборд + сборщики снимков (PM2 читает этот файл). */
const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });
/** Проброс в `env` каждого PM2-приложения, чтобы ключ был в `process.env` даже если дочерний процесс не подхватил `.env` так, как ожидается. */
const JUPITER_API_KEY_PM2 = (process.env.JUPITER_API_KEY || '').trim();
const PM2_JUPITER_KEY_ENV = JUPITER_API_KEY_PM2 ? { JUPITER_API_KEY: JUPITER_API_KEY_PM2 } : {};
const BIRDEYE_API_KEY_PM2 = (process.env.BIRDEYE_API_KEY || '').trim();
const PM2_BIRDEYE_KEY_ENV = BIRDEYE_API_KEY_PM2 ? { BIRDEYE_API_KEY: BIRDEYE_API_KEY_PM2 } : {};
/** Alchemy (или иной primary) из `.env` — ключ не в git; перекрывает stale PM2 QN URL при reload. */
const SA_RPC_HTTP_URL_PM2 = (process.env.SA_RPC_HTTP_URL || '').trim();
const LIVE_RPC_HTTP_URL_PM2 = (process.env.LIVE_RPC_HTTP_URL || SA_RPC_HTTP_URL_PM2).trim();
const COPY_TRADER_RPC_URL_PM2 = (process.env.COPY_TRADER_RPC_URL || SA_RPC_HTTP_URL_PM2).trim();
const HELIUS_API_KEY_PM2 = (process.env.HELIUS_API_KEY || '').trim();
const HELIUS_RPC_URL_PM2 = (
  process.env.HELIUS_RPC_URL ||
  (HELIUS_API_KEY_PM2 ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_PM2}` : '')
).trim();
const PM2_SOLANA_RPC_ENV = SA_RPC_HTTP_URL_PM2
  ? {
      SA_RPC_HTTP_URL: SA_RPC_HTTP_URL_PM2,
      LIVE_RPC_HTTP_URL: LIVE_RPC_HTTP_URL_PM2,
      COPY_TRADER_RPC_URL: COPY_TRADER_RPC_URL_PM2,
      SOLANA_RPC_HTTP_URL: SA_RPC_HTTP_URL_PM2,
      ALCHEMY_HTTP_URL: SA_RPC_HTTP_URL_PM2,
    }
  : {};
/** Live Oscar trading RPC — Helius (Alchemy monthly cap). Overrides PM2_SOLANA_RPC_ENV Alchemy URLs. */
const LIVE_OSCAR_HELIUS_RPC_ENV = HELIUS_RPC_URL_PM2
  ? {
      HELIUS_RPC_URL: HELIUS_RPC_URL_PM2,
      ...(HELIUS_API_KEY_PM2 ? { HELIUS_API_KEY: HELIUS_API_KEY_PM2 } : {}),
      SOLANA_RPC_HELIUS_PREFER: '1',
      SOLANA_RPC_HELIUS_FALLBACK_ENABLED: '0',
      LIVE_RPC_HTTP_URL: HELIUS_RPC_URL_PM2,
      SA_RPC_HTTP_URL: HELIUS_RPC_URL_PM2,
      SOLANA_RPC_HTTP_URL: HELIUS_RPC_URL_PM2,
    }
  : {
      SOLANA_RPC_HELIUS_PREFER: '1',
      SOLANA_RPC_HELIUS_FALLBACK_ENABLED: '1',
    };
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
/** sa-jupiter: 2 workers × 600 ms ≈ 3.3 RPS (global gate caps total ~8 RPS for all PM2 apps). */
const JUPITER_WATCHER_REQUEST_DELAY_MS = '600';
const JUPITER_WATCHER_QUOTE_CONCURRENCY = '2';
const JUPITER_SWAP_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_BUILD_URL = 'https://api.jup.ag/swap/v1/swap';
/**
 * Shared Jupiter execution envelope — Developer 10 RPS, ~10 concurrent positions.
 * HTTP: 1 quote + 1 swap per attempt; 429 → global pause, tracker retries next tick.
 */
const JUPITER_PRO_TRADING_ENV = {
  ...JUPITER_DEVELOPER_TIER_ENV,
  /** Cross-process gate: 8 RPS cap (headroom under Developer 10 RPS org limit). */
  JUPITER_GLOBAL_MAX_RPS: '8',
  JUPITER_GLOBAL_GATE_PATH: path.join(root, 'data/jupiter-api-gate.json'),
  /** HTTP-layer: max 1 retry on 429; sim/tracker handles next attempt. */
  JUPITER_QUOTE_429_MAX_RETRIES: '1',
  JUPITER_SWAP_429_MAX_RETRIES: '1',
  JUPITER_QUOTE_429_INITIAL_BACKOFF_MS: '1000',
  LIVE_JUPITER_QUOTE_URL: JUPITER_SWAP_QUOTE_URL,
  LIVE_JUPITER_SWAP_URL: JUPITER_SWAP_BUILD_URL,
  LIVE_JUPITER_PRIORITY_MAX_SOL: '0.0001',
  LIVE_JUPITER_SWAP_PRIORITY_LEVEL: 'high',
  LIVE_BUY_SIM_RETRY_ATTEMPTS: '2',
  LIVE_BUY_SIM_RETRY_DELAY_MS: '800',
  LIVE_SELL_SIM_RETRY_ATTEMPTS: '2',
  LIVE_SELL_SIM_RETRY_DELAY_MS: '1000',
  LIVE_BUY_SIM_SLIPPAGE_RETRY_ATTEMPTS: '2',
  LIVE_SELL_SIM_SLIPPAGE_RETRY_ATTEMPTS: '2',
  LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS: '10',
  LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS: '100',
  PAPER_PRICE_VERIFY_QUOTE_RETRIES_ENABLED: '0',
};

/**
 * Birdeye REST market-data (Lite+). Key only in VPS `.env` — BIRDEYE_API_KEY (never commit).
 * BIRDEYE_PRIMARY_ENABLED — discovery eval + MTM baseline (Birdeye → DexScreener → PG).
 * BIRDEYE_COLLECTOR_ENABLED — enrich open/pin mints in DEX collectors before DexScreener fallback.
 * BIRDEYE_USE_BATCH — try Business-tier `market-data/multiple`; Lite=0 falls back to per-mint.
 * BIRDEYE_TELEGRAM_ENABLED — ALERT on tier limit (429/CU) and coverage gaps.
 */
const BIRDEYE_REST_ENV = {
  BIRDEYE_COLLECTOR_ENABLED: '1',
  BIRDEYE_USE_BATCH: '0',
  BIRDEYE_TELEGRAM_ENABLED: '1',
  BIRDEYE_MARKET_TTL_MS: '12000',
  BIRDEYE_MAX_STALE_MS: '15000',
  BIRDEYE_COVERAGE_GAP_MIN_MS: '300000',
  BIRDEYE_COLLECTOR_MAX_MINTS_PER_TICK: '12',
  BIRDEYE_COLLECTOR_INTER_MINT_DELAY_MS: '120',
};

/** DexScreener-only collector enrich (Birdeye OFF on collectors — Lera parity 2026-07). */
const BIRDEYE_COLLECTOR_ENV = {
  BIRDEYE_COLLECTOR_ENABLED: '0',
  BIRDEYE_GLOBAL_RATE_LIMIT: '0',
  ...PM2_BIRDEYE_KEY_ENV,
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
  /** Alt perp live opens enabled (HL_OSCAR_LIVE_ENABLED=1). */
  HL_OSCAR_LIVE_ENABLED: '1',
  HL_OSCAR_DRY_RUN: '0',
  HL_OSCAR_LEVERAGE: '2',
  HL_OSCAR_MARGIN_USD: '50',
  HL_OSCAR_NOTIONAL_USD: '100',
  HL_OSCAR_POSITION_NOTIONAL_USD: '100',
  /** Staged 30/30/40 DCA ($100 gross @ 2x). Set 0 for single-shot on signal. */
  HL_OSCAR_STAGED_ENTRY: '1',
  /** Rethink study D_dip_12: deep dip −12%, impulse ≥8%, recovery veto on. */
  HL_OSCAR_DIP_MIN_PCT: '-12',
  HL_OSCAR_DIP_MAX_PCT: '-50',
  HL_OSCAR_DIP_WINDOWS_MIN: '120,360,720',
  HL_OSCAR_DIP_COOLDOWN_MIN: '30',
  HL_OSCAR_LEG2_DROP_PCT: '5',
  HL_OSCAR_LEG3_DROP_PCT: '10',
  HL_OSCAR_DIP_MIN_IMPULSE_PCT: '8',
  /** Recovery veto — skip bounce ≥12% from 30/60m low (Solana Oscar parity). */
  HL_OSCAR_RECOVERY_VETO_ENABLED: '1',
  HL_OSCAR_RECOVERY_VETO_WINDOWS_MIN: '30,60',
  HL_OSCAR_RECOVERY_VETO_MAX_BOUNCE_PCT: '12',
  /** Local-high veto — off by default (study: −76% signal rate on HL alts). */
  HL_OSCAR_LOCAL_HIGH_VETO_ENABLED: '0',
  HL_OSCAR_LOCAL_HIGH_VETO_WINDOWS_MIN: '30,60,120',
  HL_OSCAR_LOCAL_HIGH_VETO_MAX_DISTANCE_PCT: '2',
  /** TP ladder +5/+7.5/+10%, trail arm +8%, step −2.5%. */
  HL_OSCAR_TP_RUNGS: '0.05,0.075,0.1',
  HL_OSCAR_TRAIL_ARM_PCT: '8',
  HL_OSCAR_TRAIL_STEP_PCT: '2.5',
  HL_OSCAR_TIME_STOP_ENABLED: '1',
  HL_OSCAR_TIME_STOP_HOURS: '12',
  HL_OSCAR_REMAINDER_CLOSE_PCT: '10',
  HL_OSCAR_MAX_OPEN_POSITIONS: '4',
  HL_OSCAR_MARGIN_RESERVE_USD: '25',
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
/** HL Oscar Majors (BTC+ETH knife Mode A) — live on `hl-oscar-majors-watch`. */
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
  HL_MAJORS_MARGIN_RESERVE_USD: '25',
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
  /** Mode B scalp — paper 14d: scalp dry-run, knife stays live */
  HL_MAJORS_MODE: 'both',
  HL_MAJORS_SCALP_ENABLED: '1',
  HL_MAJORS_SCALP_LIVE_ENABLED: '1',
  HL_MAJORS_SCALP_DRY_RUN: '0',
  HL_MAJORS_SCALP_DIP_PCT: '-2',
  HL_MAJORS_SCALP_WINDOW_MIN: '120',
  HL_MAJORS_SCALP_TP_RUNGS: '0.0075,0.015',
  HL_MAJORS_SCALP_SL_PCT: '2.5',
  HL_MAJORS_SCALP_TIME_STOP_MIN: '480',
  HL_MAJORS_SCALP_COOLDOWN_MIN: '30',
  HL_MAJORS_SCALP_RANGE_FILTER: '1',
  HL_MAJORS_SCALP_RANGE_MAX_PCT: '0.40',
  HL_MAJORS_SCALP_MARGIN_USD: '25',
  HL_MAJORS_SCALP_LEVERAGE: '2',
  HL_MAJORS_SCALP_MAX_OPEN: '2',
  HL_MAJORS_SCALP_TP_SELL_FRAC: '0.5',
  HL_MAJORS_SCALP_TRAIL_ARM_PCT: '0.8',
  HL_MAJORS_SCALP_TRAIL_STEP_PCT: '0.4',
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
 * 1.11.538 — prod ≥$3M: 8×$300 entry split; avg −10% $300, −20% $400 (all prod incl. ≥$12M); low 5×$300 + avg $300/$400; max $3100 / low $2200.
 * 1.11.539 — prod ≥$3M: 5×$1000 entry split @10s (+3/−5% corridor); avg −10% $300, −20% $400; max $5700 / low unchanged.
 * 1.11.552 — proportional DCA scale (backtest v2): prod avg −10% $1500, −20% $2000; max $8500; low avg $450/$600; max $2550.
 * 1.11.553 — low $2M–$3M: 3×$1000 @ 10s (+3/−5% corridor), avg −10% $1000 + −20% $1500 (max $5500); prod unchanged.
 * 1.11.554 — prod ≥$3M: 4×$1000 entry split @10s (+3/−5% corridor); avg −10% $1500, −20% $2000; max $7500.
 * 1.11.555 — prod ≥$3M: 3×$1000 entry split @10s (+3/−5% corridor); avg −10% $1000, −20% $1000; max $5000.
 * 1.11.555 — low $2M–$3M: 2×$1000 @ 10s (+3/−5% corridor), avg −10% $500 + −20% $500 (max $3000); prod unchanged below.
 * 1.11.568 — prod avg @ −10%: 3×$500 slices; −20% avg OFF; −10% = 50% entry-split; LOW lane ON 2×$500.
 * 1.11.567 — avg @ −10% = 50% of tier entry-split total (all strategies); prod max $4500; Lera max $750.
 * 1.11.566 — prod+low+micro: avg −10% only; −20% second avg leg OFF all tiers; max prod $3500, low $1500.
 * 1.11.563 — prod from $2M (low/micro OFF): 6×$500 entry split @10s (+3/−5% corridor); avg −10% $500, −20% $1000; max $4500; no DCA/scale-in.
 * 1.11.585 — prod: 8×$500 entry split ($4000); avg −10% = 50% entry ($2000 as 4×$500); max $6000.
 * 1.11.604 — prod: 8×$300 entry split ($2400); avg −10% $300 (fixed); max $2700; trend+recovery veto OFF.
 * 1.11.506 — partial entry slice when wallet SOL short (reserve 0.05 SOL, min partial $50).
 * 1.11.500 — min mcap $2M; micro/scalp_wave OFF; low $2M–$3M: 2×$250 @ 10s (+3/−5% corridor), avg −10% $250; prod ≥$3M: 3×$400 @ 10s, avg −5%/$300 + −20%/$300.
 */
const LIVE_OSCAR_ENTRY_SPLIT_USD = '2400';
const LIVE_OSCAR_MAX_POSITION_USD = '2700';

/** 1.11.281 — discovery SQL + priority mints → DexScreener enrich (не trading whitelist). */
const DISCOVERY_COLLECTOR_PIN_PATH = path.join(root, 'data/live/discovery-collector-pin-mints.txt');
const DISCOVERY_COLLECTOR_PIN_ENV = {
  PAPER2_SNAPSHOT_DISCOVERY_PIN: '1',
  PAPER2_SNAPSHOT_DISCOVERY_PIN_PATH: DISCOVERY_COLLECTOR_PIN_PATH,
  PAPER2_SNAPSHOT_DISCOVERY_PIN_MAX: '200',
};

/**
 * Shared DexScreener quota (one VPS egress IP).
 * 1.11.686 — Oscar trading = mild-dip only; collectors excluded so the full
 * 120 RPM budget belongs to mild-dip mark/enrich (hard cap in gate code).
 */
const DEXSCREENER_GATE_ENV = {
  DEXSCREENER_GLOBAL_RATE_LIMIT: '1',
  /**
   * 60 RPM (minGap=1000ms): leave headroom for transient provider throttling.
   * History: 42 RPM (code default without this env) starved marks behind copy-trader.
   */
  DEXSCREENER_GLOBAL_MAX_RPM: '60',
  DEXSCREENER_GLOBAL_GATE_PATH: path.join(root, 'data/dexscreener-api-gate.json'),
};

/** Cross-process Dex `/tokens/{mint}` quote cache — live-oscar + collectors on Oscar VPS. */
const DEX_QUOTE_CACHE_ENV = {
  DEX_QUOTE_CACHE_ENABLED: '1',
  DEX_QUOTE_CACHE_TTL_MS: '20000',
  DEX_QUOTE_CACHE_PATH: path.join(root, 'data/dexscreener-quote-cache.json'),
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
        DASHBOARD_COPY_TRADER_LEADER_WALLET: '498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma',
        /** SuperBot / live-oscar-preset-c journal (HcV3BhmK wallet, отдельный PM2). */
        DASHBOARD_SUPERBOT_JSONL: path.join(root, 'data/live/live-oscar-preset-c.jsonl'),
        /** Вторая плитка «Wallet» в шапке `/papertrader2` — баланс copy-trader (бывший risky). */
        DASHBOARD_COPY_TRADER_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        DASHBOARD_LIVE_OSCAR_RISKY_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        /** DCA Trader Risky (dc-trader) — tile 3 on `/papertrader2`. */
        DASHBOARD_DC_TRADER_JSONL: '/opt/dc-trader/data/trader-journal.jsonl',
        DASHBOARD_DC_TRADER_STATE_PATH: '/opt/dc-trader/data/trader-state.json',
        DASHBOARD_DC_TRADER_WALLET_PUBKEY: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
        /** LERA (cross-product tile) — journal synced from 72.62.152.201 or remote API. */
        DASHBOARD_LERA_JSONL: path.join(root, 'data/lera/pt1-lera-live.jsonl'),
        DASHBOARD_LERA_API_URL: 'http://72.62.152.201:3009/api/paper2',
        /** Wallet tiles: Alchemy via `.env` `SA_RPC_HTTP_URL` (Helius/QN fallback off). */
        LIVE_WALLET_PUBKEY: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
        ...SOLANA_RPC_ALCHEMY_ONLY_ENV,
        DASHBOARD_PAPER_OSCAR_V21_JSONL: path.join(root, 'data/paper2/paper-oscar-v21.jsonl'),
        DASHBOARD_PAPER_OSCAR_V22_JSONL: path.join(root, 'data/paper2/paper-oscar-v22.jsonl'),
        DASHBOARD_PAPER_OSCAR_RISKY_JSONL: path.join(root, 'data/paper2/paper-oscar-risky.jsonl'),
        /** Dashboard JSONL tail — UI reads last N bytes only (full journal kept for bot/backtest). */
        DASHBOARD_JSONL_TAIL_BYTES: String(64 * 1024 * 1024),
        DASHBOARD_LIVE_OSCAR_TAIL_BYTES: String(64 * 1024 * 1024),
        DASHBOARD_RECENT_CLOSED_LIMIT: '20',
        DASHBOARD_PAPER2_CACHE_MS: '90000',
        DASHBOARD_PAPER2_OPENS_CACHE_MS: '30000',
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
    /**
     * DEX snapshot collectors — tick cadence (LERA prod policy 2026-07):
     * - sa-pumpswap: 60s (primary lane — fastest cadence; do not go below 60s without 429 review)
     * - sa-raydium / sa-meteora / sa-moonshot: 120s (2 min — DexScreener budget + staggered START_OFFSET_MS)
     * Stagger offsets spread DexScreener search bursts across the minute grid.
     * Enrich: open/live/pin mints via paper2-open-snapshot-enrich (stream-read + 30s cache; caps below).
     */
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
        RAYDIUM_COLLECTOR_INTERVAL_MS: '120000',
        RAYDIUM_COLLECTOR_START_OFFSET_MS: '0',
        RAYDIUM_COLLECTOR_ENRICH_MAX_RETRIES: '1',
        /** Override VPS `.env` PAPER2_SNAPSHOT_OPENS=0 — LERA parity: enrich ON (stream-read + caps). */
        PAPER2_SNAPSHOT_OPENS: '1',
        PAPER2_SNAPSHOT_DS_DELAY_MS: '500',
        PAPER2_SNAPSHOT_SOLO_FETCH_MAX_PER_TICK: '6',
        PAPER2_SNAPSHOT_LIVE_SOLO_FETCH_MAX_PER_TICK: '4',
        PAPER2_SNAPSHOT_BATCH_CHUNKS_MAX_PER_TICK: '8',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DEXSCREENER_GATE_ENV,
        ...BIRDEYE_COLLECTOR_ENV,
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
        METEORA_COLLECTOR_INTERVAL_MS: '120000',
        METEORA_COLLECTOR_START_OFFSET_MS: '10000',
        METEORA_COLLECTOR_ENRICH_MAX_RETRIES: '1',
        PAPER2_SNAPSHOT_OPENS: '1',
        PAPER2_SNAPSHOT_DS_DELAY_MS: '500',
        PAPER2_SNAPSHOT_SOLO_FETCH_MAX_PER_TICK: '6',
        PAPER2_SNAPSHOT_BATCH_CHUNKS_MAX_PER_TICK: '8',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DEXSCREENER_GATE_ENV,
        ...BIRDEYE_COLLECTOR_ENV,
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
        MOONSHOT_COLLECTOR_INTERVAL_MS: '120000',
        MOONSHOT_COLLECTOR_START_OFFSET_MS: '20000',
        MOONSHOT_COLLECTOR_ENRICH_MAX_RETRIES: '1',
        PAPER2_SNAPSHOT_OPENS: '1',
        PAPER2_SNAPSHOT_DS_DELAY_MS: '500',
        PAPER2_SNAPSHOT_SOLO_FETCH_MAX_PER_TICK: '6',
        PAPER2_SNAPSHOT_BATCH_CHUNKS_MAX_PER_TICK: '8',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DEXSCREENER_GATE_ENV,
        ...BIRDEYE_COLLECTOR_ENV,
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
        PUMPSWAP_COLLECTOR_START_OFFSET_MS: '35000',
        PUMPSWAP_COLLECTOR_ENRICH_MAX_RETRIES: '1',
        PAPER2_SNAPSHOT_OPENS: '1',
        PAPER2_SNAPSHOT_DS_DELAY_MS: '500',
        PAPER2_SNAPSHOT_SOLO_FETCH_MAX_PER_TICK: '6',
        PAPER2_SNAPSHOT_BATCH_CHUNKS_MAX_PER_TICK: '8',
        LIVE_TRADES_PATH: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        ...DEXSCREENER_GATE_ENV,
        ...BIRDEYE_COLLECTOR_ENV,
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
        COLLECTOR_WATCH_SILENCE_MAX_MS: '720000',
        TELEGRAM_COOLDOWN_ALERT_DEX_COLLECTORS_MS: '300000',
      },
    },
    {
      name: 'sa-collector-health-telegram',
      cwd: root,
      script: 'scripts-tmp/collector-health-telegram.mjs',
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
        /** [HEALTH][collector_status] every 30m — Oscar VPS (live-oscar + copy lanes). */
        TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        COLLECTOR_HEALTH_PRODUCT_LABEL: 'Oscar',
        /** 1.11.685 — Oscar trading health = mild-dip only. */
        COLLECTOR_HEALTH_STRATEGY_TARGETS: JSON.stringify([]),
        COLLECTOR_HEALTH_TELEGRAM: '1',
        COLLECTOR_HEALTH_POLL_MS: '120000',
        COLLECTOR_HEALTH_STATUS_INTERVAL_MS: '1800000',
        COLLECTOR_HEALTH_ALERT_REPEAT_MS: '900000',
        COLLECTOR_HEALTH_TICK_STALE_MS: '180000',
        COLLECTOR_HEALTH_DISCOVERY_MAX_AGE_MS: '120000',
        COLLECTOR_HEALTH_SHYFT_MAX_STALE_MS: '120000',
        SNAPSHOT_FRESHNESS_MAX_AGE_SEC: '900',
        SNAPSHOT_FRESHNESS_SKIP_SOURCES: 'orca,moonshot,jupiter',
        COLLECTOR_HEALTH_LIVE_JSONL: path.join(root, 'data/live/pt1-oscar-live.jsonl'),
        TELEGRAM_COOLDOWN_HEALTH_COLLECTOR_STATUS_MS: '0',
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
        RATE_429_REPORT_TELEGRAM: '0',
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
        SNAPSHOT_FRESHNESS_MAX_AGE_SEC: '1800',
        SNAPSHOT_FRESHNESS_ALERT_HOST: 'oscar-vps',
        SNAPSHOT_FRESHNESS_STALE_CONFIRM_TICKS: '2',
        SNAPSHOT_FRESHNESS_REPEAT_ALERT_MS: '3600000',
        TELEGRAM_COOLDOWN_ALERT_SNAPSHOT_STALE_MS: '3600000',
        /** sa-orca off — do not treat stale orca_pair_snapshots as prod incident. */
        SNAPSHOT_FRESHNESS_SKIP_SOURCES: 'orca,moonshot,jupiter',
      },
    },
    {
      name: 'sa-jupiter',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'scripts-tmp/jupiter-route-watcher.mjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      /** Disabled 2026-07-15: unused by live-oscar; burned Jupiter quota (~350 429/30m). Rollback: autostart true + pm2 start sa-jupiter. */
      autostart: false,
      autorestart: false,
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
        /** Developer 10 RPS: global gate + 2 parallel workers, 600 ms (~3.3 RPS from watcher). */
        JUPITER_WATCHER_REQUEST_DELAY_MS,
        JUPITER_WATCHER_QUOTE_CONCURRENCY,
        JUPITER_GLOBAL_MAX_RPS: '8',
        JUPITER_GLOBAL_GATE_PATH: path.join(root, 'data/jupiter-api-gate.json'),
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
      /**
       * 1.11.660 — operator: fully off (no RPC/Dex burn, no revive after reload).
       * Also listed in OSCAR_VPS_EXCLUDED_APPS so ecosystem reload cannot start it.
       */
      autostart: false,
      autorestart: false,
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 15000,
      /** Boot replay + wallet orphan scan on 8GB journal tail; 1024M PM2 cap OOM before executor (PR #403 deploy). */
      max_memory_restart: '3072M',
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        ...JUPITER_PRO_TRADING_ENV,
        ...PM2_SOLANA_RPC_ENV,
        ...QUICKNODE_NO_DAILY_CAP_ENV,
        NODE_ENV: 'production',
        /** Billable trading RPC: Helius (`HELIUS_RPC_URL` / key in shell `.env`). Alchemy left for collectors. */
        ...LIVE_OSCAR_HELIUS_RPC_ENV,
        /** Снимок для дашборда / QuickNode hourly (дефолт в коде тот же файл). */
        LIVE_DISCOVERY_HEALTH_SNAPSHOT_PATH: path.join(root, 'data/live-discovery-health.json'),
        /**
         * Paper-слой = паритет с `pt1-oscar` (W7.2 / holders / W7.6 / W7.4).
         * W7.3 priority fee, W7.5 liq-watch, W7.8 sim-audit — **только** этот процесс (на pt1-* выкл.).
         */
        PAPER_STRATEGY_KIND: 'dip',
        PAPER_STRATEGY_ID: 'live-oscar',
        /** preset-c/pullback-scan imports geometry from market-pullback-telegram-watch — must not start TG poll in-process. */
        PULLBACK_ALERT_SKIP_MAIN: '1',
        /** Unused file — live-oscar never writes paper JSONL (P4-I1). */
        PAPER_TRADES_PATH: path.join(root, 'data/paper2/_live_oscar_unused_journal.jsonl'),
        PAPER_HEARTBEAT_INTERVAL_MS: '30000',
        /** 1.11.603 — bare half8: slower ticks, smaller pool, headroom vs Dex gate. */
        PAPER_DISCOVERY_INTERVAL_MS: '30000',
        PAPER_DISCOVERY_TICK_TIMEOUT_MS: '300000',
        /** 1.11.578 — watchdog: Telegram ALERT если нет completed discovery tick >5 мин (boot grace 3 мин). */
        LIVE_DISCOVERY_STALL_ALERT_ENABLED: '1',
        LIVE_DISCOVERY_STALL_ALERT_MS: '300000',
        LIVE_DISCOVERY_STALL_BOOT_GRACE_MS: '180000',
        LIVE_DISCOVERY_STALL_ALERT_REPEAT_MS: '600000',
        /** 1.11.244: быстрее reeval для SQL-pool mint'ов; priority tier — `PAPER_PRIORITY_DISCOVERY_REEVAL_SEC`. */
        PAPER_DISCOVERY_REEVAL_SEC: '30',
        /** Prod-only SQL pool (≥$3M); was 500 → eval storm + 120s timeouts. */
        PAPER_SNAPSHOT_CANDIDATE_LIMIT: '250',
        PAPER_TRACK_INTERVAL_MS: '30000',
        PAPER_FOLLOWUP_TICK_MS: '60000',
        PAPER_DRY_RUN: 'false',
        /**
         * 1.11.604 — prod ≥$3M: 8×$300 entry split ($2400) + avg −10% $300; max $2700.
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
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG8_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS: '10000',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_UP_PCT: '3',
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_DOWN_PCT: '5',
        /** 0 = timed corridor splits (not dip-triggered leg-2). */
        PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_TARGET_DROP_PCT: '0',
        /** Solo DexScreener → PG refresh while entry-split legs 2–8 are pending (30s buckets, 45s cooldown). */
        PAPER_LIVE_PENDING_LEG_PG_REFRESH_ENABLED: '1',
        PAPER_LIVE_PENDING_LEG_PG_REFRESH_COOLDOWN_MS: '45000',
        PAPER_LIVE_PENDING_LEG_PG_REFRESH_BUCKET_SEC: '30',
        PAPER_LIVE_STAGED_ENTRY_AVG_COOLDOWN_MS: '0',
        PAPER_LIVE_STAGED_ENTRY_AVG_SECOND_COOLDOWN_MS: '300000',
        /**
         * Down-add discipline (anti «downhill runner»): block averaging-down legs that are too late
         * (>4h from first entry) or too deep (drop vs signal ≤ −20%). Keeps initial entry + shallow
         * recovery adds; cuts the deep/late adds that historically rode to killstop. 0 = off each.
         */
        PAPER_LIVE_STAGED_AVG_MAX_AGE_MS: '14400000',
        PAPER_LIVE_STAGED_AVG_MAX_DEPTH_PCT: '20',
        PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT: '10',
        /** avg @ −10%: fixed $300 (1.11.604; was 50% of split = $2000 on 8×$500). */
        PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD: '300',
        PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT: '0',
        PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD: '0',
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
         * Shyft OFF — subscription ended (2026-07). DexScreener + PG + Jupiter cover discovery/MTM.
         * LERA parity: shadow + primary all OFF; creds may remain in `.env` unused.
         */
        SHYFT_SHADOW_ENABLED: '0',
        SHYFT_STREAM_ENABLED: '0',
        PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED: '0',
        PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_AGE_MS: '60000',
        PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_MINTS: '256',
        SHYFT_PRICE_PRIMARY_ENABLED: '0',
        SHYFT_PRICE_PRIMARY_MTM_ENABLED: '0',
        SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED: '0',
        SHYFT_MAX_STALE_MS: '5000',
        SHYFT_DEFI_MCAP_ENABLED: '0',
        SHYFT_DEFI_MCAP_TTL_MS: '12000',
        /**
         * 1.11.614 — Birdeye→DexScreener→PG primary for open-position MTM (reference-first). Both
         * fresh MTM sources were OFF (Birdeye + Jupiter), leaving stale PG as the only mark → a
         * 24-min-stale PG froze the mark at avgEntry while the market ran +24% and TP/trail never
         * armed (Ge87 RCA). A fresh real-aggregator quote is required to advance the peak/TP;
         * stale PG is dropped (see `resolveLiveOpenPositionMark`). Birdeye self-falls to DexScreener
         * when the key/tier is insufficient (free-stack still works). TTL == max-stale so a cached
         * quote reads as fresh for its whole cache life.
         */
        BIRDEYE_PRIMARY_ENABLED: '1',
        ...BIRDEYE_REST_ENV,
        BIRDEYE_COLLECTOR_ENABLED: '0',
        /** Shared Dex gate + quote cache with collectors (Oscar VPS single egress). */
        ...DEXSCREENER_GATE_ENV,
        ...DEX_QUOTE_CACHE_ENV,
        BIRDEYE_MARKET_TTL_MS: '15000',
        /** Coverage-gap + tier alerts ON — surfaces PG staleness that starves the MTM reference. */
        BIRDEYE_TELEGRAM_ENABLED: '1',
        BIRDEYE_TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        BIRDEYE_TELEGRAM_TIER_COOLDOWN_MS: '1800000',
        BIRDEYE_TELEGRAM_COVERAGE_GAP_COOLDOWN_MS: '1800000',
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
        /** Пост-lane: мин. возраст пула в снимке 48 ч (2 дня); верхняя граница не задана. */
        PAPER_POST_MIN_AGE_MIN: '2880',
        PAPER_POST_MAX_AGE_MIN: '0',
        /** Min liq post-lane / discovery ($30k). */
        PAPER_POST_MIN_LIQ_USD: '30000',
        /** 1.11.244: $10k vol5m отрезал тихие проливы (MANIFEST −17% при v5m=$7k). Код-default 2500. */
        PAPER_POST_MIN_VOL_5M_USD: '2500',
        PAPER_POST_MIN_BUYS_5M: '4',
        PAPER_POST_MIN_SELLS_5M: '3',
        PAPER_POST_MIN_BS: '0.95',
        /**
         * Discovery SQL pool: prod half8 only (≥$3M). LOW lane OFF — no $2M–$3M tier.
         */
        PAPER_DISCOVERY_MIN_MARKET_CAP_USD: '3000000',
        /** Не сканировать discovery pool / eval для mcap > $500M (экономия PG/CPU). Открытые позиции — исключение. */
        PAPER_DISCOVERY_MAX_MARKET_CAP_USD: '500000000',
        /** 1.11.500 — micro lane OFF (min mcap $2M). */
        PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED: '0',
        PAPER_LIVE_OSCAR_MICRO_MCAP_MIN_USD: '500000',
        PAPER_LIVE_OSCAR_MICRO_MCAP_MAX_USD: '1300000',
        PAPER_LIVE_OSCAR_MICRO_MCAP_DIP_MIN_DROP_PCT: '-30',
        PAPER_LIVE_OSCAR_MICRO_MCAP_VOL_1H_MIN_USD: '100000',
        /** 1.11.567 — micro (lane OFF): 2×$150 entry; avg −10% = 50% entry ($150); max $450. */
        PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD: '150',
        PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD: '150',
        PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD: '300',
        PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD: '150',
        PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_DROP_PCT: '10',
        PAPER_LIVE_OSCAR_MICRO_MCAP_DCA_LEVELS: '',
        /** 1.11.565 — LOW lane OFF (bare half8 prod ≥$3M only). */
        PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED: '0',
        PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD: '2000000',
        PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD: '3000000',
        PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT: '-30',
        PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD: '100000',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD: '500',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD: '500',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG3_USD: '0',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG4_USD: '0',
        PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG5_USD: '0',
        PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD: '1000',
        PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_DROP_PCT: '10',
        PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD: '500',
        PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_DROP_PCT: '0',
        PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_LEG_USD: '0',
        PAPER_LIVE_OSCAR_LOW_MCAP_DCA_LEVELS: '',
        /** 1.11.500 — scalp_wave lane OFF. */
        PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED: '0',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_AGE_MIN: '720',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_MCAP_USD: '2000000',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD: '30000000',
        PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MIN_DROP_PCT: '-15',
        PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MAX_DROP_PCT: '-8',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_IMPULSE_PCT: '8',
        PAPER_LIVE_OSCAR_SCALP_WAVE_VOL_1H_MIN_USD: '100000',
        PAPER_LIVE_OSCAR_SCALP_WAVE_POSITION_USD: '300',
        PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_CONCURRENT: '3',
        PAPER_LIVE_OSCAR_SCALP_WAVE_TP_PCT: '0.1',
        PAPER_LIVE_OSCAR_SCALP_WAVE_KILL_PCT: '0.1',
        PAPER_LIVE_OSCAR_SCALP_WAVE_TIME_STOP_HOURS: '3',
        /**
         * fast_dip_scalp lane OFF (pending live A/B). Backtest 60d (pumpswap 60s bars, PG snapshots):
         * entry ≤ −25% vs 15m rolling-high, single-shot, SL −15%, 30m time-stop, TP ladder +10%/50%
         * +22%/30% + peak-trail runner. Net ≈ +4.4%/trade @2% round-trip, win ~55%, ~2.3 trades/day.
         */
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_LANE_ENABLED: '0',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_WINDOW_MIN: '15',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_MIN_DROP_PCT: '-25',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_MAX_DROP_PCT: '-60',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_IMPULSE_PCT: '0',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_MCAP_USD: '3000000',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MAX_MCAP_USD: '1000000000',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_VOL_1H_MIN_USD: '100000',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_AGE_MIN: '60',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_POSITION_USD: '500',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MAX_CONCURRENT: '2',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_KILL_PCT: '0.15',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TIME_STOP_MIN: '30',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TP_RUNGS_PCT: '0.10,0.22',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TP_SELL_FRACS: '0.50,0.30',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TRAIL_ARM_PCT: '0.18',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TRAIL_STEP_PCT: '0.06',
        PAPER_LIVE_OSCAR_FAST_DIP_SCALP_COOLDOWN_MIN: '30',
        /** 1.11.543 — runner_probe lane ON (fresh runners 12–48h, 2×$500); intel shadow 48h before gate. */
        PAPER_RUNNER_PROBE_ENABLED: '0',
        PAPER_RUNNER_PROBE_MIN_AGE_MIN: '2880',
        PAPER_RUNNER_PROBE_MAX_AGE_MIN: '2880',
        PAPER_RUNNER_PROBE_12H_INTEL_REQUIRED: '1',
        PAPER_RUNNER_PROBE_MIN_MCAP_USD: '2000000',
        PAPER_RUNNER_PROBE_MAX_MCAP_USD: '30000000',
        PAPER_RUNNER_PROBE_POSITION_USD: '500',
        PAPER_RUNNER_PROBE_MAX_CONCURRENT: '4',
        PAPER_RUNNER_PROBE_MAX_EXPOSURE_USD: '4000',
        PAPER_RUNNER_PROBE_DIP_MIN_DROP_PCT: '-20',
        PAPER_RUNNER_PROBE_DIP_MAX_DROP_PCT: '-45',
        PAPER_RUNNER_PROBE_MIN_IMPULSE_PCT: '12',
        PAPER_RUNNER_PROBE_VOL_1H_MIN_USD: '100000',
        PAPER_RUNNER_PROBE_MIN_VOL_1H_USD: '100000',
        PAPER_RUNNER_PROBE_MIN_VOL_12H_USD: '400000',
        PAPER_RUNNER_PROBE_VELOCITY_MIN_X: '1.5',
        PAPER_RUNNER_PROBE_MIN_VOL_5M_PEAK_1H_USD: '20000',
        PAPER_RUNNER_PROBE_BS_1H_MIN: '0.95',
        PAPER_RUNNER_PROBE_BS_12H_MIN: '1.0',
        PAPER_RUNNER_PROBE_LIQ_VS_P25_MIN: '0.85',
        PAPER_RUNNER_PROBE_PRICE_HOLD_MIN: '0.6',
        PAPER_RUNNER_PROBE_MIN_LIQ_USD: '80000',
        PAPER_RUNNER_PROBE_STALE_VOL_RATIO_MAX: '0.5',
        PAPER_RUNNER_PROBE_MIN_PG_SAMPLES_24H: '36',
        PAPER_RUNNER_PROBE_TP_PCT: '0.10',
        PAPER_RUNNER_PROBE_KILL_PCT: '0.50',
        PAPER_RUNNER_PROBE_DCA_LEVELS: '-10:0.5,-20:0.5',
        PAPER_RUNNER_PROBE_TIME_STOP_HOURS: '6',
        /** 1.11.545 — runner_lite tier routing: tier1 $500k–<$1M OR tier2 probe-fallback 2×$100. */
        PAPER_RUNNER_LITE_ENABLED: '0',
        PAPER_RUNNER_LITE_MIN_AGE_MIN: '2880',
        PAPER_RUNNER_LITE_MAX_AGE_MIN: '2880',
        PAPER_RUNNER_LITE_12H_INTEL_REQUIRED: '0',
        /** Tier-1 mcap ceiling (< probe min $1M). Tier-2 fallback uses PAPER_RUNNER_PROBE_MAX_MCAP_USD. */
        PAPER_RUNNER_LITE_MIN_MCAP_USD: '2000000',
        PAPER_RUNNER_LITE_MAX_MCAP_USD: '999999',
        PAPER_RUNNER_LITE_POSITION_USD: '200',
        PAPER_RUNNER_LITE_LEG_USD: '100',
        /** runner_lite: one DCA at −25% (+⅓ of position, $200 → max ~$266.67). */
        PAPER_RUNNER_LITE_DCA_LEVELS: '-25:0.333',
        PAPER_RUNNER_LITE_MAX_CONCURRENT: '4',
        PAPER_RUNNER_LITE_MAX_EXPOSURE_USD: '800',
        PAPER_RUNNER_LITE_DIP_MIN_DROP_PCT: '-20',
        PAPER_RUNNER_LITE_DIP_MAX_DROP_PCT: '-45',
        PAPER_RUNNER_LITE_MIN_IMPULSE_PCT: '10',
        PAPER_RUNNER_LITE_VOL_1H_MIN_USD: '100000',
        PAPER_RUNNER_LITE_MIN_VOL_1H_USD: '100000',
        PAPER_RUNNER_LITE_MIN_VOL_12H_USD: '200000',
        PAPER_RUNNER_LITE_VELOCITY_MIN_X: '1.0',
        PAPER_RUNNER_LITE_MIN_VOL_5M_PEAK_1H_USD: '10000',
        PAPER_RUNNER_LITE_BS_1H_MIN: '0.85',
        PAPER_RUNNER_LITE_BS_12H_MIN: '0.90',
        PAPER_RUNNER_LITE_LIQ_VS_P25_MIN: '0.80',
        PAPER_RUNNER_LITE_PRICE_HOLD_MIN: '0.55',
        PAPER_RUNNER_LITE_MIN_LIQ_USD: '50000',
        PAPER_RUNNER_LITE_STALE_VOL_RATIO_MAX: '0.35',
        PAPER_RUNNER_LITE_MIN_PG_SAMPLES_24H: '24',
        /** runner_lite: hard intel gate when tier gates pass (same as runner_probe). */
        LIVE_OSCAR_INTEL_MODE_RUNNER_LITE: 'gate',
        /** Tier «Первый выстрел» — OFF for prod-only LERA parity ($3M SQL floor).
         *  shadow widens discovery SQL to anchorMinMcap $100k → eval storm + discovery tick timeout. */
        PAPER_PERVYY_VYSTREL_ENABLED: '0',
        PAPER_PERVYY_VYSTREL_MODE: 'off',
        PAPER_PERVYY_VYSTREL_FAIL_OPEN: '1',
        PAPER_PERVYY_VYSTREL_LEG_USD: '25',
        PAPER_PERVYY_VYSTREL_POSITION_USD: '50',
        PAPER_PERVYY_VYSTREL_MAX_CONCURRENT: '4',
        PAPER_PERVYY_VYSTREL_MAX_EXPOSURE_USD: '200',
        PAPER_PERVYY_VYSTREL_STAGED_ENTRY: '1',
        PAPER_PERVYY_VYSTREL_ANCHOR_MIN_MCAP_USD: '100000',
        PAPER_PERVYY_VYSTREL_ANCHOR_MAX_MCAP_USD: '250000',
        PAPER_PERVYY_VYSTREL_ENTRY_MAX_MCAP_USD: '1000000',
        PAPER_PERVYY_VYSTREL_MIN_VOL_1H_USD: '100000',
        PAPER_PERVYY_VYSTREL_SURVEILLANCE_MIN_VOL_1H_USD: '100000',
        PAPER_PERVYY_VYSTREL_MIN_AGE_MIN: '360',
        PAPER_PERVYY_VYSTREL_MAX_AGE_MIN: '2880',
        PAPER_PERVYY_VYSTREL_DUMP_MIN_PCT: '40',
        PAPER_PERVYY_VYSTREL_DUMP_MIN_MULTIPLE: '3',
        PAPER_PERVYY_VYSTREL_CLUSTER_SELL_RATIO_MIN: '0.40',
        PAPER_PERVYY_VYSTREL_CLUSTER_MIN_UNIQUE_SELLERS: '2',
        PAPER_PERVYY_VYSTREL_RETAIL_PANIC_MAX: '0.55',
        PAPER_PERVYY_VYSTREL_MIN_UNIQUE_BUYERS_1H: '18',
        PAPER_PERVYY_VYSTREL_MAX_CLUSTER_BUYER_RATIO: '0.45',
        PAPER_PERVYY_VYSTREL_RERAMP_MIN_FROM_BOTTOM_PCT: '25',
        PAPER_PERVYY_VYSTREL_RERAMP_MAX_VS_PEAK_PCT: '0.85',
        PAPER_PERVYY_VYSTREL_WATCH_TTL_HOURS: '72',
        PAPER_PERVYY_VYSTREL_HOLDER_POLL_MIN: '5',
        PAPER_PERVYY_VYSTREL_EARLY_BUY_WINDOW_SEC: '180',
        PAPER_PERVYY_VYSTREL_PHASE_A_PEAK_MCAP_USD: '350000',
        PAPER_PERVYY_VYSTREL_PHASE_A_MIN_DWELL_H: '2',
        PAPER_PERVYY_VYSTREL_KILL_PCT: '0.50',
        PAPER_PERVYY_VYSTREL_MAX_ENTRIES_PER_TICK: '1',
        PAPER_PERVYY_VYSTREL_ORGANIC_GATE_ENABLED: '0',
        PAPER_PERVYY_VYSTREL_ORGANIC_GATE_MODE: 'off',
        PAPER_PERVYY_VYSTREL_CLUSTER_DUMP_MODE: 'off',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_ENABLED: '0',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_MODE: 'off',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_WASH_MAX: '0.60',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_ORGANIC_MIN: '0.40',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_ROUND_TRIP_SHARE: '0.50',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_FAIL_OPEN: '1',
        /** PR2 — volume authenticity sub-thresholds (spec §6.4.2). */
        PAPER_PERVYY_VYSTREL_VOL_AUTH_WINDOW_H: '1',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_SWAPS: '15',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_CYCLE_SHARE: '0.40',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_BS_RATIO: '1.10',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_SELF_TRADE: '0.30',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_NET_NEW_SHARE: '0.35',
        PAPER_PERVYY_VYSTREL_VOL_AUTH_HOLDER_STALL_PCT: '0.5',
        PAPER_PERVYY_VYSTREL_MIN_UNCLUSTERED_BUYERS_1H: '10',
        LIVE_OSCAR_INTEL_MODE_PERVYY_VYSTREL: 'off',
        /** Shyft shadow: suppress mint-set resubscribes right after connect (boot churn). */
        SHYFT_SHADOW_CONNECT_GRACE_MS: '30000',
        /** Wallet-intel / cluster overlay OFF — bare dip gates only. */
        LIVE_OSCAR_INTEL_ENABLED: '0',
        LIVE_OSCAR_INTEL_MODE: 'off',
        /** runner_probe lane: hard gate after shadow window (prod/scalp_wave stay shadow). */
        LIVE_OSCAR_INTEL_MODE_RUNNER_PROBE: 'gate',
        LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED: '1',
        LIVE_OSCAR_INTEL_FAIL_CLOSED: '0',
        LIVE_OSCAR_INTEL_REQUIRE_SWAP_COVERAGE: '0',
        LIVE_OSCAR_INTEL_EARLY_BUY_WINDOW_SEC: '180',
        LIVE_OSCAR_INTEL_EARLY_BUY_WALLET_CAP: '60',
        LIVE_OSCAR_INTEL_BLOCK_INTEL_BLOCK_TRADE: '1',
        LIVE_OSCAR_INTEL_BLOCK_BAD_TAGS: '1',
        LIVE_OSCAR_INTEL_BLOCK_CLUSTERED_WALLETS: '1',
        LIVE_OSCAR_INTEL_BLOCK_SCAM_FARM_META: '1',
        /** TG ADVICE: tier gates OK but wallet-intel blocks (prod / runner_probe / runner_lite). */
        LIVE_OSCAR_INTEL_TELEGRAM_ENABLED: '0',
        LIVE_OSCAR_INTEL_TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        /** Dedup via mint+intel-reason fingerprint in-process; no time cooldown. */
        LIVE_OSCAR_INTEL_TELEGRAM_COOLDOWN_MS: '0',
        TELEGRAM_COOLDOWN_ADVICE_LIVE_OSCAR_INTEL_BLOCK_MS: '0',
        /** Prod tier (mcap ≥ $3M): near-miss runner — dip −18%, vol1h ≥$50k. Low tier $2M–$3M — см. PAPER_LIVE_OSCAR_LOW_*. */
        /** 1.11.605: −18% prod dip + vol50k (24h counterfactual: TripleT/NORMIE-class near-misses). */
        PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT: '-18',
        PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD: '50000',
        /** Prod sub-tier boundary + max caps (signal mcap at entry → scaled slices). 1.11.519. */
        PAPER_LIVE_OSCAR_PROD_MCAP_BAND_12M_USD: '12000000',
        PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD: '2700',
        PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD: '2700',
        PAPER_VOL_5M_1H_GUARD_ENABLED: '1',
        /** Global vol1h floor — no buys below $50k/h (all tiers). 1.11.605: was $100k. */
        PAPER_VOL_1H_MIN_USD: '50000',
        PAPER_VOL_5M_SPIKE_MAX_MULT: '7',
        /** Global holder floor — live QN resolve + Shyft fallback; block when unknown. */
        PAPER_MIN_HOLDER_COUNT: '3000',

        PAPER_DIP_LOOKBACK_MIN: '120',
        PAPER_DIP_LOOKBACK_WINDOWS_MIN: '120,360,720',
        /** Live Oscar only: мин. глубина просадки от high окна (OR 120/360/720 мин). −20 = −20%.
         *  1.11.283: возврат к −20% — меньше входов (было −16 с 1.11.242). */
        /** 1.11.589: −25% global dip floor — fewer «боковик» passes on weak 120m windows. */
        PAPER_DIP_MIN_DROP_PCT: '-25',
        PAPER_DIP_MAX_DROP_PCT: '-50',
        PAPER_DIP_MIN_IMPULSE_PCT: '12',
        /** 1.11.283: паритет с PAPER_POST_MIN_AGE_MIN (48 ч). Было 0 — volume-leader inject обходил post SQL age. */
        PAPER_DIP_MIN_AGE_MIN: '2880',
        /** Глобальный gate discovery/dip: возраст токена (мин), не только age_min пула. */
        PAPER_MIN_TOKEN_AGE_MIN: '2880',
        PAPER_DIP_COOLDOWN_MIN: '30',
        PAPER_DIP_COOLDOWN_MIN_SCALP: '20',
        /** После убыточного закрытия — 10 мин cooldown (не denylist). Работает вместе с hybrid re-entry gate. */
        PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED: 'true',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES: '10',
        PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS: '0',
        /**
         * Re-entry после выхода: price ceiling −10% только в post-exit cooldown (10m); после — без dip anchor.
         */
        /** 1.11.589: re-entry only after −18% from last exit, not chop re-buy (was −10%). */
        LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT: '18',
        LIVE_REENTRY_BREAKOUT_ABOVE_EXIT_PCT: '20',
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

        PAPER_DIP_RECOVERY_VETO_ENABLED: '0',
        PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN: '30,60',
        /** 1.11.593: 12% base + dip-scaled bonus on deep pullbacks (was 8% flat). */
        PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT: '12',
        PAPER_DIP_RECOVERY_VETO_DIP_SCALED: '1',
        PAPER_DIP_RECOVERY_VETO_DIP_SCALED_FLOOR_PCT: '15',
        PAPER_DIP_RECOVERY_VETO_DIP_SCALED_BONUS_PER_POINT: '0.25',
        /** Live Oscar guard: не покупать первую ногу по сигналу, если цена уже у локального high. */
        PAPER_DIP_LOCAL_HIGH_VETO_ENABLED: '1',
        PAPER_DIP_LOCAL_HIGH_VETO_WINDOWS_MIN: '30,60,120',
        /** 1.11.589: 4% below local high — wider anti-FOMO zone (was 2%). */
        PAPER_DIP_LOCAL_HIGH_VETO_MAX_DISTANCE_PCT: '4',
        /** Trend structure veto — stale runner / ski-slope (1.11.583). OFF 1.11.604 — не блокировать dip-входы. */
        PAPER_TREND_STRUCTURE_VETO_ENABLED: '0',
        PAPER_TREND_VETO_LOOKBACK_DAYS: '14',
        PAPER_TREND_VETO_MIN_PG_SAMPLES: '36',
        PAPER_TREND_VETO_NO_HIGH_BREAK_ENABLED: '1',
        PAPER_TREND_VETO_MIN_DAYS_SINCE_HIGH_BREAK: '3',
        PAPER_TREND_VETO_DECLINE_ENABLED: '1',
        PAPER_TREND_VETO_MAX_PX_VS_HIGH_14D: '0.55',
        /** 1.11.593: looser weekly bleed gate during dip entries (was -3). */
        PAPER_TREND_VETO_MAX_SLOPE_7D_PCT: '-8',
        PAPER_TREND_VETO_PEAK_TOUCH_TOLERANCE_PCT: '1',
        PAPER_TREND_VETO_SLOPE_3D_ENABLED: '1',
        PAPER_TREND_VETO_MAX_PX_VS_HIGH_3D: '0.65',
        PAPER_TREND_VETO_MAX_SLOPE_3D_PCT: '-5',
        PAPER_TREND_VETO_SKI_SLOPE_ENABLED: '1',
        PAPER_TREND_VETO_SKI_SLOPE_MAX_PX_VS_HIGH: '0.42',
        PAPER_TREND_VETO_SKI_SLOPE_MIN_DAYS_SINCE_HIGH: '2',
        PAPER_TREND_VETO_SKI_SLOPE_REVERSAL_BYPASS_ENABLED: '1',
        PAPER_TREND_VETO_SKI_SLOPE_REVERSAL_LOOKBACK_HOURS: '72',
        /** 1.11.593: febu-class post-crash bases (was 80%). */
        PAPER_TREND_VETO_SKI_SLOPE_REVERSAL_MIN_BOUNCE_PCT: '60',
        PAPER_TREND_VETO_SKI_SLOPE_REVERSAL_MIN_HOURS_AFTER_LOW: '12',
        /** Deep dip + slope3d≥0: skip no_high_break + decline (keeps ski-slope). */
        PAPER_TREND_VETO_DIP_BYPASS_ENABLED: '1',
        PAPER_TREND_VETO_DIP_BYPASS_MIN_DIP_PCT: '15',
        PAPER_TREND_VETO_DIP_BYPASS_MIN_SLOPE_3D_PCT: '0',
        /** Telegram when dip passed but trend veto is sole blocker (default ON, 30m cooldown). */
        LIVE_TREND_VETO_TELEGRAM_ENABLED: '0',
        LIVE_TREND_VETO_TELEGRAM_COOLDOWN_MS: '1800000',
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
        /** Range-base dip — sideways 48h base + flush from range low (6Nwar-class). */
        PAPER_DIP_RANGE_BASE_ENABLED: '1',
        PAPER_DIP_RANGE_BASE_LOOKBACK_HOURS: '48',
        PAPER_DIP_RANGE_BASE_MAX_SPAN_PCT: '15',
        PAPER_DIP_RANGE_BASE_MAX_NET_MOVE_PCT: '10',
        PAPER_DIP_RANGE_BASE_MIN_VOL5M_SPIKE_MULT: '2',
        PAPER_DIP_RANGE_BASE_MIN_PG_SAMPLES: '12',

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
        /** 1.11.589: must be within 1% of 30m low — no «отскок в боковике» (was 2.5%). */
        PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT: '1.0',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_ENABLED: '1',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_MIN_PCT: '-20',
        PAPER_POLICY_A_PLUS_VOL_1H_ENABLED: '1',
        PAPER_POLICY_A_PLUS_VOL_1H_MAX_USD: '1000000',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_ENABLED: '1',
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_WINDOW_MIN: '15',
        /** 1.11.589: block entry if −10% in 15m still in free-fall (was −7%). */
        PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT: '-10',
        /**
         * Volume Sybil guard (1.11.216): блокирует dead→spike→dead wash-паттерн
         * по истории `volume_5m` в PG snapshots (lookback 6h, recent 45m).
         */
        PAPER_VOLUME_SYBIL_GUARD_ENABLED: '1',
        PAPER_VOLUME_SYBIL_LOOKBACK_HOURS: '6',
        PAPER_VOLUME_SYBIL_RECENT_MINUTES: '45',
        PAPER_VOLUME_SYBIL_BASELINE_P10_MAX_USD: '3000',
        PAPER_VOLUME_SYBIL_MIN_BASELINE_SAMPLES: '15',
        PAPER_VOLUME_SYBIL_MIN_RECENT_VOL5M_USD: '8000',
        PAPER_VOLUME_SYBIL_SPIKE_RATIO_MIN: '6',
        PAPER_VOLUME_SYBIL_DEAD_VOL5M_USD: '2500',
        /** 1.11.245: p10 alone ловил живые монеты (MANIFEST); нужны dead_frac + p50 + vol1h exempt. */
        PAPER_VOLUME_SYBIL_MIN_DEAD_FRACTION: '0.55',
        PAPER_VOLUME_SYBIL_VOL1H_ALIVE_EXEMPT_USD: '36000',
        /**
         * Volume Ephemeral guard (1.11.219): блокирует монеты с объёмом, сжатым
         * в узкое почасовое окно (разовый burst — паттерн GOAT).
         * Re-enabled with Birdeye fresh bypass (DADDY RCA Jul 5–6).
         */
        PAPER_VOLUME_EPHEMERAL_GUARD_ENABLED: '1',
        PAPER_VOLUME_EPHEMERAL_BIRDEYE_FRESH_BYPASS: '1',
        PAPER_PG_COVERAGE_BIRDEYE_FRESH_BYPASS: '1',
        PAPER_VOLUME_EPHEMERAL_LOOKBACK_HOURS: '24',
        PAPER_VOLUME_EPHEMERAL_MIN_ACTIVE_HOUR_VOL5M_USD: '8000',
        PAPER_VOLUME_EPHEMERAL_MAX_ACTIVE_HOURS: '4',
        PAPER_VOLUME_EPHEMERAL_MIN_PEAK_VOL5M_USD: '20000',
        PAPER_VOLUME_EPHEMERAL_MIN_HOURS_WITH_DATA: '2',
        PAPER_VOLUME_EPHEMERAL_SPARSE_HOURS_BUFFER: '2',
        PAPER_VOLUME_EPHEMERAL_TAIL_BLOCK_ENABLED: '1',
        PAPER_VOLUME_EPHEMERAL_TAIL_MAX_PEAK_RATIO: '0.3',
        /** New mints: min active hours + wash vol ratio (MUSHU RCA 2026-06-30). */
        PAPER_VOLUME_EPHEMERAL_NEW_MINT_MIN_ACTIVE_HOURS: '8',
        /** Known-mint re-entry: block tail_wash when vol5m/vol1h < 8% (6AVA SCAM RCA 2026-07-12). */
        PAPER_VOLUME_EPHEMERAL_KNOWN_MINT_TAIL_WASH_BLOCK_ENABLED: '1',
        PAPER_VOLUME_GUARD_NEW_MINT_MIN_VOL5M_TO_VOL1H_RATIO: '0.08',
        PAPER_VOLUME_GUARD_NEW_MINT_VOL1H_WASH_MIN_USD: '36000',
        /** Ephemeral volume spike (7d dormant→spike, age-agnostic; DADDY RCA 2026-07-05). */
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_GUARD_ENABLED: '1',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MIN_TOKEN_AGE_DAYS: '0',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MAX_YOUNG_TOKEN_AGE_DAYS: '2',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_LOOKBACK_HOURS: '168',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_BASELINE_START_HOURS: '168',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_BASELINE_END_HOURS: '48',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_RECENT_HOURS: '6',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_DORMANT_VOL1H_MAX_USD: '10000',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_DORMANT_VOL5M_MAX_USD: '5000',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MIN_DORMANT_HOUR_FRACTION: '0.55',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MIN_BASELINE_HOURS: '18',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MIN_SPIKE_VOL1H_USD: '25000',
        PAPER_OLD_MINT_DORMANT_VOL_SPIKE_VOL1H_RATIO_MIN: '5',
        /**
         * PG data coverage (1.11.222): metrics/audit only — do not block buys on thin PG history.
         * Set PAPER_PG_DATA_COVERAGE_BLOCK_BUY=1 to restore legacy skip + TG ADVICE.
         */
        PAPER_PG_DATA_COVERAGE_GUARD_ENABLED: '1',
        PAPER_PG_DATA_COVERAGE_BLOCK_BUY: '0',
        PAPER_PG_DATA_COVERAGE_LOOKBACK_HOURS: '24',
        /** Mint/sybil checks use last 6h during outage; full 24h tier auto-restores when PG healthy. */
        PAPER_PG_DATA_COVERAGE_RECENT_HOURS: '6',
        PAPER_PG_DATA_COVERAGE_MIN_RECENT_HOURS_WITH_DATA: '4',
        PAPER_PG_DATA_COVERAGE_MIN_HOUR_RATIO: '0.5',
        PAPER_PG_DATA_COVERAGE_STRICT_MIN_HOUR_RATIO: '0.75',
        PAPER_PG_DATA_COVERAGE_MIN_SYSTEM_HOUR_RATIO: '0.3',
        PAPER_PG_DATA_COVERAGE_MIN_MINUTES_PER_HOUR: '5',
        PAPER_PG_DATA_COVERAGE_MAX_GAP_MINUTES: '30',
        PAPER_PG_DATA_COVERAGE_BLOCK_ON_PG_STALE: '1',
        PAPER_PG_DATA_COVERAGE_STRICT_AFTER_RECOVERY_HOURS: '24',
        PAPER_PG_DATA_COVERAGE_AUTO_ESCALATE: '1',
        /** Repeat mints (bot traded within lookback): skip pg_gap block; new mints stay strict. */
        PAPER_PG_DATA_COVERAGE_KNOWN_MINT_GAP_BYPASS: '1',
        PAPER_PG_DATA_COVERAGE_KNOWN_MINT_LOOKBACK_DAYS: '14',
        /** Familiar bypass removed — pg_stale / volume guards use Dex cache SSOT (#404, #409). */
        LIVE_PG_DATA_COVERAGE_TELEGRAM_ENABLED: '0',
        LIVE_PG_DATA_COVERAGE_TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        LIVE_PG_DATA_COVERAGE_TELEGRAM_COOLDOWN_MS: '3600000',
        LIVE_PG_COVERAGE_MODE_TELEGRAM_COOLDOWN_MS: '7200000',
        TELEGRAM_COOLDOWN_ADVICE_LIVE_OSCAR_PG_DATA_COVERAGE_MS: '1800000',
        /** TG: блок volume ephemeral guard — подозрительный разовый всплеск объёма. */
        LIVE_VOLUME_EPHEMERAL_TELEGRAM_ENABLED: '0',
        LIVE_VOLUME_EPHEMERAL_TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        LIVE_VOLUME_EPHEMERAL_TELEGRAM_COOLDOWN_MS: '3600000',
        TELEGRAM_COOLDOWN_ADVICE_LIVE_OSCAR_VOLUME_EPHEMERAL_MS: '1800000',
        /** TG: only when new local-high veto is the sole reason a live-oscar candidate is skipped. */
        LIVE_LOCAL_HIGH_VETO_TELEGRAM_ENABLED: '0',
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
        /** 0 = off — owner: no auto time-stop; manual exit after ~2d if needed (2026-07-10). */
        PAPER_LIVE_OSCAR_WAVE_B_TIME_STOP_HOURS: '0',
        /**
         * Hard profit-agnostic time-stop (hours) — any exit policy. Frees capital from stale
         * «downhill runner» positions instead of sitting to −50% killstop for days. Real on-chain
         * full exit (TIME_STOP, policy-allowed). Backtest 2mo: ×3 capital efficiency @ 24h. 0 = off.
         */
        /** 0 = off — same as Wave B TS; capital rotation by hand (2026-07-10). */
        PAPER_LIVE_OSCAR_HARD_TIME_STOP_HOURS: '0',
        PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A: '0',
        PAPER_LIVE_OSCAR_VARIANT_A_SALVAGE24_ENABLED: '1',
        PAPER_LIVE_OSCAR_VARIANT_A_SALVAGE24_MIN_PEAK_PCT: '5',
        PAPER_LIVE_OSCAR_VARIANT_A_SMART48_ENABLED: '0',
        LIVE_MINT_SCRATCH_REENTRY_ENABLED: '0',
        PAPER_PEAK_LOG_STEP_PCT: '1',

        PAPER_DIP_WHALE_ANALYSIS_ENABLED: '0',
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
         * Holders gate: live QN GPA; block only when count known and below min.
         * ON_FAIL=warn — unknown count does not block buy (Shyft off).
         */
        PAPER_HOLDERS_LIVE_ENABLED: '1',
        PAPER_HOLDERS_USE_QN_ADDON: '0',
        PAPER_HOLDERS_TTL_MS: '90000',
        PAPER_HOLDERS_NEG_TTL_MS: '15000',
        PAPER_HOLDERS_MAX_PER_TICK: '8',
        PAPER_HOLDERS_TIMEOUT_MS: '4000',
        PAPER_HOLDERS_INCLUDE_TOKEN2022: '1',
        PAPER_HOLDERS_ON_FAIL: 'warn',
        PAPER_HOLDERS_DB_WRITEBACK: '1',
        PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX: '0',
        PAPER_HOLDERS_GPA_CREDITS_PER_CALL: '100',
        SHYFT_HOLDERS_ENABLED: '0',
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
        PAPER_RUNNER_MIN_VOL_1H_USD: '100000',
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
        /** 1.11.502 — split large live exits (partial TP, kill, full close) into ≤$400 slices. */
        LIVE_EXIT_SLICE_MAX_USD: '400',
        LIVE_EXIT_SLICE_DELAY_MS: '10000',
        /** 1.11.604 — staged_avg / entry_split Jupiter buys: ≤$300 slices, 10s gap. */
        LIVE_ENTRY_SLICE_MAX_USD: '300',
        LIVE_ENTRY_SLICE_DELAY_MS: '10000',

        /** 1.11.608 — swap-only: sim-audit Jupiter builds off on live-oscar (was 5% sample → extra swap POSTs). */
        PAPER_SIM_AUDIT_ENABLED: '0',
        PAPER_SIM_SAMPLE_PCT: '0',
        PAPER_SIM_USE_JUPITER_BUILD: '0',

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

        /** `[HEALTH][live_oscar_pulse]` выключен — статус коллекторов только через sa-collector-health-telegram. */
        LIVE_TELEGRAM_HEARTBEAT: '0',

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

        /** 1.11.555 — false-positive LIQ_DRAIN exits; rollback: ENABLED=1 + FORCE_CLOSE=1. */
        PAPER_LIQ_WATCH_ENABLED: '0',
        PAPER_LIQ_WATCH_FORCE_CLOSE: '0',
        PAPER_LIQ_WATCH_DRAIN_PCT: '25',
        PAPER_LIQ_WATCH_MIN_AGE_MIN: '1',
        PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES: '2',
        PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS: '120000',
        PAPER_LIQ_WATCH_RPC_FALLBACK: '1',
        PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE: '1',
        PAPER_LIQ_WATCH_STAMP_ON_TRACK: '0',
        PAPER_LIQ_WATCH_DISAGREEMENT_PCT: '25',
        PAPER_LIQ_WATCH_DISCOVERY_QUOTE: '1',

        /**
         * VOL_COLLAPSE — rolling-volume drain kill-stop (sibling of LIQ_DRAIN). Backtest (60d, 2819
         * dip-buy entries): sustained collapse predicts ~-10..-12%% forward decline, ~2x capital
         * efficiency. Recommended thresholds COLLAPSE_PCT=90 (vol ≤10%% of baseline), SUSTAIN_HOURS=3.
         * ENFORCED (owner-approved 2026-07-08): ENABLED=1 + FORCE_CLOSE=1 → real on-chain full exit.
         * Rollback: set ENABLED=0 (or FORCE_CLOSE=0 for shadow-only).
         */
        PAPER_VOL_WATCH_ENABLED: '1',
        PAPER_VOL_WATCH_FORCE_CLOSE: '1',
        PAPER_VOL_WATCH_COLLAPSE_PCT: '90',
        PAPER_VOL_WATCH_SUSTAIN_HOURS: '3',
        PAPER_VOL_WATCH_MIN_BASELINE_USD: '2000',
        PAPER_VOL_WATCH_MIN_AGE_MIN: '30',
        PAPER_VOL_WATCH_SNAPSHOT_MAX_AGE_MS: '120000',
        PAPER_VOL_WATCH_STAMP_ON_TRACK: '1',

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
        LIVE_OPEN_SNAPSHOT_PATH: path.join(root, 'data/live/live-oscar-open-snapshot.json'),
        /** Subtract copy-leader cost basis from wallet-holds-mint gate. */
        LIVE_COPY_LEADER_ATTRIBUTION_ENABLED: '1',
        LIVE_COPY_LEADER_STATE_PATH: path.join(root, 'data/copytrader/state.json'),
        /** Copy exits are leader-mirror (`copy-trader` EXIT_MODE=mirror) — do not adopt into Oscar half8. */
        LIVE_COPY_LEADER_ADOPT_STAGED_ENTRY_ENABLED: '0',
        LIVE_COPY_LEADER_EXIT_ADOPT_ENABLED: '0',
        LIVE_COPY_LEADER_ADOPT_AVG_LEG_PCT: '25',
        /** `live_discovery_eval` / `live_discovery_skip_open` в JSONL (отключить: `0`). */
        LIVE_DISCOVERY_AUDIT_JSONL: '1',
        /** Полный аудит по mint из whitelist-файла: pass/fail eval, `universe_miss`, `tick_skip`. */
        LIVE_DISCOVERY_DEEP_AUDIT_JSONL: '0',
        LIVE_DISCOVERY_DEEP_AUDIT_WHITELIST_PATH: path.join(root, 'data/live/live-oscar-mint-whitelist.txt'),
        /** 1.11.244 — priority dip-watch tier (open + near-ready + recent eval + SQL pool). Whitelist entry off (`LIVE_MINT_WHITELIST_ENABLED=0`). */
        PAPER_PRIORITY_DISCOVERY_ENABLED: '1',
        PAPER_PRIORITY_DISCOVERY_REEVAL_SEC: '15',
        PAPER_PRIORITY_DISCOVERY_LOOKBACK_MIN: '120',
        PAPER_PRIORITY_DISCOVERY_RECENT_EVAL_MIN: '180',
        PAPER_PRIORITY_DISCOVERY_MAX_MINTS: '200',
        PAPER_PRIORITY_DISCOVERY_JUPITER_REFRESH: '0',
        PAPER_PRIORITY_DISCOVERY_JUPITER_MAX_PER_TICK: '1',
        /** Near-miss Jupiter refresh OFF — swap-only Jupiter policy. */
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_REFRESH: '0',
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_GAP_PCT: '4',
        PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_MAX_PER_TICK: '5',
        /** Priority tier BS 0.75 (global POST_MIN_BS остаётся 0.98). */
        PAPER_PRIORITY_DISCOVERY_MIN_BS: '0.75',
        /** 1.11.274 — Volume Leader tier: top-N by 24h peak vol_1h, canonical pool = max volume. */
        PAPER_VOLUME_LEADER_ENABLED: '0',
        PAPER_VOLUME_LEADER_TOP_N: '50',
        /** 1.11.596: 15→30s — реже полный reeval top runners (меньше Jupiter+DS нагрузки). */
        PAPER_VOLUME_LEADER_REEVAL_SEC: '15',
        PAPER_VOLUME_LEADER_LOOKBACK_HOURS: '24',
        PAPER_VOLUME_LEADER_QUERY_CACHE_SEC: '60',
        /** 1.11.283: откат 90→30m + меньше top-N — реже inject молодых раннеров. */
        PAPER_VOLUME_LEADER_SNAPSHOT_LOOKBACK_MIN: '30',
        /** Volume-leader inject visibility: 12h floor (runner_probe band). Prod eval stays 48h via PAPER_MIN_TOKEN_AGE_MIN. */
        PAPER_VOLUME_LEADER_MIN_TOKEN_AGE_MIN: '720',
        /** 1.11.275 — Snapshot sanity: dead pool / liq≈0 at high mcap before canonical pick. */
        PAPER_DISCOVERY_SNAPSHOT_SANITY_ENABLED: '1',
        PAPER_DISCOVERY_SNAPSHOT_SANITY_REF_MCAP_MIN_USD: '2000000',
        PAPER_DISCOVERY_SNAPSHOT_SANITY_MIN_LIQ_TO_MCAP_RATIO: '0.002',
        PAPER_DISCOVERY_SNAPSHOT_SANITY_MIN_LIQ_SHARE_OF_MINT_MAX: '0.10',
        PAPER_DISCOVERY_SNAPSHOT_SANITY_ZERO_LIQ_MAX_MCAP_USD: '500000',
        /** 1.11.276 — Jupiter cross-check price/mcap for volume-leader tier. */
        PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_ENABLED: '0',
        /** 1.11.601: 20→5 — снять Jupiter RPS с volume-leader tier (1.11.599 ошибочно вернул 20). */
        PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MAX_PER_TICK: '5',
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
        /** Live JSONL; TG pulse off (`LIVE_TELEGRAM_HEARTBEAT=0`). Collector status: sa-collector-health-telegram. */
        TELEGRAM_CHAT_ID: OPERATOR_TELEGRAM_CHAT_ID,
        /**
         * 1m heartbeat: keeps `live-discovery-health.json` fresh for sa-collector-health-telegram
         * (`COLLECTOR_HEALTH_DISCOVERY_MAX_AGE_MS` = 120s).
         */
        LIVE_HEARTBEAT_INTERVAL_MS: '60000',
        /** PG snapshot age in pulse + `[ALERT][snapshot_stale]` on heartbeat when stale. */
        SNAPSHOT_FRESHNESS_MAX_AGE_SEC: '1800',
        SNAPSHOT_FRESHNESS_ALERT_HOST: 'oscar-vps',
        SNAPSHOT_FRESHNESS_SKIP_SOURCES: 'orca,moonshot,jupiter',
        /** Файл keypair торгового кошелька на VPS (`chmod 600`). После замены файла задайте LIVE_WALLET_PUBKEY (совпадает с проверкой в коде). */
        LIVE_WALLET_SECRET: path.join(root, 'data/live/live-oscar-micro.keypair.json'),
        LIVE_WALLET_PUBKEY: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
        LIVE_SIM_ENABLED: '1',
        LIVE_SIM_TIMEOUT_MS: '12000',
        LIVE_SIM_CREDITS_PER_CALL: '30',
        /**
         * 1.11.607 — sim retries inherit JUPITER_PRO_TRADING_ENV (2+1 attempts; 429 → next tracker tick).
         */
        /** Jupiter swap-only: no hot-tick sell probes (was 2.5s × open mint → 429 storms). */
        LIVE_OPEN_HOT_TICK_ENABLED: '0',
        LIVE_OPEN_HOT_TICK_INTERVAL_MS: '2500',
        LIVE_OPEN_HOT_EXEC_PRICE_MAX_AGE_MS: '5000',
        LIVE_OPEN_HOT_PROBE_MIN_USD: '20',
        LIVE_OPEN_HOT_PROBE_MAX_USD: '200',
        LIVE_OPEN_HOT_PROBE_FRACTION: '0.10',
        LIVE_OPEN_HOT_INTER_MINT_DELAY_MS: '200',
        LIVE_KILLSTOP_PREARM_BUFFER_PCT: '1',
        LIVE_KILLSTOP_PREARM_TTL_MS: '8000',
        /** 1.11.526 — TG only on exhausted quote/swap 429 (not retry burst noise). */
        JUPITER_429_BURST_TELEGRAM: '0',
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
        /** Slippage retries: inherit JUPITER_PRO_TRADING_ENV (3×3, was 10×15 → 429 storms on real exits). */
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
        /** Swap-only: tracker MTM from PG; Jupiter only on buy/sell execution. */
        LIVE_TRACKER_JUPITER_MTM_ENABLED: '0',
        LIVE_ENTRY_SPLIT_JUPITER_PROBE_ENABLED: '0',
        /** W8.0 §10 — max Jupiter quote age (ms) before sign/send; `0` = disable (see `loadLiveOscarConfig`). */
        LIVE_QUOTE_MAX_AGE_MS: '8000',
        /**
         * `0` — не слать `live-jupiter-tracker-diverge` / `live-jupiter-tracker-fallback` в Telegram.
         * Circuit breaker price-verify: `JUPITER_QUOTE_CIRCUIT_TELEGRAM=0` при необходимости отдельно.
         */
        LIVE_JUPITER_TRACKER_TELEGRAM: '0',
        /** 1.11.601 — не спамить `[ALERT][jupiter-quote-circuit]` чаще 1 раз/час при хроническом overload. */
        TELEGRAM_COOLDOWN_ALERT_JUPITER_QUOTE_CIRCUIT_MS: '3600000',
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

        /**
         * Мем-режимный гейт (RCA слива 6–8 июля): блок НОВЫХ `buy_open` при широком risk-off
         * в нашей же runner-вселенной (breadth/импульс по `*_pair_snapshots`). Ловит отток,
         * который BTC/SOL-гейты не видят (ритейл ушёл в новые внешние мемкоины на Robinhood).
         * Раскатка по канону: сначала `shadow` (только журналит `risk_note`, не блокирует),
         * после ≥48h наблюдения — `gate`. Выключить: `LIVE_MEM_REGIME_ENABLED=0`.
         */
        LIVE_MEM_REGIME_ENABLED: '1',
        LIVE_MEM_REGIME_MODE: 'shadow',
        /** Фон обновления индекса (с) — вне hot-path покупок. */
        LIVE_MEM_REGIME_REFRESH_SEC: '60',
        /** Импульс: latest price vs latest ≤ now−lookback (мин) + запас на baseline. */
        LIVE_MEM_REGIME_LOOKBACK_MIN: '60',
        LIVE_MEM_REGIME_BASELINE_TOL_MIN: '20',
        /** Раннер = пиковый 1h-объём ≥ этого (USD); тонкая вселенная (< MIN_RUNNERS) = insufficient data. */
        LIVE_MEM_REGIME_MIN_RUNNER_V1H_USD: '10000',
        LIVE_MEM_REGIME_MIN_RUNNERS: '20',
        /** Сигналы risk-off (нужно ≥ REQUIRED_SIGNALS из 3): breadth красных %, equal-weight падение п.п., median падение п.п. */
        LIVE_MEM_REGIME_BREADTH_RED_PCT: '58',
        LIVE_MEM_REGIME_EW_DROP_PCT: '1',
        LIVE_MEM_REGIME_MED_DROP_PCT: '0.8',
        LIVE_MEM_REGIME_REQUIRED_SIGNALS: '2',
        /** Гистерезис: сколько подряд окон подтверждают смену режима. */
        LIVE_MEM_REGIME_CONFIRM_WINDOWS: '2',
        /** Если кэш режима старше (с) — гейт fail-open (unknown, без блока). */
        LIVE_MEM_REGIME_MAX_STALE_SEC: '300',
        /** Периодический снимок режима в live-журнал (`risk_note`), с. */
        LIVE_MEM_REGIME_JOURNAL_EVERY_SEC: '600',

        /**
         * Чёрный лебедь (RCA просадок 4–5 июня и 6–7 июля): РЕДКОЕ (~1–2×/мес) событие, когда
         * топ-раннеры по объёму льются одновременно и глубоко. На триггере — ликвидация ВСЕХ
         * открытых позиций (не гейт входов; это делает LIVE_MEM_REGIME_*). Бэктест 609 реальных
         * позиций Оскара (цены из `*_pair_snapshots`): порог equal-weight ≤ −16% за 6h ловит
         * 4 события (1 ложное), нетто +$5.8k…+$14k за 2 мес; частые/отложенные варианты — в минус.
         * Раскатка по канону: сначала `shadow` (журналит, какие позиции ЗАКРЫЛ БЫ — без продаж),
         * после наблюдения на живых данных — `liquidate`. Выключить: `LIVE_MEM_SWAN_ENABLED=0`.
         */
        LIVE_MEM_SWAN_ENABLED: '1',
        LIVE_MEM_SWAN_MODE: 'liquidate',
        /** Фон обновления индекса (с) — вне hot-path. */
        LIVE_MEM_SWAN_REFRESH_SEC: '60',
        /** Окно равновзвешенного возврата вселенной раннеров (мин) + запас на baseline. */
        LIVE_MEM_SWAN_ROLL_MIN: '120',
        LIVE_MEM_SWAN_BASELINE_TOL_MIN: '15',
        /** Вселенная: топ-N по пиковому 1h-объёму (активные раннеры Оскара, не blue chips). */
        LIVE_MEM_SWAN_TOP_N: '40',
        LIVE_MEM_SWAN_MIN_RUNNER_V1H_USD: '10000',
        /** Анти-фантом: < MIN_RUNNERS валидных раннеров = слепые данные, НЕ ликвидируем. */
        LIVE_MEM_SWAN_MIN_RUNNERS: '20',
        /** Триггер: equal-weight падение ≥ этих % (мгновенно, без breadth/подтверждения). */
        LIVE_MEM_SWAN_EW_DROP_PCT: '14',
        LIVE_MEM_SWAN_BREADTH_RED_MIN_PCT: '65',
        LIVE_MEM_SWAN_BREADTH_EW_DROP_PCT: '8',
        /** Кэш старше (с) — статус unknown, НЕ ликвидируем (fail-safe). */
        LIVE_MEM_SWAN_MAX_STALE_SEC: '900',
        /** Сброс active после N мин валидного затишья (для журнала/повторного эпизода). */
        LIVE_MEM_SWAN_RESUME_MIN: '180',
        /** Периодический снимок индекса лебедя в live-журнал (`risk_note`), с. */
        LIVE_MEM_SWAN_JOURNAL_EVERY_SEC: '600',

        /**
         * OWN-BOOK лебедь / портфельный стоп: независимый домен отказа от индекса топ-80 выше.
         * Считает equal-weight просадку НАШИХ открытых позиций по их живым маркам (snapshot→Jupiter),
         * поэтому срабатывает даже когда внешний индекс «ослеп» (сбой коллекторов). Триггер:
         * EW ≤ −25% за 6h при ≥8 участвующих позициях → ликвидация ВСЕХ. Бэктест 608 позиций:
         * ≈6/мес, ликвидация vs холд +$13.5k. История марок в памяти → после рестарта ~6h прогрев
         * (в это окно прикрывает внешний индекс с PG-бэкфиллом). Откат: LIVE_MEM_SWAN_PORT_ENABLED=0.
         */
        LIVE_MEM_SWAN_PORT_ENABLED: '1',
        LIVE_MEM_SWAN_PORT_MODE: 'liquidate',
        /** Окно equal-weight просадки нашего портфеля (мин) + запас на baseline. */
        LIVE_MEM_SWAN_PORT_ROLL_MIN: '120',
        LIVE_MEM_SWAN_PORT_BASELINE_TOL_MIN: '15',
        /** Триггер: EW нашего book ≤ −этих %. */
        LIVE_MEM_SWAN_PORT_EW_DROP_PCT: '20',
        LIVE_MEM_SWAN_PORT_BREADTH_RED_MIN_PCT: '65',
        LIVE_MEM_SWAN_PORT_BREADTH_EW_DROP_PCT: '8',
        /** Анти-фантом: < этого числа участвующих позиций = не ликвидируем (в т.ч. прогрев). */
        LIVE_MEM_SWAN_PORT_MIN_POSITIONS: '8',
        /** Кэш тика старше (с) — не ликвидируем (fail-safe). */
        LIVE_MEM_SWAN_PORT_MAX_STALE_SEC: '180',
        /** Сброс active после N мин валидного затишья. */
        LIVE_MEM_SWAN_PORT_RESUME_MIN: '120',
        /** Периодический снимок own-book индекса в live-журнал, с. */
        LIVE_MEM_SWAN_PORT_JOURNAL_EVERY_SEC: '600',

        /** 0 = выкл. Иначе снять exposure block (parity) после N мс — см. `LIVE_RECONCILE_BLOCK_MAX_MS` в config. */
        LIVE_RECONCILE_BLOCK_MAX_MS: '0',
        /** Live `buy_open`: не покупать mint, если на кошельке уже ≥ этой оценки USD (баланс × цена). 0 = выкл. */
        LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD: '30',
        /** После `live_position_close`: через N мс дожать остаток mint на кошельке (`sell_full`). 0 = выкл. */
        LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS: '60000',
        /** Partial exit: flush wallet when remainder est. USD below threshold. Post-close always flushes. */
        LIVE_TAIL_FLUSH_THRESHOLD_USD: '100',

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
     * HyperLiquid Oscar dip-buy perp bot � live alts (HL_OSCAR_LIVE_ENABLED=1).
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
     * HyperLiquid Oscar Majors — BTC+ETH knife Mode A (live on VPS).
     * Env overrides: HL_MAJORS_* in `.env`.
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
     * Unified watchdog: live-oscar + the two funded 8zkg copy lanes.
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
        /** 1.11.675 — page every 5m on missing/stale (PM2 wipe killed watch at 20:11). */
        STRATEGY_PROCESS_WATCH_ALERT_REPEAT_MIN: '5',
        /** 1.11.685 — Oscar trading = mild-dip only (8zkg twins retired). */
        STRATEGY_PROCESS_WATCH_TARGETS: JSON.stringify([]),
      },
    },
    /**
     * Copy-leader lane — shares live-oscar-micro wallet; leader `498SW…`.
     * 1.11.660 — fully off with live-oscar (no RPC/Dex). Re-enable: remove from
     * OSCAR_VPS_EXCLUDED_APPS + autostart/autorestart true + watch targets.
     */
    {
      name: 'copy-trader',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/copy-trader.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autostart: false,
      autorestart: false,
      max_restarts: 30,
      restart_delay: 8000,
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        ...JUPITER_PRO_TRADING_ENV,
        ...PM2_SOLANA_RPC_ENV,
        ...DEX_QUOTE_CACHE_ENV,
        NODE_ENV: 'production',
        COPY_TRADER_STRICT_ISOLATION: '1',
        COPY_TRADER_SHARED_OSCAR_WALLET: '1',
        COPY_TRADER_EXIT_MODE: 'mirror',
        COPY_TRADER_SPARE_CAPITAL_GATE: '0',
        COPY_TRADER_WALLET_SECRET: path.join(root, 'data/live/live-oscar-micro.keypair.json'),
        COPY_TRADER_WALLET_PUBKEY: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
        COPY_TRADER_TARGET_WALLET: '498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma',
        COPY_TRADER_TARGET_WALLET_PATH: path.join(root, 'data/copytrader/target-wallet.txt'),
        COPY_TRADER_EXECUTION_MODE: 'live',
        /** Bag-ratio entry owns sizing; classic first-buy mirror off. */
        COPY_TRADER_INITIAL_MIRROR_RATIO: '0',
        COPY_TRADER_POSITION_USD: '500',
        COPY_TRADER_ENTRY_PROBE_FRACTION: '1',
        COPY_TRADER_ENTRY_DIP_DISCOUNT_PCT: '0',
        COPY_TRADER_MAX_POSITION_USD: '0',
        COPY_TRADER_MAX_ADDS_PER_MINT: '0',
        COPY_TRADER_MAX_OPEN_POSITIONS: '0',
        COPY_TRADER_MIN_PROPORTIONAL_ADD_USD: '0',
        COPY_TRADER_BUY_DELAY_MS: '5000',
        COPY_TRADER_ENTRY_PROBE_BUY_DELAY_MS: '0',
        COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT: '3',
        COPY_TRADER_ADD_PRICE_MAX_PREMIUM_PCT: '0',
        COPY_TRADER_ALLOW_LATE_ENTRY_ON_LEADER_REBUY: '1',
        /**
         * 1.11.652 — enter only when leader averages (not first buy);
         * our clip = 70% of his total bag after that add. No further adds.
         */
        COPY_TRADER_ENTER_ONLY_ON_LEADER_ADD: '1',
        COPY_TRADER_ENTER_ON_LEADER_ADD_BAG_RATIO: '0.7',
        /** 1.11.666 — keep early TP off if this lane is ever re-enabled. */
        COPY_TRADER_MIRROR_EARLY_TP_GAIN_PCT: '0',
        /** 1.11.672 — vol-fade / hold-cap OFF (5h CF: early exits hurt vs leader). */
        COPY_TRADER_VOL_FADE_CHECK_INTERVAL_MS: '0',
        COPY_TRADER_VOL_FADE_MIN_VOLUME_5M_USD: '0',
        COPY_TRADER_VOL_FADE_DROP_PCT: '0',
        COPY_TRADER_MIRROR_HOLD_CAP_MS: '0',
        COPY_TRADER_MIRROR_HOLD_CAP_VOL_OK_MS: '0',
        COPY_TRADER_MIN_MCAP_USD: '0',
        COPY_TRADER_ENTRY_FULL_MCAP_USD: '0',
        COPY_TRADER_ENTRY_MID_POSITION_USD: '500',
        COPY_TRADER_ENTRY_MID_LEG_USD: '500',
        COPY_TRADER_BUY_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_BUY_RETRY_DEFER_LOG_MS: '60000',
        COPY_TRADER_SELL_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_SELL_RETRY_INTERVAL_MS: '3000',
        COPY_TRADER_SELL_RETRY_DEFER_LOG_MS: '30000',
        COPY_TRADER_MIN_SELL_INTERVAL_MS: '500',
        COPY_TRADER_ENTRY_DIP_JUPITER_MIN_INTERVAL_MS: '0',
        COPY_TRADER_ENTRY_DIP_USE_JUPITER: '0',
        COPY_TRADER_MIN_PROPORTIONAL_SELL_FRACTION: '0',
        COPY_TRADER_SELL_DELAY_MIN_MS: '0',
        COPY_TRADER_SELL_DELAY_MAX_MS: '2000',
        /** 5s — Helius Developer 10M/mo budget; 1–3s polls burned Free/Dev alone. */
        COPY_TRADER_POLL_INTERVAL_MS: '5000',
        COPY_TRADER_TICK_INTERVAL_MS: '1000',
        COPY_TRADER_SLIPPAGE_BPS: '100',
        COPY_TRADER_JOURNAL_PATH: path.join(root, 'data/copytrader/journal.jsonl'),
        COPY_TRADER_STATE_PATH: path.join(root, 'data/copytrader/state.json'),
        COPY_TRADER_TELEGRAM_ENABLED: '0',
        LIVE_COPY_LEADER_STATE_PATH: path.join(root, 'data/copytrader/state.json'),
        LIVE_COPY_LEADER_ATTRIBUTION_ENABLED: '1',
        PAPER_DISCOVERY_MIN_MARKET_CAP_USD: '3000000',
        PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED: '0',
        PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED: '0',
        /** Same Helius path as live-oscar (Alchemy monthly cap). */
        ...LIVE_OSCAR_HELIUS_RPC_ENV,
        ...(HELIUS_RPC_URL_PM2 ? { COPY_TRADER_RPC_URL: HELIUS_RPC_URL_PM2 } : {}),
      },
    },
    /**
     * Copy lane — leader `8zkgFGVZ`, own wallet, own state, no Oscar handoff.
     *
     * Orthogonal A/B vs `copy-trader-8zkg-mirror`: this lane filters on **mcap ≥ $150k**.
     * Sell delay: 0 unless mark already down >5% vs entry, then wait max **15s**.
     * Twin (vol5m): same skip rule, max **30s** when down >5%.
     */
    {
      name: 'copy-trader-8zkg',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/copy-trader.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      /** 1.11.685 — retired on Oscar; kept in file for history, excluded from PM2 export. */
      autostart: false,
      autorestart: false,
      max_restarts: 30,
      restart_delay: 8000,
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        ...JUPITER_PRO_TRADING_ENV,
        ...PM2_SOLANA_RPC_ENV,
        ...DEX_QUOTE_CACHE_ENV,
        NODE_ENV: 'production',
        COPY_TRADER_APP_NAME: 'copy-trader-8zkg',
        COPY_TRADER_STRICT_ISOLATION: '1',
        /** Dedicated wallet — no shared ATAs or SOL pool with live-oscar. */
        COPY_TRADER_SHARED_OSCAR_WALLET: '0',
        COPY_TRADER_SPARE_CAPITAL_GATE: '0',
        COPY_TRADER_WALLET_SECRET: path.join(root, 'data/live/copy-8zkg.keypair.json'),
        COPY_TRADER_WALLET_PUBKEY: 'FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX',
        COPY_TRADER_TARGET_WALLET: '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
        /** Fund trades in USDC — $100 stays $100 regardless of where SOL trades. */
        COPY_TRADER_QUOTE_MINT: 'USDC',
        /** Native SOL is still needed for priority fees + ATA rent. */
        COPY_TRADER_MIN_FEE_SOL_RESERVE: '0.02',
        COPY_TRADER_TARGET_WALLET_PATH: path.join(root, 'data/copytrader-8zkg/target-wallet.txt'),
        COPY_TRADER_JOURNAL_PATH: path.join(root, 'data/copytrader-8zkg/journal.jsonl'),
        COPY_TRADER_STATE_PATH: path.join(root, 'data/copytrader-8zkg/state.json'),
        COPY_TRADER_EXECUTION_MODE: 'live',
        /** Oscar never adopts this lane — mirror owns the exit end to end. */
        LIVE_COPY_LEADER_ATTRIBUTION_ENABLED: '0',
        /**
         * ≥$300k: 80% of leader buy, floor $200, ceiling $700.
         * Fixed clips (this lane only, 1.11.674):
         *   $100k–$200k → $50; $200k–$300k → $100.
         */
        COPY_TRADER_INITIAL_MIRROR_RATIO: '0.8',
        COPY_TRADER_MIN_MIRROR_ENTRY_USD: '200',
        COPY_TRADER_POSITION_USD: '200',
        COPY_TRADER_ENTRY_FULL_MCAP_USD: '0',
        COPY_TRADER_ENTRY_MID_POSITION_USD: '200',
        COPY_TRADER_ENTRY_MID_LEG_USD: '200',
        /** Tier-1: mcap ∈ [$100k, $200k) → $50 fixed. */
        COPY_TRADER_ENTRY_LOW_MCAP_MIN_USD: '100000',
        COPY_TRADER_ENTRY_LOW_MCAP_MAX_USD: '200000',
        COPY_TRADER_ENTRY_LOW_POSITION_USD: '50',
        /** Tier-2: mcap ∈ [$200k, $300k) → $100 fixed. */
        COPY_TRADER_ENTRY_LOW2_MCAP_MIN_USD: '200000',
        COPY_TRADER_ENTRY_LOW2_MCAP_MAX_USD: '300000',
        COPY_TRADER_ENTRY_LOW2_POSITION_USD: '100',
        COPY_TRADER_ENTRY_PROBE_FRACTION: '1',
        COPY_TRADER_ENTRY_DIP_DISCOUNT_PCT: '0',
        COPY_TRADER_ENTRY_DIP_USE_JUPITER: '0',
        COPY_TRADER_MAX_POSITION_USD: '700',
        COPY_TRADER_MAX_ADDS_PER_MINT: '0',
        COPY_TRADER_MIN_PROPORTIONAL_ADD_USD: '200',
        COPY_TRADER_MAX_OPEN_POSITIONS: '8',
        /** Allow entry on leader rebuy/average-down even if we missed his first fill. */
        COPY_TRADER_ALLOW_LATE_ENTRY_ON_LEADER_REBUY: '1',
        /**
         * Orthogonal A/B vs `copy-trader-8zkg-mirror`:
         * this lane = **mcap-only** (≥$100k; full size ≥$300k) + **fast** mirror exit.
         * Twin = vol5m + same mcap/sizing. Shared: pair age ≥0.1h, premium ≤5%.
         */
        COPY_TRADER_LEADER_GATES: '1',
        COPY_TRADER_MIN_LEADER_PRIOR_SESSIONS: '0',
        COPY_TRADER_MIN_LEADER_PRIOR_AVG_PCT: '-100',
        COPY_TRADER_ENTRY_MIN_PAIR_AGE_HOURS: '0.1',
        COPY_TRADER_ENTRY_MAX_PAIR_AGE_HOURS: '0',
        COPY_TRADER_ENTRY_MIN_TURNOVER_5M: '0',
        COPY_TRADER_ENTRY_MIN_VOL_TO_MCAP_1H: '0',
        /** Off — twin owns the volume axis. */
        COPY_TRADER_ENTRY_MIN_VOLUME_5M_USD: '0',
        COPY_TRADER_ENTRY_MIN_BUY_SELL_5M: '0',
        COPY_TRADER_ENTRY_MAX_CHASE_5M_PCT: '0',
        COPY_TRADER_MIN_LEADER_BUY_USD: '0',
        COPY_TRADER_MIN_LIQUIDITY_USD: '0',
        COPY_TRADER_MIN_MCAP_USD: '100000',
        /**
         * Shadow select (1.11.666): score every leader entry buy with
         * vol5m≥$2k & buys/sells≥1 → target ~76% recall / ~4× lift.
         * FILTER_LIVE=0 → journal only, does not change fills yet.
         */
        COPY_TRADER_SHADOW_SELECT: '1',
        COPY_TRADER_SHADOW_SELECT_FILTER_LIVE: '0',
        COPY_TRADER_SHADOW_SELECT_MIN_VOLUME_5M_USD: '2000',
        COPY_TRADER_SHADOW_SELECT_MIN_BUY_SELL_5M: '1',
        COPY_TRADER_SHADOW_SELECT_MIN_MCAP_USD: '0',
        COPY_TRADER_SHADOW_SELECT_MIN_LIQ_USD: '0',
        COPY_TRADER_SHADOW_SELECT_REQUIRE_CTX: '1',
        COPY_TRADER_SHADOW_SELECT_SUMMARY_MS: '600000',
        /** Both lanes mirror leader sells; this one races (delay 0). */
        COPY_TRADER_EXIT_MODE: 'mirror',
        /**
         * Helius LaserStream WS for leader ingress (tokenAccounts balanceChanged).
         * 1.11.669 — poll backup 1.5s (was 5s). Silent WS + 5s backup = Am8i +17s detect.
         */
        COPY_TRADER_POLL_INTERVAL_MS: '1500',
        COPY_TRADER_LEADER_STREAM: '1',
        COPY_TRADER_LEADER_STREAM_POLL_BACKUP_MS: '1500',
        /** Watchdog: if stream dies / misses poll, keep 1.5s poll + reconnect. */
        COPY_TRADER_LEADER_STREAM_FAST_POLL_MS: '1500',
        /** First poll miss while stream silent → fast path (was 5 × 5s = 25s). */
        COPY_TRADER_LEADER_STREAM_MISS_THRESHOLD: '1',
        COPY_TRADER_LEADER_INGRESS_CONCURRENCY: '4',
        ...(HELIUS_API_KEY_PM2 ? { HELIUS_API_KEY: HELIUS_API_KEY_PM2 } : {}),
        ...(HELIUS_RPC_URL_PM2
          ? { HELIUS_RPC_URL: HELIUS_RPC_URL_PM2, COPY_TRADER_RPC_URL: HELIUS_RPC_URL_PM2 }
          : {}),
        COPY_TRADER_TICK_INTERVAL_MS: '1000',
        COPY_TRADER_BUY_DELAY_MS: '0',
        COPY_TRADER_ENTRY_PROBE_BUY_DELAY_MS: '0',
        /**
         * Hard premium cap vs the leader fill. Above 5% we do not buy — we keep
         * retrying until the quote cools or the leader starts exiting
         * (leaderHoldingsShrunkSinceSignal). No first-shot widen.
         */
        COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT: '5',
        COPY_TRADER_QUOTE_PREMIUM_GUARD_PCT: '5',
        COPY_TRADER_QUOTE_PREMIUM_FIRST_SHOT_PCT: '0',
        COPY_TRADER_QUOTE_PREMIUM_GRACE_MS: '0',
        /** Long window; the real stop for a premium-blocked entry is "leader sold". */
        COPY_TRADER_BUY_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_BUY_RETRY_DEFER_LOG_MS: '30000',
        /** 2s re-quote — 500ms burned Helius sims while premium-blocked. */
        COPY_TRADER_BUY_RETRY_INTERVAL_MS: '2000',
        COPY_TRADER_SELL_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_SELL_RETRY_INTERVAL_MS: '3000',
        COPY_TRADER_SELL_RETRY_DEFER_LOG_MS: '30000',
        COPY_TRADER_MIN_SELL_INTERVAL_MS: '500',
        COPY_TRADER_MIN_PROPORTIONAL_SELL_FRACTION: '0',
        /**
         * Conditional sell delay: immediate unless mark is already down >5% vs entry;
         * then wait up to 15s and sell anyway.
         */
        COPY_TRADER_SELL_DELAY_MIN_MS: '0',
        COPY_TRADER_SELL_DELAY_MAX_MS: '0',
        COPY_TRADER_SELL_DELAY_SKIP_MAX_DROP_PCT: '5',
        /**
         * 1.11.666 — OFF. 12h CF: +20%/50% early peel hurt ~$114 vs holding to exit.
         * Keep GAIN_PCT=0 so reload cannot revive the feature.
         */
        COPY_TRADER_MIRROR_EARLY_TP_GAIN_PCT: '0',
        COPY_TRADER_MIRROR_EARLY_TP_SELL_FRACTION: '0.5',
        COPY_TRADER_MIRROR_EARLY_TP_TICK_INTERVAL_MS: '5000',
        /**
         * 1.11.672 — OFF. 5h CF: vol-fade + hold-cap cost ~$300+ vs hold-to-leader.
         * Exit only with the leader (and existing sell-delay / abandoned-sell paths).
         */
        COPY_TRADER_VOL_FADE_CHECK_INTERVAL_MS: '0',
        COPY_TRADER_VOL_FADE_MIN_VOLUME_5M_USD: '0',
        COPY_TRADER_VOL_FADE_DROP_PCT: '0',
        COPY_TRADER_MIRROR_HOLD_CAP_MS: '0',
        COPY_TRADER_MIRROR_HOLD_CAP_VOL_OK_MS: '0',
        COPY_TRADER_LEADER_FOLLOW_ONLY_MIN_MCAP_USD: '1000000',
        COPY_TRADER_LEADER_FOLLOW_ONLY_MIN_VOLUME_1H_USD: '50000',
        /** Control lane — wide 300bps. Economy A/B is on mirror (Oscar 10bps + guards). */
        COPY_TRADER_SLIPPAGE_BPS: '300',
        COPY_TRADER_TELEGRAM_ENABLED: '1',
        /** 1.11.671 — ops alerts only (no trade pings / yellow stream flags). */
        COPY_TRADER_TELEGRAM_TRADE_PINGS: '0',
        COPY_TRADER_TELEGRAM_STREAM_NOISE: '0',
        COPY_TRADER_TELEGRAM_OPS_ALERTS: '1',
        COPY_TRADER_OPS_WATCH_ENABLED: '1',
        COPY_TRADER_OPS_LEADER_IDLE_ALERT_MS: '21600000',
        COPY_TRADER_OPS_BUY_STALL_ALERT_MS: '7200000',
        COPY_TRADER_OPS_STUCK_SELL_ALERT_MS: '1800000',
        COPY_TRADER_OPS_STREAM_DEAD_ALERT_MS: '900000',
        COPY_TRADER_OPS_ALERT_COOLDOWN_MS: '3600000',
        ...SOLANA_RPC_ALCHEMY_ONLY_ENV,
      },
    },
    {
      /**
       * Twin of `copy-trader-8zkg` on the same leader: **vol5m-only** entry (≥$8k).
       * 1.11.670 — Oscar economy execution (10bps + quality guards).
       */
      name: 'copy-trader-8zkg-mirror',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/copy-trader.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      /** 1.11.685 — retired on Oscar; excluded from PM2 export. */
      autostart: false,
      autorestart: false,
      max_restarts: 30,
      restart_delay: 8000,
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        ...JUPITER_PRO_TRADING_ENV,
        ...PM2_SOLANA_RPC_ENV,
        ...DEX_QUOTE_CACHE_ENV,
        NODE_ENV: 'production',
        COPY_TRADER_APP_NAME: 'copy-trader-8zkg-mirror',
        COPY_TRADER_STRICT_ISOLATION: '1',
        COPY_TRADER_SHARED_OSCAR_WALLET: '0',
        COPY_TRADER_SPARE_CAPITAL_GATE: '0',
        /**
         * The microcap-scalper's wallet, handed over with its funds. That lane had been parked
         * since midday — its entries kept missing the price corridor — so its capital was sitting
         * idle while this lane had none. One funded wallet is worth more than two empty ones.
         */
        COPY_TRADER_WALLET_SECRET: path.join(root, 'data/live/mcs-wallet.json'),
        COPY_TRADER_WALLET_PUBKEY: '2fMzAm6aTCAPrXjamCLRbjLRxEqrcD7zLdN2wNdaL7Ps',
        COPY_TRADER_TARGET_WALLET: '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
        COPY_TRADER_QUOTE_MINT: 'USDC',
        COPY_TRADER_MIN_FEE_SOL_RESERVE: '0.02',
        COPY_TRADER_TARGET_WALLET_PATH: path.join(root, 'data/copytrader-8zkg-mirror/target-wallet.txt'),
        COPY_TRADER_JOURNAL_PATH: path.join(root, 'data/copytrader-8zkg-mirror/journal.jsonl'),
        COPY_TRADER_STATE_PATH: path.join(root, 'data/copytrader-8zkg-mirror/state.json'),
        COPY_TRADER_EXECUTION_MODE: 'live',
        /** Oscar never adopts this lane — the leader owns the exit end to end. */
        LIVE_COPY_LEADER_ATTRIBUTION_ENABLED: '0',
        /**
         * Same sizing as twin: ≥$300k → 80% leader, floor $200, cap $700;
         * $150k–$300k → $50 stats clip; exits stay fraction-of-holdings mirror.
         */
        COPY_TRADER_INITIAL_MIRROR_RATIO: '0.8',
        COPY_TRADER_MIN_MIRROR_ENTRY_USD: '200',
        COPY_TRADER_POSITION_USD: '200',
        COPY_TRADER_ENTRY_FULL_MCAP_USD: '0',
        COPY_TRADER_ENTRY_MID_POSITION_USD: '200',
        COPY_TRADER_ENTRY_MID_LEG_USD: '200',
        /** Stats tier: same as twin — mcap ∈ [$150k, $300k) → $50. */
        COPY_TRADER_ENTRY_LOW_MCAP_MIN_USD: '150000',
        COPY_TRADER_ENTRY_LOW_MCAP_MAX_USD: '300000',
        COPY_TRADER_ENTRY_LOW_POSITION_USD: '50',
        COPY_TRADER_ENTRY_PROBE_FRACTION: '1',
        COPY_TRADER_ENTRY_DIP_DISCOUNT_PCT: '0',
        COPY_TRADER_ENTRY_DIP_USE_JUPITER: '0',
        /** Same ceiling as twin. */
        COPY_TRADER_MAX_POSITION_USD: '700',
        COPY_TRADER_MAX_ADDS_PER_MINT: '0',
        COPY_TRADER_MIN_PROPORTIONAL_ADD_USD: '200',
        COPY_TRADER_MAX_OPEN_POSITIONS: '8',
        /** Same as twin: enter on average-down / rebuy if we missed his open. */
        COPY_TRADER_ALLOW_LATE_ENTRY_ON_LEADER_REBUY: '1',
        /**
         * Orthogonal B: vol5m (≥$8k) + same mcap floor/sizing as twin (1.11.665).
         * Missing volume feed fails closed.
         */
        COPY_TRADER_LEADER_GATES: '1',
        COPY_TRADER_MIN_LEADER_PRIOR_SESSIONS: '0',
        COPY_TRADER_MIN_LEADER_PRIOR_AVG_PCT: '-100',
        COPY_TRADER_ENTRY_MIN_PAIR_AGE_HOURS: '0.1',
        COPY_TRADER_ENTRY_MAX_PAIR_AGE_HOURS: '0',
        COPY_TRADER_ENTRY_MIN_TURNOVER_5M: '0',
        COPY_TRADER_ENTRY_MIN_VOL_TO_MCAP_1H: '0',
        COPY_TRADER_ENTRY_MIN_VOLUME_5M_USD: '8000',
        COPY_TRADER_ENTRY_MIN_BUY_SELL_5M: '0',
        COPY_TRADER_ENTRY_MAX_CHASE_5M_PCT: '0',
        COPY_TRADER_MIN_LEADER_BUY_USD: '0',
        COPY_TRADER_MIN_LIQUIDITY_USD: '0',
        COPY_TRADER_MIN_MCAP_USD: '150000',
        /** Same shadow select as twin (paper; FILTER_LIVE off). */
        COPY_TRADER_SHADOW_SELECT: '1',
        COPY_TRADER_SHADOW_SELECT_FILTER_LIVE: '0',
        COPY_TRADER_SHADOW_SELECT_MIN_VOLUME_5M_USD: '2000',
        COPY_TRADER_SHADOW_SELECT_MIN_BUY_SELL_5M: '1',
        COPY_TRADER_SHADOW_SELECT_MIN_MCAP_USD: '0',
        COPY_TRADER_SHADOW_SELECT_MIN_LIQ_USD: '0',
        COPY_TRADER_SHADOW_SELECT_REQUIRE_CTX: '1',
        COPY_TRADER_SHADOW_SELECT_SUMMARY_MS: '600000',
        /** His sell is the only exit: no trail, no time cap, no stop. */
        COPY_TRADER_EXIT_MODE: 'mirror',
        /** Same Helius stream as FxQf — 1.11.669: missThreshold 1 + silent-stream reconnect. */
        COPY_TRADER_POLL_INTERVAL_MS: '1500',
        COPY_TRADER_LEADER_STREAM: '1',
        COPY_TRADER_LEADER_STREAM_POLL_BACKUP_MS: '1500',
        COPY_TRADER_LEADER_STREAM_FAST_POLL_MS: '1500',
        COPY_TRADER_LEADER_STREAM_MISS_THRESHOLD: '1',
        COPY_TRADER_LEADER_INGRESS_CONCURRENCY: '4',
        ...(HELIUS_API_KEY_PM2 ? { HELIUS_API_KEY: HELIUS_API_KEY_PM2 } : {}),
        ...(HELIUS_RPC_URL_PM2
          ? { HELIUS_RPC_URL: HELIUS_RPC_URL_PM2, COPY_TRADER_RPC_URL: HELIUS_RPC_URL_PM2 }
          : {}),
        COPY_TRADER_TICK_INTERVAL_MS: '1000',
        /** No intentional buy lag — chase the leader fill before the tape runs. */
        COPY_TRADER_BUY_DELAY_MS: '0',
        COPY_TRADER_BUY_DELAY_SKIP_MAX_PREMIUM_PCT: '0',
        COPY_TRADER_ENTRY_PROBE_BUY_DELAY_MS: '0',
        /** Shared premium policy with the twin: hard 5%, retry until leader exits. */
        COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT: '5',
        COPY_TRADER_QUOTE_PREMIUM_GUARD_PCT: '5',
        COPY_TRADER_QUOTE_PREMIUM_FIRST_SHOT_PCT: '0',
        COPY_TRADER_QUOTE_PREMIUM_GRACE_MS: '0',
        COPY_TRADER_BUY_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_BUY_RETRY_DEFER_LOG_MS: '30000',
        COPY_TRADER_BUY_RETRY_INTERVAL_MS: '2000',
        /**
         * An exit must not be abandoned while the position is still worth something, so the sell
         * window is long and the retries patient.
         */
        COPY_TRADER_SELL_RETRY_WINDOW_MS: '7200000',
        COPY_TRADER_SELL_RETRY_INTERVAL_MS: '3000',
        COPY_TRADER_SELL_RETRY_DEFER_LOG_MS: '30000',
        COPY_TRADER_MIN_SELL_INTERVAL_MS: '500',
        COPY_TRADER_MIN_PROPORTIONAL_SELL_FRACTION: '0',
        /** Sell immediately on leader exit — no intentional delay. */
        COPY_TRADER_SELL_DELAY_MIN_MS: '0',
        COPY_TRADER_SELL_DELAY_MAX_MS: '0',
        COPY_TRADER_SELL_DELAY_SKIP_MAX_DROP_PCT: '5',
        /**
         * 1.11.672 — OFF (same as mcap twin). 5h CF: early vol exits hurt vs leader.
         */
        COPY_TRADER_VOL_FADE_CHECK_INTERVAL_MS: '0',
        COPY_TRADER_VOL_FADE_MIN_VOLUME_5M_USD: '0',
        COPY_TRADER_VOL_FADE_DROP_PCT: '0',
        COPY_TRADER_MIRROR_HOLD_CAP_MS: '0',
        COPY_TRADER_MIRROR_HOLD_CAP_VOL_OK_MS: '0',
        COPY_TRADER_LEADER_FOLLOW_ONLY_MIN_MCAP_USD: '1000000',
        COPY_TRADER_LEADER_FOLLOW_ONLY_MIN_VOLUME_1H_USD: '50000',
        /**
         * 1.11.666 — OFF (same as mcap lane). Do not set GAIN_PCT > 0 without CF.
         */
        COPY_TRADER_MIRROR_EARLY_TP_GAIN_PCT: '0',
        COPY_TRADER_MIRROR_EARLY_TP_SELL_FRACTION: '0.5',
        COPY_TRADER_MIRROR_EARLY_TP_TICK_INTERVAL_MS: '5000',
        /**
         * 1.11.670 — Oscar economy lane (real): base 10bps + bump≤100, BUT refuse
         * worse fills (Am8i −3% tokens). Control twin stays at 300.
         * - impact >4% blocked; chase >2% vs first quote aborted
         * - outAmount may not regress >1.5% vs best quote in the ladder
         */
        COPY_TRADER_SLIPPAGE_BPS: '10',
        LIVE_BUY_SIM_RETRY_ATTEMPTS: '10',
        LIVE_BUY_SIM_RETRY_DELAY_MS: '800',
        LIVE_BUY_SIM_SLIPPAGE_RETRY_ATTEMPTS: '8',
        LIVE_SELL_SIM_RETRY_ATTEMPTS: '12',
        LIVE_SELL_SIM_RETRY_DELAY_MS: '1000',
        LIVE_SELL_SIM_SLIPPAGE_RETRY_ATTEMPTS: '12',
        LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS: '10',
        LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS: '100',
        LIVE_BUY_MAX_PRICE_IMPACT_PCT: '4',
        LIVE_BUY_MAX_CHASE_PCT: '2',
        COPY_TRADER_MAX_QUOTE_REGRESSION_PCT: '1.5',
        COPY_TRADER_TELEGRAM_ENABLED: '1',
        /** 1.11.671 — ops alerts only (same as mcap twin). */
        COPY_TRADER_TELEGRAM_TRADE_PINGS: '0',
        COPY_TRADER_TELEGRAM_STREAM_NOISE: '0',
        COPY_TRADER_TELEGRAM_OPS_ALERTS: '1',
        COPY_TRADER_OPS_WATCH_ENABLED: '1',
        COPY_TRADER_OPS_LEADER_IDLE_ALERT_MS: '21600000',
        COPY_TRADER_OPS_BUY_STALL_ALERT_MS: '7200000',
        COPY_TRADER_OPS_STUCK_SELL_ALERT_MS: '1800000',
        COPY_TRADER_OPS_STREAM_DEAD_ALERT_MS: '900000',
        COPY_TRADER_OPS_ALERT_COOLDOWN_MS: '3600000',
        ...SOLANA_RPC_ALCHEMY_ONLY_ENV,
      },
    },
    /**
     * EVM pulse journals (72.62.152.201 → local data/) for `/papertrader2` tiles 5–6.
     * Runs rsync as root (SSH key in /root/.ssh); salpha has passwordless sudo on sync scripts.
     */
    {
      name: 'basepulse-journal-sync',
      cwd: root,
      script: 'scripts/basepulse-journal-sync-loop.sh',
      interpreter: 'bash',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        BPULSE_SYNC_INTERVAL_SEC: '30',
      },
    },
    {
      name: 'bscpulse-journal-sync',
      cwd: root,
      script: 'scripts/bscpulse-journal-sync-loop.sh',
      interpreter: 'bash',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        BSCPULSE_SYNC_INTERVAL_SEC: '30',
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
    /**
     * Mild-dip test lane (USDC) — live-oscar-micro wallet.
     * Entry: DexScreener pc5m ∈ (−25, −8]; clips $10 base / $20 thick
     * (mcap≥$100k / liq≥$50k / age≥6h). Micro $15k–$50k @ $5 only on
     * knife_stabilize (1.11.746); global mcap floor $50k.
     * Exit: arm MFE +5% → half-first giveback / full after scale-out.
     * Start: `pm2 start ecosystem.config.cjs --only mild-dip-bot` (live).
     */
    {
      name: 'mild-dip-bot',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/mild-dip-bot.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autostart: true,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 8000,
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        ...JUPITER_PRO_TRADING_ENV,
        /**
         * 1.11.686 — sole Jupiter consumer on Oscar (copy twins retired).
         * Developer ~10 RPS org limit; keep 1 RPS headroom.
         */
        JUPITER_GLOBAL_MAX_RPS: '9',
        ...PM2_SOLANA_RPC_ENV,
        ...DEX_QUOTE_CACHE_ENV,
        /** Full Dex 120 RPM gate — was missing → code default 42 RPM. */
        ...DEXSCREENER_GATE_ENV,
        NODE_ENV: 'production',
        MILD_DIP_APP_NAME: 'mild-dip-bot',
        MILD_DIP_EXECUTION_MODE: 'live',
        MILD_DIP_TAPE_GREEN_MEASURE_ALL: '1',
        MILD_DIP_TAPE_GREEN_MEASURE_ALL_MIN_INTERVAL_MS: '300000',
        MILD_DIP_TAPE_GREEN_MEASURE_ALL_MAX_SIGNALS_PER_HOUR: '1500',
        MILD_DIP_TAPE_STRUCTURAL_FETCH_MAX_PER_HOUR: '400',
        MILD_DIP_TAPE_PENDING_SAMPLE_MAX_MINTS: '400',
        MILD_DIP_TAPE_STRUCTURAL_BATCH_MS: '20000',
        MILD_DIP_TAPE_STRUCTURAL_BATCH_MAX_PER_HOUR: '200',
        MILD_DIP_TAPE_PATH_MAX_POINTS: '60',
        MILD_DIP_TAPE_EXIT_ARM_PCT: '10',
        MILD_DIP_TAPE_EXIT_TRAIL_PCT: '9',
        MILD_DIP_TAPE_EXIT_STOP_PCT: '-30',
        MILD_DIP_TAPE_EXIT_TIMEOUT_MS: '3600000',
        MILD_DIP_WALLET_SECRET: path.join(root, 'data/live/live-oscar-micro.keypair.json'),
        MILD_DIP_WALLET_PUBKEY: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
        /** 1.11.742 — base clip $10 (was $5). */
        /** 1.11.754 — flat $30 across base / thick / micro. */
        /** 1.11.763 — flat $5 across base / thick / micro. */
        /** 1.11.790 — flat $2 across base / thick / micro. */
        /** 1.11.812 — flat $10 across base / thick / micro. */
        /** 1.11.813 — flat $2 across base / thick / micro. */
        /** 1.11.814 — flat $10 across base / thick / micro. */
        /** 1.11.820 — flat $2 across base / thick / micro. */
        /** 1.11.825 — flat $10 across base / thick / micro. */
        /** 1.11.828 — flat $5 across base / thick / micro. */
        /** 1.11.839 — flat $2 across base / thick / micro. */
        /** 1.11.841 — flat $1 across base / thick / micro. */
        MILD_DIP_POSITION_USD: '3',
        /**
         * 1.11.925 — liquidity power law (leader shape, our clip book).
         * Leader: sizeUsd ≈ 0.0387 × liq^0.866 (24h observer fit).
         * Ours: clamp($1, $30, coef × liq^0.866) with coef = 1 / 8000^0.866
         * so the $8k entry floor maps to ~$1 and deep pools cap at $30 (~500k+ liq).
         * coef ≈ 0.0108 × leader (1.08% of leader notional).
         * 1.11.976 — coef ×4.5: quote impact is flat between $1 and $10 clips
         * (4065 live entries), so the curve now maps our median $20k pool to
         * ~$10, $50k to ~$22 and caps at $30 above ~$100k.
         */
        MILD_DIP_SIZE_LIQ_POWER_COEF: '0.001888',
        MILD_DIP_SIZE_LIQ_POWER_EXP: '0.866',
        /** 1.11.976 — preserve the sizing law, but never send a live clip below $5. */
        MILD_DIP_SIZE_MIN_USD: '5',
        MILD_DIP_SIZE_MAX_USD: '30',
        /**
         * 1.11.1025 — with staged adds disabled, the former new-bag first clip
         * no longer flattens every entry to $5; the first-touch cap and
         * liquidity curve determine the initial size. Add settings remain
         * configurable for rollback, currently with ADD_MAX_USD=0.
         */
        MILD_DIP_STAGED_ENTRY_ENABLED: '0',
        MILD_DIP_STAGED_FIRST_USD: '5',
        MILD_DIP_STAGED_ADD_TRIGGER_PCT: '8',
        MILD_DIP_STAGED_ADD_MAX_CHASE_PCT: '2',
        MILD_DIP_STAGED_ADD_ANCHOR: 'trough',
        MILD_DIP_STAGED_ADD_TROUGH_TRIGGER_PCT: '8',
        MILD_DIP_STAGED_ADD_TROUGH_BAND_PCT: '4',
        MILD_DIP_STAGED_ADD_MIN_TROUGH_AGE_MS: '60000',
        MILD_DIP_STAGED_ADD_MULT: '2',
        /**
         * 1.11.999 — cut adds while retaining the $5 first clip. Factual-dollar
         * 7d cycles: $0–4 −$242.6, $4–6 +$669.0, $6–12 −$18.5,
         * $12–25 −$55.2, $25+ −$28.6; leader clips $75–200 +5.42/$100,
         * $600–5000 −4.95/$100. stagedAddMaxUsd=0 returns target_filled,
         * so no add is sent and target_filled telemetry remains budget-free.
         * Rollback: MILD_DIP_STAGED_ADD_MAX_USD=40.
         */
        MILD_DIP_STAGED_ADD_MAX_USD: '0',
        /**
         * 1.11.986 — ASg9yD add filled +17.4% over first fill at the local
         * peak; chase band caps the add premium.
         * 1.11.993 — the average-cost veto is off: on 72h/1605 cycles it
         * declined 184 profit legs ($671) and turned +$345 into -$325.
         * Rollback: chase=4, avg veto=1.
         */
        MILD_DIP_STAGED_PROFIT_MIN_OVER_AVG_PCT: '0',
        MILD_DIP_STAGED_PROFIT_VETO_MAX_MS: '1800000',
        /**
         * 1.11.742 — thick size-up when structural name
         * (mcap ≥ $100k, liq ≥ $50k, pair age ≥ 6h). Off: set = base or 0.
         * 1.11.841 — same $1 as base.
         */
        MILD_DIP_THICK_POSITION_USD: '3',
        MILD_DIP_THICK_MIN_MCAP_USD: '100000',
        MILD_DIP_THICK_MIN_LIQUIDITY_USD: '50000',
        MILD_DIP_THICK_MIN_PAIR_AGE_HOURS: '6',
        /**
         * 1.11.746 — micro band, knife_stabilize only.
         * 1.11.776 — floor aligned to global $5k (was $15k–$50k).
         * 1.11.841 — clip flat $1 with base/thick (one economic tier).
         */
        MILD_DIP_MICRO_POSITION_USD: '3',
        MILD_DIP_MICRO_MIN_MCAP_USD: '5000',
        MILD_DIP_MICRO_MAX_MCAP_USD: '50000',
        /** 0 = no slot cap — spend USDC until the wallet is empty. */
        MILD_DIP_MAX_OPEN_POSITIONS: '0',
        /**
         * 1.11.702 — slightly wider knife floor (was −20). Prebuy was skipping
         * dumps that printed −25…−30 by the time the quote landed.
         */
        /**
         * 1.11.885 — the deep end pays for itself nowhere. Over 186 closed
         * positions in 11h, entries below −20% returned −2.97 USD at a 50% win
         * rate, the only band besides the shallow one in the red, and
         * `turn_dump_knife` (−2.71 on 5) sits inside it.
         */
        MILD_DIP_MIN_DIP_PCT: '-25',
        /**
         * 1.11.773 — shallow edge opened to −2 so turn→dump formula can allow
         * low-turn scrapes (8zkg p50≈4% at turn<0.05). Depth quality is
         * enforced by MILD_DIP_TURN_DUMP_GATE, not a fixed −8 floor.
         */
        /**
         * 1.11.825 — −2 → −8. The shallow band does not move: entries with
         * pc5m ∈ (−8, 0] show median MFE **3.66%** and winrate 0.36.
         * 3h window: 11 trades, −$2.24. The same bucket on the 183-trade window
         * this morning booked −$2.97 — two independent samples, same answer.
         * Deep entries are where the moves are: pc5m ≤ −25 → median MFE 54%.
         * The turn→dump OR branches still admit shallow prints when the
         * formula itself matches, so this only removes band-only seats.
         */
        /**
         * 1.11.854 — back to −3, was −8. The band was tightened in 1.11.825 on
         * an MFE study computed from our mark tape, and that tape turned out to
         * be poisoned (1.11.847 cross-mint prices, 1.11.848 stale-mark basis),
         * so the reason no longer stands. Against 3288 deduped leader buys only
         * 27.8% land inside −25…−8; 13.7% sit in −8…−3, which we were refusing.
         * Green entries (35.6% of theirs) stay out of scope for now.
         */
        /**
         * 1.11.885 — the shallow end is the largest single loss source left.
         * By entry depth over the same window: (−4,−2] returned −2.39 USD at 59%
         * and (−2,0] −2.50 USD at 52%, while every band from −20% to −4% was
         * positive at a 65–81% win rate. Fifty positions, −4.89 USD, against a
         * whole-window result of +7.01.
         *
         * This band was cut to −8 once before and reopened in 1.11.854 on data
         * the basis bugs had corrupted. Measured clean, the line is −4: (−8,−4]
         * earns, (−4,0] does not.
         */
        /**
         * 1.11.893 — a 1.5% wiggle is not a dip.
         *
         * 77rUTY78 came in at pc5m −1.53% inside an hour that was up 11%, which
         * on a chart is a green candle. By entry depth, and unlike anything else
         * tested today, this holds across every window:
         *
         *   band      last 12h      last 24h    whole journal
         *   (−2,0]      −0.079        −0.034        −0.012   USD/pos
         *   (−4,−2]     −0.047        −0.089        −0.017
         *   (−6,−4]     +0.048        +0.053        −0.007
         *   (−10,−6]    +0.133        −0.018        −0.034
         *
         * (−4,0] is the only band negative in all three, over 754 positions in
         * total. The hour trend was tested too and is not the discriminator: on
         * the clean 12h window a green hour with a real dump returns +0.051/pos,
         * so the pullback depth is what matters, not the candle colour.
         *
         * Only the ceiling moves. The floor stays at −25: the deep end was cut
         * once on 14 positions, which was not evidence, and that is reverted.
         */
        MILD_DIP_MAX_DIP_PCT: '-4',
        /**
         * Deep knife (−50, −20]: wait 2m, buy only if price stabilizes near the
         * trough or starts a controlled bounce (not the falling blade).
         */
        MILD_DIP_KNIFE_STABILIZE_ENABLED: '1',
        MILD_DIP_KNIFE_STABILIZE_MIN_DIP_PCT: '-50',
        MILD_DIP_KNIFE_STABILIZE_MAX_DIP_PCT: '-20',
        /**
         * 1.11.892 — 30s, not 120s. This gate sits in front of both paths, so a
         * knife that had already lifted 1.5–10% off its trough still had to sit
         * out the remaining minute and a half before we could look at it. The
         * bounce is the evidence that the fall stopped; waiting past it only
         * hands back the entry. The stabilize path keeps its own separate
         * requirement of `QUIET_MS` with no new trough, which is the evidence
         * that applies when there is no bounce yet.
         */
        MILD_DIP_KNIFE_STABILIZE_WAIT_MS: '30000',
        MILD_DIP_KNIFE_STABILIZE_MAX_WATCH_MS: '600000',
        MILD_DIP_KNIFE_STABILIZE_QUIET_MS: '45000',
        MILD_DIP_KNIFE_STABILIZE_BAND_PCT: '2.5',
        MILD_DIP_KNIFE_STABILIZE_MIN_BOUNCE_PCT: '1.5',
        MILD_DIP_KNIFE_STABILIZE_MAX_BOUNCE_PCT: '10',
        /**
         * 1.11.803 — wait-dip back ON, now *alongside* turn→dump: the formula
         * picks the mint, wait-dip picks the price. 8h CF on live buys: entering
         * at signal books −$33; waiting for −12% more books +$13…+$78, and our
         * fill on shared leader names was −20.2% MAE vs their −15.9%.
         */
        /**
         * 1.11.890 — off. The seat parks a dip that already qualified and buys
         * only if it falls another `WAIT_DIP_PCT`, which selects for continuation:
         * we fill precisely when the price keeps going down.
         *
         * Over 6h, 448 seats parked and 304 expired, so 68% of the dips we found
         * were never traded. What those were worth is readable from the leader
         * corpus, taking leader bags opened on the same mint within a minute of
         * our seat — buying the dip we saw instead of waiting for a better one:
         *
         *                        expired (skipped)   filled (waited)
         *   median final              +10.74%            −0.29%
         *   ended >= 0                    70%               50%
         *   median peak               +23.74%           +11.47%
         *   reached +8%                   74%               62%
         *   median drawdown            −6.75%           −13.48%
         *   went below −25%               16%               37%
         *
         * (90 and 125 matched bags; at a ±60s window the gap is wider still,
         * +11.31% against +2.33%.) The dips that did not fall further were the
         * ones that had bottomed, and those are exactly the ones the seat let go.
         */
        /**
         * 1.11.896 — back on. Turning it off in 1.11.890 rested on what the
         * *leaders* made buying the dips our seats let expire (+10.74% median
         * against −0.29% for the ones we waited out). That was never our number:
         * they fill without our chase and overpay and they exit on their own
         * rule, so their result on a dip is not the result we would have had.
         *
         * Ours, per position, matched to the buy row:
         *
         *   overnight, seats on       409 pos  −0.0415/pos  24% end in time_red
         *   09:48–11:35, seats off     70 pos  −0.0906/pos  40% end in time_red
         *
         * The leaders' own book did not deteriorate over those hours - their
         * round trips ran a +0.52% median overnight and +0.92% through the
         * morning - so this is not the market turning, it is the change.
         */
        MILD_DIP_WAIT_DIP: '1',
        MILD_DIP_WAIT_DIP_WITH_TURN_DUMP: '1',
        /**
         * 1.11.808 — ask deeper, accept shallower. With wait −12 / overshoot 2
         * the fill window was ready(0.88×signal) → ceiling(0.90×signal): a 2.3%
         * reclaim killed it. Live 30m: 37 parked, 39 expired, ~0 filled, and
         * ceiling rejects clustered at −8.63% against a −10% requirement.
         * Now: park until −15%, still never pay above −10% off signal, so the
         * fill window is ~5.9% wide. CF says −10…−15 all beat buying at signal.
         */
        /**
         * 1.11.866 — −5, was −15. The seat was waiting for a fall the market
         * almost never delivers, and getting filled only when it did.
         *
         * 24h: 1997 seats parked, 1348 expired unfilled. On those, the deepest
         * the price got from the signal had a median of −2.87% and 32% never
         * fell at all; a −15% target would have caught 4.9% of them, −5%
         * catches 38.7%. And the ones we refused mostly went up: 61.4% ended
         * above the signal price, 24.9% more than 10% above.
         *
         * The seats that did fill came in at a median −20.83% from signal,
         * deeper than the target — we were being filled by collapses only,
         * which is why wait_dip carries the worst P&L of any source
         * (−$0.311 per position against −$0.168 for a direct dex entry).
         *
         * With overshoot at 5% the fill ceiling sits at 0.9975 × signal, so we
         * still never pay above the price that qualified the seat.
         */
        MILD_DIP_WAIT_DIP_PCT: '-5',
        /**
         * 1.11.998 — 7d factual-dollar timing recheck: 600s retains
         * n=1593 and +$229.1 of +$231.9 seat cash (+4.36/$100); 300s
         * keeps only n=1024 and +$136.9, dropping about $94. Waiting time
         * does not predict fill depth (median fill −11.5/−10.5/−10.8/−11.9%
         * for 0–60s/60–300s/300–600s/>600s). Rollback: 1200000.
         */
        MILD_DIP_WAIT_DIP_MAX_WATCH_MS: '600000',
        MILD_DIP_WAIT_DIP_MIN_TROUGH_AGE_MS: '120000',
        MILD_DIP_WAIT_DIP_TROUGH_READY_FRACTION: '0.7',
        MILD_DIP_WAIT_DIP_TROUGH_MIN_AGE_MS: '60000',
        MILD_DIP_WAIT_DIP_TROUGH_MIN_BOUNCE_PCT: '1.5',
        MILD_DIP_WAIT_DIP_TROUGH_MAX_BOUNCE_PCT: '8',
        /**
         * 1.11.998 — the ceiling existed, but there was no depth floor.
         * The old 10% value came from a fixed-$5 per-$100 tape reconstruction
         * and was disproved by factual dollars: 7d/2227 seats, $7107 turnover,
         * +$230.5 cash; only fills deeper than −20% were negative
         * (−$2.69/$100, −$27.3). Rollback: 0.
         */
        MILD_DIP_WAIT_DIP_MAX_DUMP_FROM_SIGNAL_PCT: '25',
        /**
         * 3, not 5: with a −5% target an overshoot of 5 sums to zero and
         * `waitDipMaxPriceUsd` collapses the ceiling back onto the target,
         * leaving no room for any reclaim at all. At 3 the window runs from
         * ready at −5% to a ceiling at −2%.
         */
        MILD_DIP_WAIT_DIP_MAX_OVERSHOOT_PCT: '3',
        /** Ceiling is the binding guard; chase only blocks outright rips. */
        MILD_DIP_WAIT_DIP_MAX_CHASE_PCT: '8',
        MILD_DIP_WAIT_DIP_QUOTE_PREMIUM_PCT: '1',
        /**
         * 1.11.789 — OR entry (MAIN then SHALLOW):
         *   MAIN:    dump ≈ -5.08 + 6.86·log1p(turn·100), band [pred−10, pred+12]
         *   SHALLOW: dump ≈ -8.83 + 4.23·log1p(turn·100), band ±8
         * Pass if MAIN matches; else try SHALLOW. Prefer MAIN when both pass.
         * Forces wait-dip off when gate enabled.
         */
        MILD_DIP_TURN_DUMP_GATE: '1',
        MILD_DIP_TURN_DUMP_ALPHA: '-5.08',
        MILD_DIP_TURN_DUMP_BETA: '6.86',
        MILD_DIP_TURN_DUMP_SHALLOW_SLACK_PCT: '10',
        MILD_DIP_TURN_DUMP_DEEP_SLACK_PCT: '12',
        MILD_DIP_TURN_DUMP_SHALLOW_BRANCH: '0',
        MILD_DIP_TURN_DUMP_SHALLOW_ALPHA: '-8.83',
        MILD_DIP_TURN_DUMP_SHALLOW_BETA: '4.23',
        MILD_DIP_TURN_DUMP_SHALLOW_BAND_PCT: '8',
        /**
         * 1.11.793 — same wallet OR after MAIN|SHALLOW fail:
         * 7BNax knife style dump≥30% & turn=vol5m/liq≥0.30 → buy now
         * (does not open a second wallet / lane).
         */
        /**
         * 1.11.891 — off. This branch exists to buy a collapse of 30% or more,
         * reaching past the band floor, and across the whole journal it is the
         * worst entry we have by a wide margin:
         *
         *   turn_dump_knife  263 pos  −50.31 USD  −0.191/pos  46% win  6 rugs
         *   wait_dip        1257 pos  −50.53 USD  −0.040/pos
         *   dex             1030 pos  −35.72 USD  −0.035/pos
         *   dex+stream       760 pos  −10.09 USD  −0.013/pos
         *
         * Five times the loss per position of anything else. It wins slightly
         * more often than the others and loses far more when it does not, which
         * is what buying a collapse means: HTHEyy5n came in at pc5m −66.62% with
         * mcap $37k, four buyers against fourteen sellers, and went to −96%.
         */
        MILD_DIP_TURN_DUMP_KNIFE_BRANCH: '0',
        /**
         * 1.11.922 — 28, was 30. HJs8xT at 21:42 UTC: pc5m −28% / turn 0.647 —
         * wait_dip refloor and deep_knife_defer both missed because 28 < 30 while
         * turnover was above the 0.25 ceiling. 7BNax filled the same flush one
         * tick later.
         */
        MILD_DIP_TURN_DUMP_KNIFE_MIN_DUMP_PCT: '28',
        MILD_DIP_TURN_DUMP_KNIFE_MIN_TURN: '0.3',
        MILD_DIP_TURN_DUMP_KNIFE_TROUGH_MIN_AGE_MS: '180000',
        MILD_DIP_TURN_DUMP_KNIFE_TROUGH_MAX_BOUNCE_PCT: '8',
        MILD_DIP_KNIFE_DEX_GREEN_VETO: '1',
        MILD_DIP_KNIFE_STREAM_DIVERGENCE_MAX_PP: '40',
        /**
         * 1.11.732 — re-enable leader-style dump→bounce seats (was off in
         * 1.11.730 with scale-in removal). Scale-in stays deleted.
         * Gates keep anti-green filters: dump ≤−8, last ≥2% below peak
         * (Gymbmn/7rMnp9 full reclaim blocked). Deep knife still uses
         * knife_stabilize (−50,−20] wait+bounce — unchanged.
         */
        MILD_DIP_MILD_STABILIZE_ENABLED: '1',
        /** 1.11.971 — on: leader-style reclaim entries, trough must hold 60s. */
        MILD_DIP_MILD_STABILIZE_FRESH_ENTRY: '1',
        // Rollback: MILD_DIP_MILD_STABILIZE_MIN_DUMP_PCT='-25'.
        MILD_DIP_MILD_STABILIZE_MIN_DUMP_PCT: '-60',
        MILD_DIP_MILD_STABILIZE_MAX_DUMP_PCT: '-6',
        MILD_DIP_MILD_STABILIZE_MIN_BOUNCE_PCT: '1.5',
        MILD_DIP_MILD_STABILIZE_MAX_BOUNCE_PCT: '8',
        MILD_DIP_MILD_STABILIZE_TROUGH_MIN_AGE_MS: '60000',
        MILD_DIP_MILD_STABILIZE_MAX_PER_HOUR: '12',
        MILD_DIP_MILD_STABILIZE_SKIP_MAX_PER_HOUR: '240',
        MILD_DIP_MILD_STABILIZE_SKIP_MIN_DUMP_PCT: '-3',
        MILD_DIP_MILD_STABILIZE_MIN_BELOW_PEAK_PCT: '2',
        /** Even if FRESH_ENTRY is re-enabled: Dex m5 must still be dumping. */
        MILD_DIP_MILD_STABILIZE_REQUIRE_DEX_DIP: '1',
        MILD_DIP_MILD_STABILIZE_DEX_MAX_DIP_PCT: '-2',
        /**
         * 1.11.784 — OFF. Single entry formula = turn→dump (+ mild/knife
         * stabilize on the same dump tape). h1-red-shallow was a second path
         * (pc5m ∈ (−10,−3] with h1≤−15) and polluted dump-overlap vs leaders.
         */
        MILD_DIP_H1_RED_SHALLOW_ENABLED: '0',
        MILD_DIP_H1_RED_SHALLOW_H1_MAX_PCT: '-15',
        MILD_DIP_H1_RED_SHALLOW_MIN_DIP_PCT: '-10',
        MILD_DIP_H1_RED_SHALLOW_MAX_DIP_PCT: '-3',
        /**
         * 1.11.714 — OFF. Was buying −2…−5% wiggles (YBPUY1 2yM2Cne… pc5m=−3.3%
         * after a +25% rebound; same mint earlier real dumps then cliff −49%).
         * 23 flat_micro attempts / 3h = spray, not leader-style range scalp.
         */
        MILD_DIP_FLAT_MICRO_ENABLED: '0',
        MILD_DIP_FLAT_MICRO_MIN_DIP_PCT: '-5',
        MILD_DIP_FLAT_MICRO_MAX_DIP_PCT: '-1.5',
        MILD_DIP_FLAT_MICRO_H1_MIN_PCT: '-35',
        MILD_DIP_FLAT_MICRO_H1_MAX_PCT: '10',
        /**
         * 1.11.780 — leader-like floors (8zkg/7BNax buy book, 3d):
         * vol5m p10≈$287 / liq p10≈$4.6k. Was $500 / $10k — covered only
         * ~63% of leader buys (~76% of dump-band buys). New $300 / $5k →
         * ~82% all / ~91% dump-band. Timing stays independent (turn→dump /
         * stream-first), not pure copy.
         */
        MILD_DIP_MIN_VOLUME_5M_USD: '150',
        /**
         * 1.11.895 — the last five minutes must actually be trading.
         *
         * The absolute floor above is cleared by a coin with a busy hour and a
         * dead last five minutes. EkcTa8n1 came in on $619 of 5m volume against
         * $34,662 for the hour — 21% of the hourly pace, a drift with nobody in
         * it rather than a flush. It fell 24% over the next ten minutes, we cut
         * at −18.4%, and the leader bought the actual flush 21 seconds later.
         *
         * Ratio of 5m volume to `vol1h / 12`. Below 0.3 loses in every window:
         *
         *   pace       last 12h   last 24h   whole journal
         *   < 0.3        −0.080     −0.040      −0.095   USD/pos
         *   0.3–0.6      −0.053     −0.009      −0.013
         *   0.6–1.0      −0.050     −0.062      −0.056
         *
         * 264 positions below 0.3 across the journal. A missing hourly reading
         * does not block: the absolute floor still applies there.
         */
        MILD_DIP_MIN_VOL5M_PACE_RATIO: '0.3',
        /**
         * 1.11.904 — 5m volume must be at least 3% of pool liquidity: the name has
         * to still be changing hands relative to its own size.
         *
         * GCa9TZ is the case that found this. While both leaders were taking it,
         * turnover ran 0.209 on $14,090 of 5m volume; after they stopped it ran
         * 0.038 on $4,307, with liquidity barely moved ($118.5k to $113.7k) and
         * market cap down only a fifth. Nothing about the pool broke - the coin
         * simply stopped trading. We kept buying for another twelve hours, nine
         * more positions, −2.80 USD, while both leaders stayed away.
         *
         * The pace gate cannot see this, because 5m and 1h volume fell together
         * and their ratio stayed healthy. Only the comparison against liquidity
         * moves. By turnover at entry, across three windows:
         *
         *   turn        last 24h   last 48h   whole journal
         *   < 0.03       -0.0635    -0.0552      -0.0644   USD/pos
         *   0.03-0.06    -0.0459    -0.0572      -0.0490
         *   0.06-0.12    +0.0192    -0.0086      -0.0163
         *   0.12-0.25    -0.0565    -0.0344      -0.0325
         *   > 0.25       -0.0568    -0.0622      -0.1145
         *
         * The floor goes at the bottom band, 211 positions and −13.58 USD across
         * the journal, negative in every window. The top band is worse by dollars
         * (731 positions, −83.71) but that figure leans on the era before the exit
         * bases were fixed, and cutting it would drop 40% of entries at once, so it
         * waits for clean data rather than going out on the same breath.
         */
        /**
         * 1.11.912 — 0.06, because 0.03 did not catch the coin it was built from.
         *
         * GCa9TZ ran 0.038 after both leaders walked away, which cleared a floor
         * at 0.03 by a hair, and we would have kept buying it. The band it sits in
         * is negative in every window anyway, by the same table that set the floor:
         *
         *   turn        last 24h   last 48h   whole journal
         *   < 0.03       -0.0635    -0.0552      -0.0644   USD/pos
         *   0.03-0.06    -0.0459    -0.0572      -0.0490
         *   0.06-0.12    +0.0192    -0.0086      -0.0163
         *
         * 0.06 is where the sign turns. It costs another 206 positions and -10.09
         * USD of loss across the journal on top of the 211 the first floor took.
         */
        MILD_DIP_MIN_TURNOVER_5M_LIQ: '0.06',
        /**
         * 1.11.907 — and no higher than 0.25. Past that the name is inside an
         * event rather than trading, and we are on the wrong side of it: 731
         * positions above 0.25 returned −0.1145 each across the journal, the worst
         * band by dollars, and negative in every window (−0.0568 over 24h, −0.0622
         * over 48h). It drops a large share of entries, which is why it waited for
         * the floor to go in first.
         */
        MILD_DIP_MAX_TURNOVER_5M_LIQ: '0.25',
        /**
         * 1.11.870 — ceiling at $40k of 5m volume. Over 499 fully closed bags
         * joined to the entry snapshot, counted in cash:
         *
         *   $0–2k    112 bags  −$12.94   win 0.393
         *   $2–6k    112 bags  −$23.90   win 0.384
         *   $6–15k    89 bags  −$20.02   win 0.416
         *   $15–40k   92 bags  −$29.82   win 0.370
         *   >$40k     94 bags  −$61.72   win 0.298
         *
         * Nineteen percent of the bags carry 42% of the loss. The split shows
         * up again in the bags that reach a deep-loss exit: their 5m volume at
         * entry has a median of $19,361 against $6,702 for everything else,
         * while liquidity, mcap and pc5m are indistinguishable between the two.
         * A name doing more than $40k in five minutes is inside an event and we
         * are on the wrong side of it.
         *
         * The ceiling keeps 81% of bags and removes $61.71 of the loss. The
         * green lane is unaffected: it is evaluated before these floors and
         * wants hot names by design.
         */
        MILD_DIP_MAX_VOLUME_5M_USD: '40000',
        /**
         * 1.11.844 — liquidity floor $5k → $15k, the one change the overnight
         * analysis supports on its own.
         *
         * 390 closed bags over 13h. Mean outcome by floor, and it is monotone
         * across the well-sampled range:
         *
         * | floor | kept | sum   | mean  |
         * |-------|------|-------|-------|
         * | $5k   | 387  | −559  | −1.44 |
         * | $10k  | 289  | −338  | −1.17 |
         * | $12k  | 248  | −141  | −0.57 |
         * | $15k  | 197  | **+76**  | **+0.39** |
         * | $20k  | 144  | +201  | +1.39 |
         * | $30k  |  76  | −137  | −1.80 |
         *
         * $15k is picked over the better-looking $20k/$25k because it is the
         * highest floor that improves the mean in **all three** sub-windows
         * (−1.36→+1.57, −0.61→+1.35, −2.67→−1.35) while keeping half the volume.
         * The curve reverses at $30k on 76 samples, so the tail of it is noise.
         *
         * Mechanism, not just fit: thin liquidity is where our worst trades come
         * from. The deep losses are price gaps — a mark at ~0% and the next fill
         * at −30…−70% — and a stop cannot fill inside a book that thin.
         *
         * Cost is real: it skips 63% of trades at the $20k level and half here,
         * and 48% of the skipped ones were winners (best skipped: +81%, +65%,
         * +51%). Revisit once there is more than one regime in the sample.
         */
        /**
         * 1.11.858 — $6k, was $15k. Against 1288 leader buys for which we hold
         * our own metrics within ten minutes, the liquidity floor alone blocked
         * 65.9% of them — by far the largest single blocker. Their median
         * liquidity at entry is $11,344 and p25 is $6,726, i.e. our floor sat
         * above the middle of the range they trade in.
         *
         * 1.11.894 — $8k. The band the old floor admitted is a standing loss and
         * the only liquidity band negative in every window:
         *
         *   liquidity    last 12h   last 24h   whole journal
         *   < $8k          −0.129     −0.070      −0.112   USD/pos
         *   $8–15k         −0.013     −0.097      −0.117
         *   $15–30k        +0.048     −0.023      −0.017
         *   > $80k         −0.051     −0.012      −0.008
         *
         * 238 positions below $8k across the journal. The leaders agree from the
         * other side: over 18,475 of their buy moments the p25 liquidity is
         * $8,150, so they essentially do not trade under it. 7mPKEd18 came in at
         * $7,686 with a $13.8k market cap.
         *
         * $8–15k is negative in all three windows too, but the 12h reading is
         * near zero and it holds 592 positions, so it waits for more clean data.
         */
        MILD_DIP_MIN_LIQUIDITY_USD: '8000',
        /**
         * 1.11.776 — global entry floor $5k (was $50k). One clip tier ($10);
         * turn→dump gate still selects depth. Knife/micro floor matches.
         */
        MILD_DIP_MIN_MCAP_USD: '5000',
        MILD_DIP_MAX_MCAP_USD: '300000000',
        /**
         * 1.11.724 — skip pairs younger than 30m (was 0.25h / 15m).
         * Closed-book age buckets: &lt;0.5h had worst med PnL / cliff&lt;−20% rate.
         */
        /**
         * 1.11.864 — 6 hours, was 0.2. Measured on 513 closed positions joined
         * to the entry snapshot logged at buy time, counting cash:
         *
         *   age 0–0.5h : 270 positions, −$115.00, mean −10.71%, win 0.359
         *   age 24–168h:  78 positions,   −$0.89, mean  −1.42%, win 0.423
         *   age >168h  : 101 positions,   −$2.51, mean  −3.61%, win 0.366
         *
         * Coins under two hours old carry 84.9% of our entire loss; under six
         * hours, 91.6%. Nothing else comes close — the next largest cut is
         * pc5m < −30 at 41.2%, and it overlaps heavily with youth.
         *
         * A 6h floor keeps 211 of 513 positions and turns −$138.54 into
         * −$11.43. This reverses 1.11.858, which lowered the floor to 0.2h to
         * match the leaders' coverage: they do trade launches (age p25 0.39h),
         * we lose money on them.
         */
        MILD_DIP_MIN_PAIR_AGE_HOURS: '6',
        MILD_DIP_ENTRY_MIN_PAIR_AGE_HOURS: '0.25',
        MILD_DIP_ENTRY_MAX_VOL5M_TO_LIQ: '2',
        MILD_DIP_ENTRY_MIN_LIQ_USD: '6000',
        /**
         * 1.11.1028 — лидерские полосы меняют знак около txns=20 и
         * turnover=0.05. Старый AND-порог 30/0.15 пропускал 46.0% входов
         * лидера (median +0.5%, winrate 51.2%); новый 20/0.05 пропускает
         * 66.5% (median +0.9%, winrate 52.2%, $8108 из $8216 кассы).
         * Отсекаемая полоса остаётся отрицательной: txns<20 — median −1.6%,
         * winrate 46.0% (0–10: −2.1%/44.4%, 10–20: −1.6%/45.7%);
         * turnover<0.05 — median −1.3%, winrate 46.3%. Выше границ
         * turnover 0.05–0.10 даёт +1.4%/53.7%, а txns 20–30 — +2.0%/55.1%.
         */
        MILD_DIP_ENTRY_MIN_TXNS_5M: '20',
        MILD_DIP_ENTRY_MIN_TURNOVER: '0.05',
        /**
         * 1.11.1030 — журналирование паттернов лидера расширено additive-only:
         * Dex windows, all-pool depth, trade execution, cadence/re-entry и
         * exit profile. Торговые решения и пороги не меняются.
         */
        /**
         * 1.11.905 — one hour instead of six for a name a leader is buying.
         *
         * The floor is there because a young pair is usually unformed, but two
         * leaders actively taking one is evidence about that specific pair, and
         * the clock does not carry it. 4CmYEyg is the case: the leaders traded it
         * 26 times while it sat behind our six-hour floor, and by the time it
         * cleared, the phase they had traded was over. GPzpoXpD and 94yadmf3 read
         * the same way - they were in from hour one to four, we arrived at six or
         * seven and bought the retrace of a move that had already happened.
         *
         * Only ever lowers the floor, never raises it, and every other floor
         * stands: liquidity $8k, turnover 0.03, the volume pace ratio, the dip
         * band. So a young name still has to be liquid and actually trading; it
         * just no longer has to be old as well.
         */
        MILD_DIP_MIN_PAIR_AGE_HOURS_LEADER_SEEN: '1',
        /**
         * 1.11.815 — cap at 72h. Pairs older than that are dead money on this
         * strategy: 20 trades, −$7.60, winrate 0.25, median MFE 1.1% — they
         * simply do not bounce. Cutting them is the only filter that turns
         * `ex_top3` positive (−$7.50 → +$0.09), i.e. it survives dropping the
         * three best trades.
         */
        /**
         * 1.11.853 — 30 days, was 72 hours. The ceiling was rejecting a third of
         * everything the leaders buy: of 725 leader-bought mints whose age we
         * measured, 32.7% are older than 72h, and 113 of those clear every other
         * floor — 15.6% of their universe refused on age alone. MsGDybWR sat at
         * 1028h with $166k liquidity and $271k of 5m volume and was skipped 136
         * times while two leaders traded it in $870–1125 clips. Meanwhile the
         * median age of what we look at and they do not is 7.2h: we were fishing
         * fresh launches while they trade established names. 720h covers 96% of
         * their universe; liquidity and volume floors still carry liveness.
         */
        MILD_DIP_MAX_PAIR_AGE_HOURS: '720',
        /**
         * Venue allow-list for structural pair pick (1.11.729): Dex fetch now
         * selects among these dexIds first. Was: pick global max-liq (often
         * Meteora) then reject mint — NEEGY 6oGuFDbE dump missed.
         */
        MILD_DIP_ALLOWED_DEX_IDS: 'pumpswap,pumpfun,raydium',
        /** USDG + other junk; built-in stables also denied in config defaults. */
        MILD_DIP_DENIED_MINTS: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
        /**
         * 1.11.699 — scale-out trail; 1.11.741 — half-first even on −8% gap:
         * Arm at +5% MFE; first giveback hit (−3% or deeper) always sells 50%;
         * runner full-exits only after scaleOutDone + another −8% hit.
         */
        MILD_DIP_EXIT_ARM_PCT: '5',
        MILD_DIP_EXIT_PARTIAL_GIVEBACK_PCT: '0',
        MILD_DIP_EXIT_SCALE_OUT_FRACTION: '0.5',
        /**
         * Trail width: full exit 30% below the peak. Measured off the leaders'
         * own bag marks, where giveback at exit is a constant ~30% of peak for
         * any peak above 15% (−29.4% / −29.9% / −33.6% across buckets).
         */
        MILD_DIP_EXIT_GIVEBACK_PCT: '12',
        /**
         * 1.11.755 — never-arm option-2 (CF vs full stack):
         * bounce 8/8 + time-red 15m if still ≤ −5%. Cliff −50% kept.
         * Freefall / stale / dead / vol_fade / max-hold OFF (0).
         * patience=0: no early never_arm_giveback knife.
         */
        MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS: '0',
        MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS: '0',
        MILD_DIP_EXIT_NEVER_ARM_STALE_MAX_MFE_PCT: '2',
        MILD_DIP_EXIT_NEVER_ARM_STALE_PNL_PCT: '5',
        MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS: '0',
        MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT: '10',
        /**
         * 1.11.832 — vol_fade stays OFF, and the measurement is why. Over 3034
         * episodes, exiting on sustained fade has a **negative median** in every
         * variant tried (−0.02 to −2.56 pct-of-clip) and hurts 47–76% of cases.
         * The aggregate sign is noise: the same rule sums +32.9 at a 15m min-hold
         * and −101.9 at 30m. A faded bag is not the mistake it looks like —
         * `HBeaQ6Pn5` itself faded at −11.28% and realized +20.23% 95min later.
         *
         * What *is* wasteful is the leftovers: 8 bags of $1–2 held 9–23h were
         * burning 43% of all Dex marks (22_407 of 51_655 over 6h). Those are
         * closed by notional instead — see DUST_CLOSE below.
         */
        MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS: '0',
        MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_RATIO: '0.25',
        MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD: '300',
        MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_SAMPLE_MS: '300000',
        MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_WEAK_WINDOWS: '3',
        /**
         * Bank/bounce ladders leave $1–2 remnants that no move can make matter
         * (±1.3% of $1.20 is ±$0.02) while each one keeps pulling ~3_540 Dex
         * marks per 6h. Gas to close is $0.011, ~1% of the crumb. Threshold sits
         * below a 40% bank remainder of the $5 clip ($3) so live runners are not
         * touched; 30m min-hold is well past the 12.5m median hold.
         */
        /**
         * 1.11.942 — the live clip is ~$1 and 0.34 rungs leave ~$0.44; 0.6
         * swept 8kzojN's runner 14s after rung 1. Keep 0.15 for true crumbs.
         */
        MILD_DIP_EXIT_DUST_CLOSE_USD: '0.15',
        MILD_DIP_EXIT_DUST_CLOSE_MIN_HOLD_MS: '1800000',
        /**
         * 1.11.815 — back to 25. The 1.11.810 cut to 15 was fitted on 49 trades
         * and is wrong on 183: median MAE of the trades that eventually WIN is
         * −19.3%, and 56% of them dip below −15% first. A −15% floor sells the
         * winners. Grid on the full sample: hard15 −$9.52, hard20 −$0.17,
         * hard25 +$4.15, hard30 +$6.19.
         */
        /**
         * 1.11.911 — −15, because the upside is now capped.
         *
         * 1.11.910 put this at −50 on the grounds that across 2,226 leader bags
         * every stop from −25 to −80 replays the same. That reasoning was borrowed
         * from a book it does not describe. Their median winner is +34.75% and
         * 43.9% of their winners clear +100%, so the size of a loss barely moves
         * their result. Ours, over 1500 closed positions: win rate 53%, average
         * win +11.79%, average loss −17.96%, expectancy −2.076% per position, and
         * a pairing like that needs a 60% win rate to break even.
         *
         * Capping the upside at the first rung (1.11.897) therefore requires
         * capping the downside harder. Clipping our own losses at each level:
         *
         *   floor   average loss   break-even win rate   expectancy
         *   −15         −12.17%            51%             +0.622%
         *   −20         −14.60%            55%             −0.508%
         *   −25         −15.83%            57%             −1.081%
         *   −50         −17.40%            60%             −1.813%
         *
         * −15 is the only level with a positive expectancy on our distribution,
         * and −50 was the worst of the six. The two knobs have to move together:
         * a laddered runner can carry a wide floor, a single-leg exit at +8%
         * cannot. `dead_set_bounce` still fires first at −10% with the
         * conjunction, so this is the backstop rather than the usual exit.
         */
        /**
         * 1.11.936 — 30. With the bounce gate above, −15 is not where we exit:
         * the reclaim only arrives well past it (HXbqtb filled at −41%), so the
         * number now says where the backstop really is instead of arming a stop
         * that the gate immediately overrides.
         */
        /**
         * 1.11.956 — disable the entry-relative hard stop; losing positions
         * follow the leader-like reclaim/tail rules instead. Rollback to '30'.
         */
        MILD_DIP_EXIT_HARD_STOP_PNL_PCT: '0',
        /**
         * 1.11.910 — condemned by the conjunction, timed by the bounce.
         *
         * All three have to have gone before a bag is written off: its 5m volume
         * down to a quarter of what it was at entry, its turnover likewise, and the
         * price down 10%. That combination is what the leaders' own departures look
         * like - on GCa9TZ they left when turnover fell 0.209 to 0.038 with
         * liquidity intact - and it is the state no single number describes.
         *
         * Then the sell waits for the price to lift 2% off its running low, so we
         * are not the ones handing a whale the bottom tick. Fifteen minutes minimum
         * hold, so a fresh bag on a quiet five minutes is not condemned by noise.
         */
        MILD_DIP_EXIT_DEAD_SET_VOL_FADE_FRAC: '0.25',
        MILD_DIP_EXIT_DEAD_SET_TURN_FADE_FRAC: '0.25',
        MILD_DIP_EXIT_DEAD_SET_MIN_DROP_PCT: '15',
        /**
         * 1.11.948 — move the dead-set floor out of ordinary chop.
         *
         * The old −10%/+5% thresholds fired in ordinary chop. `4CmYEygE` held
         * 24m, faded from $5155 to $182 in 5m volume, and sold at −9.8% after
         * a −16.08% trough. Across 119 dead_set_bounce exits, median realized
         * PnL was −12.02% and the next-30m median lift was only +2.6%, so the
         * rule stays out of chop; it requires −15% and a +10% reclaim, matching
         * the leaders' +10% median lift off losing lows.
         */
        /**
         * 1.11.995 — disable the remaining measured red-side branches:
         * dead_set_bounce (−$114/227 exits), never_arm_time_red (−$93/7d),
         * and the GREEN line (−$6.53/101 cycles over 11d). The minus side
         * keeps only the 18% trough reclaim plus reclaim wait, cliff dump, and
         * liquidity-drain floor. Rollback: 10 / 900000 / 1.
         */
        MILD_DIP_EXIT_DEAD_SET_BOUNCE_PCT: '0',
        MILD_DIP_EXIT_DEAD_SET_MIN_HOLD_MS: '900000',
        /**
         * 1.11.920 — soft loss exits (mfe_bank_sleeve, never_arm_*, breakeven_stop)
         * sell into a bounce off the trough, not on the red candle itself.
         * AzXuLS: half cut at −19.8% giveback / pc5m −18.75%; price reclaimed entry
         * seconds after the fill.
         */
        /**
         * 1.11.936 — 18: the 12% reclaim fired on the first twitch off the
         * trough. HXbqtb (17:50–18:06): never armed (peak +1.06%), bled to
         * −46%, sold at −41.33% into a +9% blip, and the token traded +15% off
         * that trough two minutes later. A wider reclaim means the loss exit
         * only fires on an actual recovery leg, not on the dump's own noise.
         */
        MILD_DIP_EXIT_LOSS_MIN_BOUNCE_PCT: '18',
        MILD_DIP_EXIT_LOSS_RECLAIM_MAX_LOSS_PCT: '10',
        MILD_DIP_EXIT_LOSS_RECLAIM_TARGET_PCT: '2',
        MILD_DIP_EXIT_LOSS_RECLAIM_STOP_PCT: '25',
        MILD_DIP_EXIT_LOSS_RECLAIM_MAX_WAIT_MS: '3600000',
        /**
         * 1.11.855 — once MFE touched +8%, do not let the trail hand the bag
         * back as a loss. A 30% giveback on a +13.5% peak lands at −20.5% by
         * arithmetic; 2iKmjMW3 went +13.5% → −25.53% that way. On 355 leader
         * paths the floor moves the median from −5.44% to 0.00% for 1.4 points
         * of mean, and only 5.4% of their armed-then-underwater positions ever
         * finished above +100%.
         */
        /**
         * 1.11.868 — a stream print is held to 8% where a Dex one gets 25%.
         * Reversion does not scale with jump size (10–15% at every band) but it
         * does scale with source: 46.1% of stream prints jumping 5–10% reverted
         * on the next mark. CX2v7JSH came in at +23.56% off the stream, cleared
         * the 25% guard, armed the trail and fired a ladder rung on a coin that
         * had not moved.
         */
        /**
         * 1.11.880 — 25% was far too wide for a 2000ms mark cadence. 7ZgRjHSn
         * took three marks at 6.7779e-05, one at 7.6591e-05 (+13%) and the next
         * back at 6.956e-05: the spike passed unconfirmed, read gain +8.44%,
         * fired the +8% rung into a fill at the real price (−4.45%) and left the
         * peak polluted, which then armed breakeven for the remainder. One tick
         * of confirmation costs two seconds; the phantom cost the position.
         */
        MILD_DIP_EXIT_MARK_JUMP_CONFIRM_PCT: '10',
        MILD_DIP_EXIT_MARK_JUMP_CONFIRM_STREAM_PCT: '8',
        /**
         * 1.11.874 — a soft exit asks the entry gate first. GCa9TZ went out on
         * breakeven_stop at −10.48% and the entry side bought it back 98s later
         * 7.7% lower, where the ladder banked two rungs: we paid a round trip to
         * swap the bag for itself. Budget bounds the claim; risk exits and the
         * profit ladder are never deferred.
         */
        MILD_DIP_EXIT_DEFER_WOULD_BUY: '1',
        MILD_DIP_EXIT_DEFER_WOULD_BUY_MAX_MS: '600000',
        /**
         * 1.11.942 — the trail arms at +5%; with giveback 12%, a +20% peak
         * exits around +5.6%, above the +3% floor. Breakeven only fired below
         * what the trail covers, closing 7bHZ8M at +2.19%; arm 0 makes it inert.
         */
        MILD_DIP_EXIT_BREAKEVEN_ARM_PCT: '0',
        /** Floor stays 3% for real greens, but is inert while the arm is 0. */
        MILD_DIP_EXIT_BREAKEVEN_FLOOR_PCT: '3',
        /**
         * Measured over 2009 live sells: the fill lands a median 0.99% below the
         * mark that decided it (p25 −3.59%, half of them past 1%). The mark is a
         * mid and we sell into the bid, so a money threshold has to clear on a
         * price we can actually get.
         */
        MILD_DIP_EXIT_MARK_SELL_HAIRCUT_PCT: '1',
        /** 1.11.794 — no hard-stop partial limbo; the production hard stop is now off. */
        MILD_DIP_EXIT_HARD_STOP_PARTIAL_FRACTION: '0',
        /**
         * 1.11.933 — cliff floor keeps the level but no longer sells into the
         * dump: like `mfe_bank_sleeve` it waits for the reclaim off the trough
         * (`MILD_DIP_EXIT_LOSS_MIN_BOUNCE_PCT`). Every loss exit is now timed by
         * the bounce.
         */
        MILD_DIP_EXIT_CLIFF_DUMP_PNL_PCT: '50',
        /**
         * 1.11.751 — never-arm bounce hardened (F1XdRe / AENK1Y stream-wick churn):
         * trough ≤ −8%, bounce ≥ 8%, trough age ≥ 60s, still ≤ −3% vs entry.
         * 1.11.759 — half on first bounce (8%), runner on bigger bounce (16%).
         * The armed-runner bounce is off since 1.11.954; loss sleeves now use
         * one full-bag decision after the configured reclaim. 1.11.961 moves
         * this reclaim to +18% and makes the first loss cut one transaction.
         */
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_DUMP_PCT: '8',
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PCT: '18',
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_TROUGH_AGE_MS: '60000',
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_ARMED_RUNNER: '0',
        /**
         * 1.11.946 — DTGWeD sold +5.72% / +6.29% before the trail armed;
         * keep never-arm bounce exits at least 3% red on the money basis and
         * disable the gain-basis PnL floor.
         */
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_REQUIRE_RED_PCT: '3',
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_PNL_PCT: '-1000',
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PARTIAL_FRACTION: '0',
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_2_PCT: '16',
        /** 1.11.961 — refuse materially degraded bounce-based loss fills. */
        MILD_DIP_EXIT_LOSS_FILL_MAX_SLIP_PCT: '8',
        MILD_DIP_EXIT_LIQ_DRAIN_RATIO: '0',
        MILD_DIP_EXIT_LIQ_DRAIN_MIN_AGE_MIN: '10',
        MILD_DIP_EXIT_LIQ_DRAIN_CONFIRM_TICKS: '2',
        MILD_DIP_EXIT_LIQ_DRAIN_SKIP_ARMED_RUNNER: '1',
        MILD_DIP_EXIT_LIQ_ABS_FLOOR_USD: '4000',
        /**
         * 1.11.810 — bank earlier and finish sooner on the deep-entry profile.
         * Free-form grid on 49 post-1.11.808 trades put `tp8 / sl15` on top and
         * `trail35` near the bottom: after a −20% fill the pop mean-reverts, so
         * the fat right tail we copied from the leaders is not there for us.
         * Closest engine-expressible config: 40% at +6, remainder at +8.
         * Was 8×0.4 → 15×0.4 → sleeve 12 (−$3.97 vs −$0.48 on that window).
         */
        /**
         * 1.11.821 — 20s settle guard before the first bank. `6tfuqq` banked at
         * +8% two seconds after entry, got `no_token_balance` five times, spent
         * 30s on retries and `Custom 6024`, exited near flat — and the name then
         * ran to +32%. Live 12h: bank1 fired under 10s on 19% of positions and
         * 429 sell legs failed on `no_token_balance`.
         */
        MILD_DIP_EXIT_MFE_BANK_MIN_HOLD_MS: '20000',
        MILD_DIP_EXIT_MFE_BANK1_PCT: '0',
        MILD_DIP_EXIT_MFE_BANK1_FRACTION: '0.4',
        /**
         * 1.11.1001 — full exits plus repeat-entry circles: disable the +8%
         * second bank. Rollback: '8'.
         */
        MILD_DIP_EXIT_MFE_BANK2_PCT: '0',
        MILD_DIP_EXIT_MFE_BANK2_FRACTION: '0.6',
        /** 1.11.815 — 8 → 12: sleeve12 retained more value ($4.15 vs $1.98). */
        MILD_DIP_EXIT_MFE_BANK_SLEEVE_GIVEBACK_PCT: '8',
        /**
         * 1.11.949 — 121 sleeve exits (median MFE +23.15%, realized +10.82%)
         * left a median +8.4% lift in the next 30m; bank half before the
         * green runner reaches the 12% peak-giveback trail. Set to 0 to restore
         * the historical full-bag sleeve exit.
         */
        /**
         * 1.11.1001 — sell the green sleeve in one exit for leader-style
         * full-close circles. Rollback: '0.5'.
         */
        MILD_DIP_EXIT_MFE_BANK_SLEEVE_GREEN_PARTIAL_FRACTION: '0',
        /**
         * 1.11.1001 — profitable TP/trail/reclaim exits wait 15m from entry,
         * matching the strongest 15–60m holding band. Rollback: '0'.
         */
        MILD_DIP_EXIT_PROFIT_MIN_HOLD_MS: '900000',
        // Bypass at +20% PnL; rollback: MILD_DIP_EXIT_PROFIT_MIN_HOLD_BYPASS_PNL_PCT='0'.
        MILD_DIP_EXIT_PROFIT_MIN_HOLD_BYPASS_PNL_PCT: '20',
        /**
         * 1.11.953 — TP-grid mode leaves the post-partial green runner
         * without the classic peak-giveback path; a wide trail preserves
         * the measured runner lift. Set to 0 to disable.
         */
        MILD_DIP_EXIT_SLEEVE_RUNNER_GIVEBACK_PCT: '25',
        /**
         * 1.11.849 — Live Oscar's unbounded ladder (`WAVE_B_FLAT_TP_HALF8_RUNNER`):
         * half the remainder at every +8%, no top rung. Replaces bank1 +6%/40% +
         * bank2 +8%/60%, which emptied the bag by +8% and capped every winner
         * near +7% while losers ran to the −25% stop. Loss exits untouched.
         * 0 = back to the two-rung bank.
         */
        /**
         * 1.11.850 — no take-profit ladder at all, which is what the leaders do.
         * 342 of their reconstructed positions: median −3.36%, mean +108.65%, and
         * 13 trades over +500% carry 99.8% of the profit. Replaying their own
         * outcomes through a ladder turns that mean into −8.17% (+8%×50%),
         * −3.47% (+25%×50%) or +0.66% (+50%×50%) — the rungs cut the only tail
         * that pays. Both ladders off; a single full exit on the trail below.
         *
         * 1.11.934 — back to the known-good baseline 1.11.915 (`aa7d7c4c`): the
         * ladder is ON at +8%. With `TP_GRID_MIN_REMAINDER: 0.6` the first rung
         * closes the whole bag, so a winner is banked at +8% instead of riding
         * the trail back down (HXbqtb: +89% MFE → trail fired at +26.66% → the
         * sell was deferred → out at −33%). 0 = ladder off.
         */
        MILD_DIP_EXIT_TP_GRID_STEP_PCT: '8',
        /**
         * 1.11.957 — first rung at +20% so the ladder does not sell the bag
         * into micro-profit; later rungs remain 8pp apart.
         */
        MILD_DIP_EXIT_TP_GRID_FIRST_RUNG_PCT: '20',
        MILD_DIP_EXIT_TP_GRID_MIN_GAP_MS: '15000',
        MILD_DIP_EXIT_SLEEVE_RUNNER_GIVEBACK_EXHAUSTED_PCT: '10',
        MILD_DIP_EXIT_RETRY_SLIPPAGE_STEP_BPS: '100',
        MILD_DIP_EXIT_RETRY_SLIPPAGE_MAX_BPS: '800',
        /** 1.11.957 — refuse profit fills more than 4pp below the decision mark. */
        MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT: '4',
        /**
         * 1.11.938 — 750 exits reached +8% MFE and 166 ended red; 343 reached
         * +20% and 107 finished below +10%. Sell 34% of the remainder per rung
         * so the sleeve keeps roughly 44% after +8/+16 instead of closing it.
         */
        /**
         * 1.11.1001 — the first +20% rung closes the full position, then a
         * later entry starts the next circle. Rollback: '0.34'.
         */
        MILD_DIP_EXIT_TP_GRID_SELL_FRACTION: '1',
        /**
         * 1.11.861 — the ladder stops instead of running forever. When the next
         * rung would leave under 20% of the original, it closes the bag: +8%
         * takes half, +16% half again, +24% takes the last quarter whole.
         */
        /**
         * 1.11.897 — 0.6, which closes the whole position on the first rung.
         *
         * The leaders take 92.6% of their positions off in a single sell, at a
         * median +34.75%, and 43.9% of their winners clear +100%. We were closing
         * 39.1% in one leg, 55% of our winners landed under +10% and none cleared
         * +100%: the ladder trimmed every runner into a scalp and left a
         * remainder to age, which is also why 48 bags sat open at a median age of
         * 51 minutes against their 17.
         *
         * Removing the ladder outright was tested and is much worse on our tapes
         * (median −3.55 against +1.73 over 24h; the same in the 12h window),
         * because our entries produce far fewer runners than theirs — 5% of our
         * positions clear +25% against their 43.9% over +100%. So the ladder
         * stays and only its remainder floor moves, which turns the first rung
         * into a full exit:
         *
         *   remainder   24h median / trimmed   12h median / trimmed
         *   0.20 (was)      +1.72 / −2.55          +2.06 / −2.71
         *   0.35, 0.50      +1.72 / −2.35          +2.06 / −2.48
         *   0.60            +5.47 / −1.81          +7.06 / −1.70
         *
         * Better on median, trimmed mean, plain mean and win rate in both
         * windows. It caps a position at the first rung, which is the trade: the
         * share clearing +25% goes 5% to 4%. In `gates.ts`, the first rung
         * explicitly closes the full bag when this floor exceeds its remainder;
         * later floor-breaching rungs fall through to the trail.
         */
        /**
         * 1.11.938 — with 0.34 rungs leave 0.66, then 0.4356; rung three would
         * leave 0.287496 below the 0.3 floor and stands down for the trail.
         * `tp_grid` fired 26 times at median +10.87%, always closing the whole bag.
         */
        MILD_DIP_EXIT_TP_GRID_MIN_REMAINDER: '0.1',
        /**
         * 1.11.865 — green lane on, at its own $1 clip. Momentum entries with
         * their own floors and their own exit (+30% / −6% / 10 min); see
         * `src/milddip/green-lane.ts` for how each number was measured.
         *
         * Its age floor is 1h, not the dip lane's 6h: green signals run at a
         * median pair age of 0.67h, so a 6h floor would keep 18% of them, and
         * the ten-minute ceiling bounds the exposure that floor guards against.
         * At 1h we keep 39% of signals, roughly 57 a day.
         */
        /**
         * 1.11.973 — controlled $1 execution probe. The old fitted floors
         * rejected ~85% on vol5m and >50% on liquidity in 145 leader-entry
         * snapshots, so the probe uses the measured leader-compatible floors below.
         */
        // 1.11.995 — disable the measured GREEN line; rollback: '1'.
        MILD_DIP_GREEN_ENABLED: '0',
        MILD_DIP_GREEN_REQUIRE_LEADER_SEEN: '0',
        MILD_DIP_GREEN_POSITION_USD: '1',
        MILD_DIP_GREEN_TAPE_GATES_ENABLED: '1',
        MILD_DIP_GREEN_MIN_RET1M_PCT: '5',
        MILD_DIP_GREEN_MAX_PRIOR5M_PCT: '10',
        MILD_DIP_GREEN_TAPE_STRICT_FRESHNESS_ENABLED: '1',
        MILD_DIP_GREEN_TAPE_MIN_RECENT_SAMPLES: '3',
        MILD_DIP_GREEN_TAPE_LATEST_MAX_AGE_MS: '15000',
        MILD_DIP_GREEN_TAPE_BOUNDARY_MIN_AGE_MS: '50000',
        MILD_DIP_GREEN_TAPE_BOUNDARY_MAX_AGE_MS: '75000',
        MILD_DIP_GREEN_TAPE_PRIOR_ANCHOR_MIN_AGE_MS: '270000',
        MILD_DIP_GREEN_TAPE_PRIOR_ANCHOR_MAX_AGE_MS: '390000',
        MILD_DIP_GREEN_JUPITER_MINUTE_ENABLED: '1',
        MILD_DIP_GREEN_JUPITER_MINUTE_INTERVAL_MS: '3000',
        MILD_DIP_GREEN_JUPITER_MINUTE_MIN_GAP_MS: '3000',
        MILD_DIP_GREEN_JUPITER_MINUTE_MAX_MINTS: '10',
        MILD_DIP_GREEN_JUPITER_MINUTE_TTL_MS: '600000',
        MILD_DIP_GREEN_JUPITER_MINUTE_GRACE_MS: '90000',
        MILD_DIP_GREEN_JUPITER_MINUTE_STREAM_IMPULSE_PCT: '8',
        MILD_DIP_GREEN_JUPITER_MINUTE_MAX_IN_FLIGHT: '2',
        MILD_DIP_GREEN_JUPITER_MINUTE_PROBE_USD: '1',
        MILD_DIP_GREEN_JUPITER_MINUTE_SLIPPAGE_BPS: '150',
        MILD_DIP_GREEN_FAST_EXIT_ENABLED: '1',
        MILD_DIP_GREEN_STRONG_RET1M_PCT: '40',
        MILD_DIP_GREEN_FAST_EXIT_ARM_PCT: '5',
        MILD_DIP_GREEN_FAST_EXIT_TRAIL_PCT: '6',
        MILD_DIP_GREEN_FAST_EXIT_MAX_HOLD_MS: '900000',
        /**
         * 1.11.867 — 0.05h (3 min), was 1h. Measured on the sampler with the
         * green exit (+30% / −6% / 10 min):
         *
         *   no floor : 153 signals, mean +3.39, sum +512
         *   0.05h    : 150 signals, mean +3.34, sum +494
         *   1h       :  60 signals, mean +2.75, sum +162
         *   2h       :  37 signals, mean +1.75, sum  +63
         *
         * Per-trade quality does not move with age; the floor only throws
         * signals away. Coins under an hour on their own: 93 signals, mean
         * +3.54, 25.8% reach +30% and 73.1% stop at −6% — which is exactly
         * 0.258 × 30 − 0.731 × 6.
         *
         * The dip lane's 6h floor does not transfer here: it was fitted where
         * the exit rides a −25% stop. The production tightening below now
         * keeps only pairs at least one hour old.
         */
        // GREEN tightening: require a one-hour-old pair after the adverse
        // sub-hour cohort (win 39%).
        MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS: '1',
        // p10 vol5m $145; keep the liquidity floor independent from volume.
        MILD_DIP_GREEN_MIN_VOL5M_USD: '150',
        // pc1h/buys5m/vol1h are absent from leader seed snapshots.
        MILD_DIP_GREEN_MIN_VOL1H_USD: '0',
        // GREEN tightening: the adverse <$20k liquidity cohort had median
        // return -5.29% and win rate 26%.
        MILD_DIP_GREEN_MIN_LIQUIDITY_USD: '20000',
        // Turnover p10 is 0.033; median is 0.209.
        MILD_DIP_GREEN_MIN_TURNOVER: '0.03',
        MILD_DIP_GREEN_MIN_PC5M_PCT: '4',
        // n=22 live GREEN trades: pc5m<20 median −2.0% (n=13), pc5m>=20 median −22.5% (n=9).
        MILD_DIP_GREEN_MAX_PC5M_PCT: '20',
        // The same example had vol/liquidity=2.62; GREEN permits up to 6 vs dip 2.
        MILD_DIP_GREEN_ENTRY_MAX_VOL5M_TO_LIQ: '6',
        // The live prebuy moved >4%; allow the measured green chase envelope of 12%.
        MILD_DIP_GREEN_CHASE_PCT: '12',
        // 29/30 post-deploy GREEN candidates hit turn_dump_not_red_pc5m; GREEN momentum is not a red-dip signal.
        MILD_DIP_GREEN_TURN_DUMP_GATE: '0',
        // Impulsive GREEN entries do not use the dip-lane bounce ceiling; allow the full measured range.
        MILD_DIP_GREEN_MAX_COOLDOWN_BOUNCE_PCT: '100',
        MILD_DIP_GREEN_MIN_PC1H_PCT: '0',
        MILD_DIP_GREEN_REQUIRE_PC1H: '0',
        MILD_DIP_GREEN_MIN_BUYS5M: '0',
        // n=22 live GREEN trades: buy-share>0.65 median −31.2% (n=5), <=0.65 median −6.3% (n=17).
        MILD_DIP_GREEN_MAX_BUY_SHARE: '0.65',
        // GREEN exit tightening: arm +2%, trail 4%, no-move cut at 10m,
        // catastrophic stop −45%, max hold 60m.
        MILD_DIP_GREEN_EXIT_TRAIL_ENABLED: '1',
        MILD_DIP_GREEN_EXIT_ARM_PCT: '2',
        MILD_DIP_GREEN_EXIT_TRAIL_PCT: '4',
        MILD_DIP_GREEN_EXIT_STOP_PCT: '45',
        MILD_DIP_GREEN_EXIT_MAX_HOLD_MS: '3600000',
        MILD_DIP_GREEN_NO_MOVE_CUT_MS: '600000',
        MILD_DIP_GREEN_NO_MOVE_MIN_MFE_PCT: '2',
        // The 30/hour cap cut live GREEN entries when buysInHour reached 30.
        MILD_DIP_GREEN_MAX_OPEN: '8',
        MILD_DIP_GREEN_MAX_BUYS_PER_HOUR: '60',
        // 1.11.1001 — bounded copy lane; rollback is MILD_DIP_MIRROR_ENABLED='0'.
        MILD_DIP_MIRROR_ENABLED: '0',
        MILD_DIP_MIRROR_LEADERS: '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
        MILD_DIP_MIRROR_LEADER_MAX_AGE_MS: '45000',
        MILD_DIP_MIRROR_OBSERVE_MS: '45000',
        MILD_DIP_MIRROR_QUOTE_INTERVAL_MS: '3000',
        MILD_DIP_MIRROR_QUOTE_MAX_AGE_MS: '10000',
        MILD_DIP_MIRROR_MIN_LIQUIDITY_USD: '4000',
        MILD_DIP_MIRROR_MIN_PAIR_AGE_HOURS: '1',
        MILD_DIP_MIRROR_MIN_MCAP_USD: '50000',
        MILD_DIP_MIRROR_MAX_OPEN: '8',
        MILD_DIP_MIRROR_MAX_QUOTE_MINTS: '8',
        MILD_DIP_MIRROR_TICK_INTERVAL_MS: '2000',
        MILD_DIP_MIRROR_STRUCTURAL_MAX_MINTS: '4',
        MILD_DIP_MIRROR_STRUCTURAL_GAP_MS: '5000',
        MILD_DIP_MIRROR_POSITION_USD: '30',
        MILD_DIP_MIRROR_MAX_ENTRY_PC5M_PCT: '0',
        MILD_DIP_MIRROR_MAX_PC5M_PCT: '0',
        MILD_DIP_MIRROR_ENTRY_GRACE_MS: '60000',
        MILD_DIP_MIRROR_ENTRY_GRACE_MAX_PREMIUM_PCT: '1',
        MILD_DIP_MIRROR_MAX_VOL5M_TO_LIQ: '2',
        MILD_DIP_MIRROR_REQUIRE_DEEP_DUMP: '0',
        MILD_DIP_MIRROR_DEEP_DUMP_PCT: '-8',
        MILD_DIP_MIRROR_GREEN_IMPULSE_PCT: '5',
        MILD_DIP_MIRROR_RUNUP_PC5M_PCT: '10',
        MILD_DIP_MIRROR_MAX_PREMIUM_PCT: '2',
        MILD_DIP_MIRROR_COOLDOWN_MS: '900000',
        MILD_DIP_MIRROR_EXIT_ARM_PCT: '2',
        MILD_DIP_MIRROR_EXIT_TRAIL_PCT: '4',
        MILD_DIP_MIRROR_EXIT_STOP_PCT: '45',
        MILD_DIP_MIRROR_NO_MOVE_CUT_MS: '600000',
        MILD_DIP_MIRROR_NO_MOVE_MIN_MFE_PCT: '2',
        MILD_DIP_MIRROR_MAX_HOLD_MS: '3600000',
        // 1.11.1003 — rollback: MILD_DIP_LSTYLE_ENABLED='0'.
        MILD_DIP_LSTYLE_ENABLED: '1',
        MILD_DIP_LSTYLE_POSITION_USD: '5',
        MILD_DIP_LSTYLE_MIN_VOL5M_TO_LIQ: '0.15',
        MILD_DIP_LSTYLE_MIN_LIQUIDITY_USD: '6000',
        MILD_DIP_LSTYLE_MAX_LIQUIDITY_USD: '400000',
        MILD_DIP_LSTYLE_PULLBACK_PCT: '5',
        MILD_DIP_LSTYLE_PULLBACK_WINDOW_MS: '120000',
        // Rollback: MILD_DIP_LSTYLE_MIN_RING_SPAN_MS='0' restores the pullback-window requirement.
        MILD_DIP_LSTYLE_MIN_RING_SPAN_MS: '60000',
        MILD_DIP_LSTYLE_MIN_PAIR_AGE_MS: '300000',
        MILD_DIP_LSTYLE_MAX_OPEN: '10',
        MILD_DIP_LSTYLE_MAX_BUYS_PER_HOUR: '60',
        MILD_DIP_LSTYLE_PROFIT_REBOUND_PCT: '25',
        MILD_DIP_LSTYLE_PNL_TP_PCT: '20',
        MILD_DIP_LSTYLE_VOL_FADE_RATIO: '0.35',
        MILD_DIP_LSTYLE_DEPTH_DRAIN_MAX: '1.06',
        MILD_DIP_LSTYLE_MAX_HOLD_MS: '14400000',
        MILD_DIP_STREAM_DEX_MAX_DIVERGENCE_FACTOR: '2',
        MILD_DIP_LSTYLE_MAX_ENRICH: '12',
        MILD_DIP_LSTYLE_ENRICH_CONCURRENCY: '4',
        MILD_DIP_LSTYLE_SKIP_JOURNAL_INTERVAL_MS: '60000',
        MILD_DIP_LSTYLE_SKIP_JOURNAL_MAX_PER_HOUR: '60',
        /**
         * 1.11.955 — one decision per losing bag: sell the full sleeve after
         * its qualifying reclaim, avoiding a second same-price fee. Rollback
         * to '0.5' restores the historical half-first behavior.
         */
        MILD_DIP_EXIT_MFE_BANK_SLEEVE_LOSS_PARTIAL_FRACTION: '0',
        /** 1.11.755 — freefall off (option-2). */
        MILD_DIP_EXIT_NEVER_ARM_FREEFALL_PNL_PCT: '0',
        MILD_DIP_EXIT_NEVER_ARM_FREEFALL_MIN_MS: '0',
        /**
         * 1.11.792 — never-arm DOWN formula (7BNax ~44% cover):
         * held ≥ 5m AND pnl ≤ −15% AND Dex pc5m ≤ −5%.
         * Armed / MFE-bank trail unchanged. Missing pc5m → no fire.
         */
        /**
         * 1.11.900 — 900s, not 300s. Measured on the dips we and a leader both
         * entered within a minute of each other, so the same flush and not two
         * entries hours apart: 75 matched pairs, of which we stopped out of 30.
         *
         *   what we did              n    ours       theirs   they held
         *   stopped out (<=-5%)     30  -19.77%      -0.26%     15.5 min
         *   scratched (-5..+5%)     20   +1.81%      +5.27%      5.1 min
         *   banked (>+5%)           25   +9.41%      +3.90%     10.1 min
         *
         * On the bags that worked our exit beats theirs, +9.41% against +3.90%.
         * On the bags that did not, we realised -19.77% where they came out
         * around flat, having given it three times as long. Our median hold on
         * these was 4.8 minutes, which is this gate firing at its floor.
         *
         * A replay of every tape agrees on direction: against no time cut at
         * all, the rule at 300s costs -6.37 USD over 24h, at 900s -0.84, at
         * 1200s nothing. It still helps the typical position on a trimmed mean
         * at every setting, so it stays - it just stops firing at five minutes.
         */
        // 1.11.995 — disable the −$93/7d time-red branch; rollback: '900000'.
        MILD_DIP_EXIT_NEVER_ARM_TIME_RED_MIN_MS: '0',
        MILD_DIP_EXIT_NEVER_ARM_TIME_RED_PNL_PCT: '15',
        MILD_DIP_EXIT_NEVER_ARM_TIME_RED_MAX_PC5M_PCT: '5',
        /**
         * 1.11.791 — max-hold / underwater time ceiling OFF.
         * Never-arm loss uses HELD+PC+SL; green armed trail may wait.
         */
        /**
         * 1.11.901 — three hours. This is the only ceiling on how long a bag may
         * sit: it closes an unarmed bag outright, and an armed one when its gain
         * is at or below zero.
         *
         * For positions still open at each age, what they were worth then
         * against what they ended up worth, over 835 closed positions in 36h:
         *
         *   age    still on   gain then   gain at end
         *   30m         283      -2.86%       -2.06%
         *   60m         139      -2.56%       -2.84%
         *   120m         59      -3.13%       -3.00%
         *   180m         33      -4.52%       -7.36%
         *   240m         19      -3.49%      -11.78%
         *
         * Waiting is roughly free up to two hours and then turns: a bag still
         * open at three hours gives back another 2.8 points, at four hours 8.3.
         *
         * Cutting earlier is measurably harmful - a replay of every tape puts
         * leaving at 30 minutes at -0.207 per position on a trimmed mean, and at
         * 60 minutes -0.007 - so the ceiling goes where the tape turns, not where
         * the pile is most annoying. It reaches about thirty bags per 36h.
         */
        MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS: '5400000',
        MILD_DIP_EXIT_HARD_TIME_STOP_MS: '5400000',
        /**
         * 1.11.734 — oneshot emptied-bag dump grace:
         * Stream sell that empties a wallet (post≈0) and ≥$500 → defer
         * peak_giveback for 60s (leaders ignore one-shot whale dumps).
         * cliff_dump still fires. Set GRACE=0 to disable.
         */
        MILD_DIP_ONESHOT_DUMP_GRACE: '1',
        MILD_DIP_ONESHOT_DUMP_GRACE_MS: '60000',
        /** 1.11.767 — sell unmanaged *pump ATAs not in state.open on boot. */
        MILD_DIP_ORPHAN_SWEEP: '1',
        MILD_DIP_ORPHAN_SWEEP_MAX_SELLS: '25',
        MILD_DIP_ONESHOT_DUMP_MIN_SELL_USD: '500',
        MILD_DIP_ONESHOT_DUMP_MAX_POST_RESIDUAL_FRAC: '0.02',
        /** 1.11.740 — soft giveback only after whale vs mass-flee classify. */
        MILD_DIP_DUMP_CLASSIFY: '1',
        MILD_DIP_DUMP_CLASSIFY_WAIT_MS: '5000',
        MILD_DIP_DUMP_CLASSIFY_WINDOW_MS: '30000',
        MILD_DIP_DUMP_CLASSIFY_MASS_MIN_SELLERS: '3',
        MILD_DIP_DUMP_CLASSIFY_WHALE_SHARE: '0.6',
        /**
         * 1.11.744 — defer soft exits while reclaiming off local trough
         * (5vkZWa never_arm_stale into green candles). cliff/timeout still fire.
         */
        /** 1.11.749 — OFF: blocked peak_giveback while above entry trough (5vkZWa). */
        MILD_DIP_RECOVER_DEFER: '1',
        MILD_DIP_RECOVER_DEFER_LOOKBACK_MS: '300000',
        MILD_DIP_RECOVER_DEFER_MIN_BOUNCE_PCT: '3',
        /**
         * 1.11.943 — 73YcBd9GX… stayed +32–37% above the trough and was
         * recover-deferred until an −83% rug; profitable exits bypass at +8%.
         */
        MILD_DIP_RECOVER_DEFER_MAX_PNL_PCT: '8',
        /**
         * 1.11.782 — NOT copytrading. Leader-seed does not open buys; align/
         * scale-in OFF. Observer may still log leaders for research only.
         */
        /**
         * 1.11.875 — the seed is attention, not a buy signal: the lane hands the
         * mint to our own structural + dip gates, which reject most of them. With
         * it off a name only reached us through stream / boosts / profiles, so
         * 49nkLrXi — traded by two leaders, sitting in our seed — had not one
         * journal row: never looked at, never skipped, simply absent.
         *
         * The observer snapshot serves the structural gate while it is fresh, so
         * the lane costs no Dex slots; the two bounds below stop it re-checking
         * the whole seed every scan.
         */
        MILD_DIP_LEADER_SEED_ENTRY: '1',
        MILD_DIP_LEADER_SEED_WAKE_MAX: '12',
        MILD_DIP_LEADER_SEED_RELOOK_MS: '60000',
        /**
         * 1.11.783 — after our exit keep mint on stream/knife wake 2h
         * (was ~10m via bounce lookback → 23e4CN knife at +61m invisible).
         */
        MILD_DIP_POST_EXIT_WAKE_MS: '7200000',
        MILD_DIP_POST_EXIT_WAKE_MAX: '48',
        MILD_DIP_LEADER_ALIGN: '0',
        MILD_DIP_LEADER_ALIGN_MAX_AGE_MS: '120000',
        MILD_DIP_LEADER_ALIGN_REQUIRE_RED_PCT: '3',
        MILD_DIP_LEADER_ALIGN_MIN_BELOW_ENTRY_PCT: '0',
        MILD_DIP_LEADER_ALIGN_REQUIRE_ADD: '0',
        MILD_DIP_LEADER_ALIGN_SCALE_IN: '0',
        MILD_DIP_LEADER_ALIGN_SCALE_IN_USD: '10',
        /**
         * 1.11.686 — sole Dex/Jupiter/Helius consumer: floor cadence + concurrency.
         * Dex hard-capped at 120 RPM; mark uses cache TTL ≈ interval.
         */
        /** Background lane only — entries owned by stream/leader fast-path. */
        MILD_DIP_SCAN_INTERVAL_MS: '3000',
        /**
         * 1.11.740 — dump classify before peak_giveback (whale vs mass).
         * Was Dex-only + scan-blocked → real gaps ~60s (2qE4vp −17% giveback).
         */
        MILD_DIP_MARK_INTERVAL_MS: '1000',
        /**
         * 1.11.769 — exit marks = price ring only (stream + fill seed).
         * Never await Dex on mark pass (that built the 20–60s gate queue).
         */
        MILD_DIP_MARK_STREAM_MAX_AGE_MS: '120000',
        // Rollback: set both signal freshness thresholds to '0' (disabled).
        MILD_DIP_ENTRY_SIGNAL_MARK_MAX_AGE_MS: '45000',
        MILD_DIP_ENTRY_SIGNAL_MAX_DIVERGENCE_PCT: '15',
        MILD_DIP_MARK_STREAM_PREFER_MAX_AGE_MS: '15000',
        // Background Dex→ring for open bags when stream quiet (0 = off).
        /**
         * 1.11.926 — 2s → 1s mark cadence + Jupiter sell quote every 2s when
         * stream quiet. 4kZdVs: Dex-only ring missed the green candle; peak stuck
         * at wait_dip trough → mfePct=0 → dead_set_bounce instead of giveback.
         */
        MILD_DIP_MARK_DEX_REFRESH_MS: '1000',
        MILD_DIP_MARK_CACHE_TTL_MS: '2000',
        MILD_DIP_MARK_JUPITER_REFRESH_MS: '2000',
        MILD_DIP_MARK_JUPITER_PROBE_USD: '1',
        MILD_DIP_MARK_JUPITER_MAX_IN_FLIGHT: '2',
        MILD_DIP_MARK_JUPITER_STREAM_QUIET_MS: '5000',
        MILD_DIP_MARK_ARMED_MAX_AGE_MS: '10000',
        MILD_DIP_MARK_JUMP_CONFIRM_MAX_MS: '8000',
        /** 1.11.959 — refresh Jupiter immediately after a quarantined mark. */
        MILD_DIP_MARK_QUARANTINE_JUPITER_GAP_MS: '2000',
        /** 1.11.959 — cap green armed quarantine blindness at 10s. */
        MILD_DIP_EXIT_MARK_QUARANTINE_GREEN_MAX_MS: '10000',
        /** Peak/exit always journaled; otherwise ≤1 row / 5s / mint. */
        MILD_DIP_MARK_JOURNAL_MS: '5000',
        MILD_DIP_MARK_CONCURRENCY: '48',
        MILD_DIP_ENRICH_CONCURRENCY: '6',
        /**
         * 1.11.871 — 20. 1.11.863 took this to 60 on the argument that the
         * batch path can carry 3_600 mints a minute against a 120 RPM ceiling.
         * Measured five hours later, that was wrong in practice:
         *
         *   before (12): 37.9 scans/min, 411 mints, 1.6% null, revisit 82.0s
         *   after  (60): 50.4 scans/min, 572 mints, 35.5% null, revisit 94.1s
         *
         * The extra slots went into the tail of the candidate list, which
         * DexScreener has no data for, so a third of every pass came back
         * empty and the revisit gap on the names that matter got *worse*.
         * 20 keeps the throttle fix (3s cadence instead of a 15s floor with
         * opens, which is the change that actually mattered) without spending
         * the budget on mints the API cannot answer for.
         */
        MILD_DIP_ENRICH_MAX: '20',
        /** Scan floor while positions are open; was hard-coded to 15s. */
        MILD_DIP_SCAN_INTERVAL_WITH_OPENS_MS: '3000',
        MILD_DIP_SELL_CONCURRENCY: '6',
        /** Stream/leader fast-path — skip Dex enrich batch. */
        MILD_DIP_FAST_PATH: '1',
        MILD_DIP_FAST_PATH_CHASE_PCT: '4',
        /** Keep bounce guard on fast-path — reclaim candles are not dumps. */
        MILD_DIP_FAST_PATH_SKIP_BOUNCE: '0',
        /** After full exit: rebuy only if mark ≥20% below exit (15m memory). */
        /** 1.11.757 — rebuy if ≥10% below last exit (was 20%; Sheep 09:15 miss). */
        /**
         * 1.11.908 — off. The gate demanded the price sit 10% below our last exit
         * before we could re-enter, on the assumption that cheaper is better. Our
         * own book says the opposite. Every buy, priced against our own first entry
         * on that coin:
         *
         *                     last 24h   last 48h   whole journal
         *   first buy          -0.1423    -0.0961      -0.1156   USD/pos
         *   below first        -0.0417    -0.0501      -0.0334
         *   above first        -0.0361    -0.0249      -0.0083
         *
         * Re-entering a name that has recovered above our first price is our best
         * population, four times better per position than re-entering one that has
         * kept falling, and the ordering holds in all three windows. The gate was
         * steering us into the worse half by construction.
         *
         * 1.11.983 — back on at 5%, measured on the exit we take rather than on
         * our first entry. Over 7 days, 945 of our buys (24%) were the same mint
         * inside 15 minutes of our own full exit: the 216 that paid more than we
         * had just sold for lost $40.43, and the whole slice cheaper by less than
         * 5% lost $21.28 on 6 of 8 days, while the slice ≥5% cheaper was flat.
         * 92vgKc went out on peak_giveback at +35.4% and the green lane bought it
         * back 61 seconds later 0.9% higher.
         */
        /**
         * 1.11.1001 — repeat entries may re-enter at any price after a full
         * exit. Rollback: '5'.
         */
        MILD_DIP_REBUY_BELOW_EXIT_PCT: '5',
        MILD_DIP_REBUY_BELOW_EXIT_MAX_AGE_MS: '900000',
        /** 1.11.797 — after loss exit: skip rebuy when Dex liq fell vs exit. */
        MILD_DIP_REBUY_LIQ_DROP: '1',
        MILD_DIP_REBUY_LIQ_DROP_MAX_AGE_MS: '21600000',
        /**
         * 1.11.821 — 0 → 25. Any liquidity dip vs our exit locked the mint out
         * for 6h: 17 004 blocks across 56 mints in 12h, median drop 22.9%. That
         * is normal pump-name noise, not a rug signal, and it is the single
         * biggest reason we miss re-entries the leaders take.
         */
        MILD_DIP_REBUY_LIQ_DROP_MIN_DROP_PCT: '25',
        MILD_DIP_REBUY_LIQ_DROP_ONLY_LOSS: '1',
        MILD_DIP_FAST_PATH_MIN_GAP_MS: '2000',
        /** No soft-ban after impact/sim fail — retry next tick (Jupiter, not Helius). */
        MILD_DIP_FAST_PATH_SOFT_SKIP_MS: '0',
        /** Stream-only main band must be ≤ −10% ring dump. */
        /** 1.11.773 — align with turn-dump shallow floor (was −10). */
        MILD_DIP_STREAM_ONLY_MAX_DIP_PCT: '-2',
        /**
         * 1.11.731/779 — Dex confirm still preferred; when Dex lags/flat,
         * near-trough fallback allows stream-only (early dump before leader).
         * Green Dex hard-blocks. JBKWfC reclaim fails near-trough (bounced).
         */
        MILD_DIP_STREAM_ONLY_REQUIRE_DEX_DIP: '1',
        /** 1.11.773 — align with turn-dump shallow floor (was −8). */
        MILD_DIP_STREAM_ONLY_DEX_MAX_DIP_PCT: '-2',
        MILD_DIP_STREAM_ONLY_ALLOW_MISSING_DEX: '1',
        MILD_DIP_STREAM_ONLY_BLOCK_DEX_GREEN: '1',
        MILD_DIP_STREAM_ONLY_NEAR_TROUGH: '1',
        MILD_DIP_STREAM_ONLY_NEAR_TROUGH_MAX_BOUNCE_PCT: '3',
        MILD_DIP_STREAM_ONLY_MIN_SAMPLES: '3',
        /**
         * 1.11.790 — measure dump as peak→post-peak trough; reject pump wicks:
         * if rally into peak ≥12%, |dump| must cover ≥40% of that rally.
         * EjD5-class +30% pump / −2.7% wick → skip.
         */
        MILD_DIP_DUMP_RALLY_GATE_MIN_PCT: '12',
        MILD_DIP_DUMP_RALLY_MIN_FRAC: '0.4',
        /**
         * 1.11.801 — D2zNEW / 3XeNADY: H1 +46% pump, buy −10% off peak.
         * If Dex H1 ≥ +15%, dump must be ≤ −15% (not a shallow pullback).
         */
        MILD_DIP_DUMP_H1_PUMP_MIN_PCT: '15',
        /**
         * 1.11.863 — −8, was −15. On a coin up 15%+ on the hour we demanded a
         * −15% dip. Of 1666 leader buys already inside our −25..0 band, 503 sit
         * on such coins and their median dip there is −9.85%, so the old
         * requirement refused 22.9% of every in-band buy they made. −8 recovers
         * 10.8% of them and still keeps us off a shallow pullback in a pump.
         */
        MILD_DIP_DUMP_H1_PUMP_MIN_DUMP_PCT: '-8',
        MILD_DIP_FAST_PATH_STRUCTURAL_CACHE_MS: '8000',
        /**
         * 1.11.837 — stale structural reuse 30s → 120s.
         *
         * We are not blind to the universe: of 235 mints the leaders bought in a
         * 12h window we had 221 (94%) in our own journal, and 11 of the 14 we
         * missed were non-pump mints. What stops us is data, not coverage —
         * `structural_fetch_null` is 27% of every fast-path skip (25_222 of
         * 93_529) because DexScreener rate limits this host, and a 30s ceiling
         * threw away snapshots whose fields (liq, mcap, pair age, vol5m) do not
         * move on that scale.
         *
         * Limitation to watch: the snapshot also carries a price, so a stale
         * reuse means the band check can run on a price up to 120s old. The
         * pre-buy path refetches Dex and the price ring is fed by the stream, and
         * `structAgeMs` is now journalled on every structural skip so we can
         * check whether entries taken off older snapshots do worse. If they do,
         * this is the knob to put back.
         */
        MILD_DIP_FAST_PATH_STRUCTURAL_STALE_MS: '120000',
        /**
         * 1.11.1029 — при `structural_fetch_null` разрешён приоритизированный
         * GeckoTerminal fallback: 3933 отказа за ~3ч на 1558 mint-ах, из них
         * 172 на leader-триггерах; остальные были stream. В минуту требуется
         * медиана 21, p90 34, максимум 42 уникальных mint-а, а бесплатный
         * лимит источника около 30 запросов/мин, поэтому fallback ограничен
         * 20 запросами/мин и интервалом 30s на mint.
         */
        MILD_DIP_STRUCTURAL_FALLBACK_ENABLED: '1',
        MILD_DIP_STRUCTURAL_FALLBACK_MAX_PER_MIN: '20',
        MILD_DIP_STRUCTURAL_FALLBACK_MINT_GAP_MS: '30000',
        MILD_DIP_STRUCTURAL_FALLBACK_CACHE_TTL_MS: '15000',
        MILD_DIP_STRUCTURAL_FALLBACK_TIMEOUT_MS: '2500',
        /**
         * 1.11.713 — Dex-probe stream-hot mints even when local ring dd is
         * outside main band (throttled). Without this, Dex dumps only wake
         * via leader-seed (Agmu8X: 8zkg −31s, our fill on leader path).
         */
        MILD_DIP_FAST_PATH_HOT_DEX_PROBE_ENABLED: '1',
        MILD_DIP_FAST_PATH_HOT_DEX_PROBE_GAP_MS: '10000',
        MILD_DIP_FAST_PATH_HOT_DEX_PROBE_MAX_PER_MIN: '40',
        MILD_DIP_STREAM_PRICE_MIN_GAP_MS: '250',
        MILD_DIP_STREAM_PRICE_CONCURRENCY: '6',
        MILD_DIP_STREAM_PRICE_TX_RETRY_ENABLED: '1',
        MILD_DIP_STREAM_PRICE_TX_RETRY_MAX_ATTEMPTS: '2',
        MILD_DIP_STREAM_PRICE_TX_RETRY_DELAY_MS: '400',
        MILD_DIP_STREAM_PRICE_TX_RETRY_MAX_AGE_MS: '30000',
        /** Journal-only tape lane denominator; never routes into entry execution. */
        MILD_DIP_TAPE_SHADOW_ENABLED: '1',
        /**
         * Telegram ALERT [MILD_DIP_DEX] when mark pass is slow / opens high /
         * null-ratio high — signal to move mild-dip to the idle VPS.
         */
        MILD_DIP_LOAD_ALERT: '1',
        MILD_DIP_LOAD_ALERT_MARK_PASS_MS: '20000',
        MILD_DIP_LOAD_ALERT_OPEN_COUNT: '50',
        MILD_DIP_LOAD_ALERT_NULL_RATIO: '0.4',
        MILD_DIP_LOAD_ALERT_COOLDOWN_MS: '1800000',
        TELEGRAM_COOLDOWN_ALERT_MILD_DIP_DEX_MS: '1800000',
        /**
         * 1.11.717 — after close only 1m so bounce clip can re-enter
         * (was 5m win / 10m loss — blocked leader-style reclaim).
         */
        MILD_DIP_MINT_COOLDOWN_MS: '60000',
        MILD_DIP_LOSS_COOLDOWN_MS: '60000',
        /** Wallet-truth backtest: max 3 entries/mint/24h cuts churn + fees. */
        MILD_DIP_MAX_ENTRIES_PER_MINT_24H: '0',
        /**
         * 1.11.687 — during cooldown keep sampling stream/Dex prices; after
         * cooldown refuse rebuy if mark bounced >N% off the observed trough.
         */
        /**
         * 1.11.936 — 20: 6 blocked exactly the re-entry we want. After the
         * HXbqtb stop the mint ran 12–15% off the trough and every rebuy was
         * skipped with `cooldown_bounce=15.41%>max=6`, so the pump after our
         * own exit was unreachable.
         */
        /**
         * 1.11.1001 — do not block leader-style circles on a post-exit bounce.
         * Rollback: '20'.
         */
        MILD_DIP_MAX_COOLDOWN_BOUNCE_PCT: '0',
        MILD_DIP_COOLDOWN_BOUNCE_LOOKBACK_MS: '600000',
        /** Stream drawdown can satisfy dip band when Dex pc5m lags (liq/mcap still Dex). */
        MILD_DIP_STREAM_DIP_ENTRY: '1',
        MILD_DIP_STREAM_PRICE_SAMPLE: '1',
        /** 1.11.798/799 — need recent stream print (any in window; Dex may be last). */
        /** 1.11.802 — still on; Dex/TD dipSources skip the ring lock in code. */
        MILD_DIP_REQUIRE_STREAM_PRICE: '1',
        MILD_DIP_REQUIRE_STREAM_PRICE_MAX_AGE_MS: '120000',
        /** Memecoin clips move fast — 150bps sim-fails with Jupiter 6001/0x1771. */
        /**
         * 1.11.872 — 200 bps, was 500. We were telling Jupiter a fill 5% worse
         * than quoted was acceptable, and it took us up on it.
         *
         * Measured over 472 buys against the Dex mark standing a median 1.02s
         * before the fill: median overpay +1.81%, p75 +4.15%, p90 +7.5%, and
         * 70.8% of buys paid above the mark. That is not staleness, it is spread
         * plus the allowances below.
         *
         * The overpay predicts the outcome. Over 297 closed bags:
         *   entry 2–4% over:  54 bags, $/bag  +0.002
         *   entry 4–8% over:  46 bags, $/bag  −0.609, win 0.283
         *   entry  >8% over:  38 bags, $/bag  −0.406
         * Capping at 4% keeps 71.7% of bags and takes the total from −$76.79
         * to −$33.34.
         *
         * 259KArDP is the case in plain sight: mark 5.6020e-05, our fill
         * 5.7911e-05, so the bag read −3.27% four seconds in while the price
         * stood still for six minutes.
         */
        MILD_DIP_SLIPPAGE_BPS: '200',
        MILD_DIP_PREBUY_REVALIDATE: '1',
        /** Latency-tolerant chase (4% killed every liquid dump). */
        /** Chase allowance cut with it: 4%, matching the measured cap. */
        MILD_DIP_MAX_CHASE_PCT: '4',
        LIVE_BUY_MAX_CHASE_PCT: '10',
        LIVE_BUY_SIM_SLIPPAGE_RETRY_ATTEMPTS: '4',
        /**
         * 1.11.938 — 90 of 518 trail exits failed first-pass; 37 were slippage
         * errors (`custom program error 6001`). Give sells eight attempts, with
         * 50bps bumps, instead of losing the fill to the first quote.
         */
        LIVE_SELL_SIM_SLIPPAGE_RETRY_ATTEMPTS: '8',
        LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS: '50',
        LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS: '1500',
        /**
         * 1.11.711 — buy impact 3% (was 2). HYMQdB: 2.26% reject + 15s soft-skip
         * → fill +12% chase. Sell still NOT gated.
         */
        LIVE_BUY_MAX_PRICE_IMPACT_PCT: '3',
        LIVE_JUPITER_SWAP_PRIORITY_LEVEL: 'medium',
        /**
         * 1.11.833 — 0.00005 → 0.00002 SOL. A leg was costing 0.000055 SOL
         * ($0.011 at $200/SOL): 5_000 lamports of Solana base fee plus the full
         * 50_000 priority cap, i.e. we paid the cap every time. Now 25_000
         * total, ~$0.005.
         *
         * $0.001 per leg is not a tuning target — it is exactly the 5_000-lamport
         * base fee, so reaching it means paying *no* priority fee at all. That
         * trades gas for inclusion on a dumping coin, which is the opposite of
         * what 1.11.829/831 just bought.
         *
         * Headroom is measured, not assumed: over 4357 live legs, inclusion-class
         * failures (confirm_timeout / blockhash / send 429) were 30 = 0.69%, so we
         * are nowhere near the cliff. Watch that rate after this change — if it
         * climbs, this is the knob to put back.
         */
        LIVE_JUPITER_PRIORITY_MAX_SOL: '0.00002',
        MILD_DIP_MIN_FEE_SOL_RESERVE: '0.02',
        /**
         * 1.11.704 — if native SOL value < $5, Jupiter-swap $20 USDC→SOL.
         * Checked at most once per 6h (also runs soon after process start).
         */
        MILD_DIP_FEE_SOL_TOPUP: '1',
        /** 1.11.716 — check every 30m (was 6h; drained fee SOL bricked buys). */
        MILD_DIP_FEE_SOL_TOPUP_INTERVAL_MS: '1800000',
        MILD_DIP_FEE_SOL_TOPUP_MIN_USD: '5',
        MILD_DIP_FEE_SOL_TOPUP_BUY_USD: '20',
        /**
         * 1.11.782 — own universe only (no leaders in discover).
         * Observer seed file kept for research; entry path ignores it.
         */
        /**
         * 1.11.824 — `leaders` added as an ORDERING source, not extra budget.
         * `enrichMax` stays 12: the same twelve slots per pass now go first to
         * names a leader touched in the last 2h instead of twelve arbitrary
         * mints out of ~3800.
         *
         * Measured over 12h: of 220 mints the leaders opened we evaluated 203
         * (92%) at some point, but on 53 of them we had no event at all in the
         * ±15 min around their buy — the mint was in the universe, we were just
         * looking elsewhere that minute. Ordering, not coverage.
         */
        MILD_DIP_DISCOVER_SOURCES: 'stream,boosts,profiles,leaders',
        MILD_DIP_LEADER_SEED_PATH: path.join(root, 'data/milddip/leader-seed.json'),
        /**
         * 1.11.816 — 40 → 250. The seed is now an entry gate, not just a wake
         * hint: leaders open ~36 bags/h, so 40 slots covered barely an hour of
         * a 2h window and evicted names we were about to qualify.
         */
        MILD_DIP_LEADER_SEED_MAX: '250',
        MILD_DIP_LEADER_SEED_MAX_AGE_MS: '7200000',
        /**
         * 1.11.816 — trade only what a leader has touched in the last 2h.
         * 9.5h live: leader-seen mints +$9.82 (n=115, winrate 0.63) vs mints
         * no leader touched −$7.46 (n=56, winrate 0.52). The leader print was
         * already in our log before our buy in 115 of 183 trades (median age
         * 29m), so this is a causal gate, not hindsight.
         */
        /**
         * 1.11.818 — OFF. The 1.11.816 split was measured on trades we already
         * made; applying it at the top of the funnel is a different thing. Live:
         * 212 distinct mints reached the gate in 3.7 min, 22 passed, 0 buys —
         * our discovery universe and the leader seed overlap by ~10%.
         */
        /**
         * 1.11.827 — probe buys instead of a synthetic forward tape.
         * `rebuy_liq_drop` (1385/3h) and `rebuy_below_exit` (762/3h) are the
         * top re-entry blockers and we cannot price them: once a mint is
         * refused we stop marking it. Six $2 buys an hour ($12/h at risk)
         * answer it with real fills and real slippage. Tagged `probe` in the
         * journal so they never mix into the book's statistics.
         */
        MILD_DIP_PROBE_BLOCKED: '0',
        /**
         * 1.11.898 — $1 on a coin we have never closed a position in, against
         * the $3 clip everywhere else. Ordered by how many times we have traded
         * a mint, our own closed positions:
         *
         *   trade #     n     USD/pos    median   win
         *   1st       565    -0.2050    -2.95%   44%
         *   2nd       318    -0.0486    +0.18%   50%
         *   3rd       205    -0.0418    +1.87%   52%
         *   4th-6th   375    -0.0219    +1.02%   53%
         *   7th+      595    -0.0266    +2.36%   54%
         *
         * The first touch carries -115.82 USD of a -164 total and holds in every
         * window (-0.134/pos over 24h, -0.120 over 12h, repeats -0.019 to
         * +0.047). The leaders are the mirror image: their first trip on a mint
         * is their best, median +20.56% at a 65% win rate, and their top five
         * mints then carry a third of all their round trips.
         *
         * So the first trade is priced as the cost of finding out, not skipped -
         * without it there are no repeats.
         */
        /**
         * 1.11.1023 — first-touch is a cap on the liquidity curve, not a flat
         * clip: large pools may reach $10 while the $5 size floor still holds
         * thin pools. The power-law branch bypasses THICK/MICRO tier clips.
         */
        MILD_DIP_FIRST_TOUCH_POSITION_USD: '10',
        MILD_DIP_PROBE_BLOCKED_USD: '0',
        MILD_DIP_PROBE_BLOCKED_MAX_PER_HOUR: '6',
        /**
         * 1.11.829 — price rug risk instead of flat-sizing it. Over 774 closed
         * positions, 41 collapsed to −70% or worse and no gate we run could see
         * them coming: liquidity, mcap and liq/mcap are identical between the
         * rugs and the rest. The leaders we shadow eat rugs at twice our rate
         * (10.7% of their sessions vs 5.3%) and survive because they take these
         * names at $1–4 while their conviction clip is $10–27. We averaged $6.10
         * on a rug and $6.32 on everything else.
         *
         * Thresholds are the two slices that actually lose: pc5m below −45%
         * (n=19 at −60…−45 → mean −34.7%, winrate 0.11) and turnover above 3.0
         * (n=32 at 3…6 → −14.6%; n=9 above 6 → −28.4%). A −35% dump and a 1.5
         * turnover are *not* losing slices and stay at full size.
         *
         * Refusing outright stays off: entries below −85% were 6 positions with
         * zero rugs and 4 that reached +15%.
         *
         * Base clip is $5 since 1.11.828, so the knife tier is a 2.5x cut, not
         * the 5x the $10-era census measured. Direction holds, size is smaller.
         */
        /** 1.11.947 — rug-knife risk cap is no longer a sub-$3 live clip. */
        MILD_DIP_RUG_KNIFE_CLIP_USD: '3',
        MILD_DIP_RUG_KNIFE_DUMP_PCT: '-45',
        MILD_DIP_RUG_KNIFE_TURN: '3',
        MILD_DIP_RUG_BLOCK_DUMP_PCT: '0',
        /**
         * 1.11.997 — temporary owner-requested measure: remove the leader-seen
         * entry veto while we trade on our own thresholds. Over 3d,
         * mild_dip_not_leader_seen_skip blocked 13,487 mints / 186,810 events
         * versus 1,203 own buys; rollback by restoring both leader gates to '1'.
         */
        MILD_DIP_REQUIRE_LEADER_SEEN: '0',
        /**
         * 1.11.899 — a leader has to have touched a name before we open it for
         * the first time; repeats on names we know are not gated.
         *
         * Measured on our own closed positions, and the two effects are
         * independent rather than one standing in for the other:
         *
         *                          first trade      repeat
         *   leader has traded it     -0.1470       -0.0284   USD/pos
         *   only we trade it        -0.3068       -0.0436
         *
         * The first-touch penalty survives inside each column (five- and
         * seven-fold) and the no-leader penalty inside each row, so both are
         * real. Their intersection is the worst population we have: 205
         * positions, 10% of the volume, -62.89 USD of a -162 total, 41% win.
         *
         * 1.11.922 — OFF: we compete on stream/Dex hot dumps first; waiting for
         * a leader buy on first touch guarantees arriving after the move.
         */
        MILD_DIP_REQUIRE_LEADER_SEEN_FIRST_TOUCH: '0',
        /**
         * 1.11.906 — remember for a week that a leader traded a name.
         *
         * The gate above asks whether a leader finds a name worth trading at all,
         * and the measurement behind it asked exactly that - ever. The code read
         * the seed file, which is a two-hour view by design, so the gate was
         * stricter than its own evidence: of 20,614 rejections, 1,066 were names
         * the leaders had bought earlier than two hours. 78.2% were names no
         * leader ever bought, which is the gate working, and only 19 were inside
         * the window it was checking, so this is the one real defect in it.
         */
        MILD_DIP_LEADER_SEEN_MEMORY_MS: '604800000',
        MILD_DIP_REQUIRE_LEADER_SEEN_MAX_AGE_MS: '7200000',
        /**
         * 1.11.921 — solo buys (92.8% / 48h): turn<0.06 without leader in ±2m.
         * Requires fresh leader co-buy when turnover is below floor; age relax
         * from leaderSeen memory unchanged.
         */
        /**
         * 1.11.997 — temporary owner-requested measure: 2,693 co-buy skips
         * across 186 mints over 3d (median turnover 0.0338 vs 0.06 floor);
         * rollback by restoring both leader gates to '1'.
         */
        MILD_DIP_LEADER_CO_BUY_ALIGN: '0',
        MILD_DIP_LEADER_CO_BUY_ALIGN_MAX_MS: '120000',
        /** 1.11.945 — structural trust survives the measured 5–6m leader lag. */
        MILD_DIP_ENTRY_LEADER_TRUST_STRUCTURAL_MS: '600000',
        MILD_DIP_LEADER_CO_BUY_ALIGN_MIN_TURN: '0.06',
        /** Helius logsSubscribe → hot universe + signature price samples for trough. */
        MILD_DIP_STREAM: '1',
        ...(HELIUS_API_KEY_PM2 ? { HELIUS_API_KEY: HELIUS_API_KEY_PM2 } : {}),
        MILD_DIP_JOURNAL_PATH: path.join(root, 'data/milddip/journal.jsonl'),
        /** 1.11.786 — cash-accurate fills (us + leaders). CF / PnL truth. */
        MILD_DIP_TRADES_PATH: path.join(root, 'data/milddip/trades.jsonl'),
        MILD_DIP_STATE_PATH: path.join(root, 'data/milddip/state.json'),
        MILD_DIP_HOT_MINTS_PATH: path.join(root, 'data/milddip/hot-mints.json'),
        MILD_DIP_PRICE_RING_PATH: path.join(root, 'data/milddip/price-ring.json'),
        ...LIVE_OSCAR_HELIUS_RPC_ENV,
        ...(HELIUS_RPC_URL_PM2 ? { MILD_DIP_RPC_URL: HELIUS_RPC_URL_PM2 } : {}),
      },
    },
    /**
     * Shadow leader buy/sell observer for mild-dip (no trading).
     * 1.11.760 — buys+sells, quote-leg sizeUsd/fillPriceUsd, bag ledger,
     * session open/flat. Writes jsonl + leader-seed.json for discover `leaders`.
     * 1.11.778 — absolute tape: marks ON, denser poll/lookback/sigs, turnDump
     * + MFE/MAE on session flat for entry/exit formula RE.
     * 1.11.790 — 1Hz dense exit tape (`leader-dense-YYYYMMDD.jsonl`) via Jupiter
     * price + cached Dex features for overnight per-wallet exit formula RE.
     */
    {
      name: 'mild-dip-leader-observer',
      cwd: root,
      script: 'python3',
      args: 'scripts/milddip/leader-observer.py',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      /**
       * 1.11.820 — turned off because it was burning the shared DexScreener
       * quota one request per mint.
       * 1.11.823 — back on now that it batches 30 addresses per request
       * (~2 calls per pass instead of 60). It is the only source that can
       * answer how the leaders exit: how much drawdown they sit through, where
       * they take profit, how wide their trail is.
       */
      autostart: true,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10_000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        ...DEXSCREENER_GATE_ENV,
        LEADER_OBSERVER_OUT_DIR: path.join(root, 'data/milddip'),
        /** Dual-write canonical trade_fill / trade_roundtrip rows. */
        LEADER_OBSERVER_TRADES_PATH: path.join(root, 'data/milddip/trades.jsonl'),
        LEADER_OBSERVER_SEED_PATH: path.join(root, 'data/milddip/leader-seed.json'),
        /** 1.11.816 — must match MILD_DIP_LEADER_SEED_MAX; the seed is a gate now. */
        LEADER_OBSERVER_SEED_MAX: '250',
        LEADER_OBSERVER_SEED_MAX_AGE_SEC: '7200',
        /** 1.11.1029 — 2s polling trims the median observer detection lag (~4.4s). */
        LEADER_OBSERVER_POLL_SEC: '2',
        LEADER_OBSERVER_LOOKBACK_SEC: '1800',
        LEADER_OBSERVER_CATCHUP_PAGES: '12',
        LEADER_OBSERVER_SIG_LIMIT: '80',
        /** 0 = run until stopped (PM2 owns lifecycle). */
        LEADER_OBSERVER_MAX_HOURS: '0',
        /** 1.11.760 — log sells + session flat (was buy-only). */
        LEADER_OBSERVER_LOG_SELLS: '1',
        /** 1.11.1030 — optional holder concentration telemetry; disabled by default. */
        LEADER_OBSERVER_HOLDERS_ENABLED: '0',
        LEADER_OBSERVER_HOLDERS_MIN_GAP_SEC: '3600',
        /** Slow Dex snapshot marks (features refresh). */
        LEADER_OBSERVER_LOG_MARKS: '1',
        LEADER_OBSERVER_MARK_MIN_GAP_SEC: '60',
        /** 1.11.790 — opt-in second-level exit tape for formula recovery. */
        LEADER_OBSERVER_DENSE_TICKS: '0',
        LEADER_OBSERVER_DENSE_GAP_SEC: '1',
        LEADER_OBSERVER_DEX_REFRESH_SEC: '15',
        /** 0 = dense-tick ALL open bags (wins + losses); set 1 to TD-only. */
        /**
         * 1.11.823 — dense 1Hz tape only for turn→dump bags. That is the line
         * we are trying to copy, and it keeps the pass small enough that the
         * observer cannot starve the entry path again.
         */
        LEADER_OBSERVER_DENSE_ONLY_TD: '1',
        LEADER_OBSERVER_TELEMETRY_BUDGET_MS: '1800',
        LEADER_OBSERVER_TELEMETRY_DEAD_BAG_SEC: '21600',
        LEADER_OBSERVER_PRICE_URL: 'https://api.jup.ag/price/v3',
        /** 1.11.780 — match mild-dip leader-like structural floors. */
        LEADER_OBSERVER_MIN_MCAP_USD: '5000',
        LEADER_OBSERVER_MIN_LIQUIDITY_USD: '5000',
        LEADER_OBSERVER_MIN_VOL5M_USD: '300',
        MILD_DIP_MIN_MCAP_USD: '5000',
        MILD_DIP_MIN_LIQUIDITY_USD: '5000',
        MILD_DIP_MIN_VOLUME_5M_USD: '300',
        /** 1.11.712 — fix 7BNax typo (was missing `j`: …UYrAC… → …UYrjAC…). */
        LEADER_OBSERVER_LEADERS:
          '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ,7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5',
        ...PM2_JUPITER_KEY_ENV,
        ...LIVE_OSCAR_HELIUS_RPC_ENV,
        ...(HELIUS_RPC_URL_PM2
          ? {
              LEADER_OBSERVER_RPC_URL: HELIUS_RPC_URL_PM2,
              MILD_DIP_RPC_URL: HELIUS_RPC_URL_PM2,
            }
          : {}),
      },
    },
    {
      name: 'mild-dip-leader-green',
      cwd: root,
      script: 'python3',
      args: 'scripts/milddip/leader-green-observer.py',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      /**
       * 1.11.836 — green is ~32% of leader buys and the existing observer cannot
       * explain it: it only sees a mint *after* a leader bought, so every row in
       * the green corpus is a positive. `leader-green-entry-formula.md` reaches
       * ≥80% recall on both wallets and stalls at ~28% precision for exactly that
       * reason. This process samples a universe on a cadence and records matched
       * negatives — the same mints at the same timestamps that the leaders did
       * *not* buy.
       *
       * Price comes from Jupiter (separate quota, measured 40 prices in 0.09s),
       * because DexScreener is saturated: a single-mint probe on this host returns
       * 429 three times in a row while the bot paces itself to a healthy 10
       * marks/min. Structure (liq / mcap / age / vol5m) moves slowly, so it is
       * rationed to 3 DexScreener requests per minute against the bot's ~30.
       *
       * 1.11.876 — off. The lane it was built to justify never opened a position
       * (zero `green_momentum` buys in 7098 attempts), so its corpus is paying a
       * share of a saturated DexScreener quota for a strategy that does not
       * trade. Start it again when green is something we intend to run.
       */
      autostart: false,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10_000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        LEADER_GREEN_OUT_DIR: path.join(root, 'data/milddip'),
        LEADER_GREEN_SEED_PATH: path.join(root, 'data/milddip/leader-seed.json'),
        /** Jupiter price tape cadence — the fine-grained part of the signal. */
        /**
         * Jupiter without a key is free tier at 1 RPS. 320 mints is 8 batches of
         * 40, paced ~1.1s apart, so a cycle spends ~9s of its 20s on prices.
         */
        LEADER_GREEN_SAMPLE_SEC: '20',
        LEADER_GREEN_MAX_UNIVERSE: '320',
        /** Seed mints are the matched control: leaders know them and passed. */
        LEADER_GREEN_SEED_MAX_AGE_MS: '21600000',
        /** Hard ceiling on our DexScreener share. Raising this starves the bot. */
        LEADER_GREEN_MAX_DEX_REQ_PER_MIN: '3',
        LEADER_GREEN_STRUCT_TTL_SEC: '600',
        LEADER_GREEN_DISCOVERY_SEC: '300',
        LEADER_GREEN_DISCOVERY_RETRY_SEC: '45',
        /**
         * 1.11.839 — was '-2', which recorded only the green branch and threw the
         * dips away. Leaders run both, and the dip branch has the same missing
         * piece: the turn/dump formula fits 80.7% of their buys but its precision
         * on our own candidate stream is **6.9%** (23 of 335 signals were followed
         * by a leader buy within 60s). So the formula is a filter, not a selector,
         * and finding the selector needs dip candidates the leaders did *not* take.
         * Off (-100) records the whole range, ~+45% rows.
         */
        LEADER_GREEN_MIN_PC5M: '-100',
        LEADER_GREEN_STATS_SEC: '300',
        ...PM2_JUPITER_KEY_ENV,
      },
    },
    /**
     * knife-catcher / awakening-catcher — Oscar VPS REMOVED (2026-07-16).
     * Live lanes only on LERA (`/opt/lera` PM2). Oscar shared VPS was running shadow copies via `.env`
     * drift — deleted to free Dex/RPC for live-oscar discovery.
     */
];

/**
 * Mirror copytrading on a dedicated wallet, so it cannot mix with the DIP strategy.
 * Keep the base tuning aligned with mild-dip-bot; only wallet, state, and mirror-only
 * runtime settings differ.
 */
const mildDipBotApp = PM2_APPS.find((app) => app.name === 'mild-dip-bot');
function makeMirrorApp({
  name,
  walletSecret,
  walletPubkey,
  dataDir,
  leaders,
  ownExitEnabled,
  exitArmPct,
  exitTrailPct,
  ownExitTimeStopMs,
  lossCapUsd,
  lossCapDailyReset = '0',
  lossCapResetTzOffsetMin = '180',
  maxEntryPc5mPct,
  entryGraceMaxPremiumPct,
  maxPremiumPct = '1',
  greenMaxPremiumPct = '-1000',
  minLiquidityUsd,
  minVol5mUsd = '0',
  minPairAgeHours = '1',
  minMcapUsd,
  minPc1hPct,
  minPc5mPct,
  ladderStepPct,
  ladderStepAfterAvgPct,
  ladderSellFraction,
  ladderEnabled,
  ladderMaxRungs,
  dustCloseUsd,
  positionUsd,
  sizeLiqCoef,
  sizeLiqExp,
  sizeLiqMinUsd,
  sizeLiqMaxUsd,
  sizeLiqMaxPoolSharePct,
  averageUsd,
  averageLevelsPct = '',
  averageSizeMode = 'flat',
  averageMaxUsd = '0',
  averageMaxTimes = '1',
  crossLeaderAverageEnabled,
  crossLeaderAverageLeaders,
  crossLeaderAverageUsd,
  crossLeaderAverageStepsEnabled,
  crossLeaderAverageMinDiscountPct = '15',
  crossLeaderAverageMaxTimes = '3',
  averageMinDiscountPct = '30',
  tierEnabled,
  tierIgnoreStructuralFloors,
  tierPositionUsd,
  tierMaxOpen,
  structuralGatesEnabled = true,
  sizeFromLeaderFraction = '0',
  sizeFromLeaderMinUsd = '50',
  sizeFromLeaderMaxUsd = '200',
  sizeFromLeaderSmallMcapUsd = '0',
  sizeFromLeaderSmallClipUsd = '0',
  firstClipLegs = '2',
  executionStartSlippageBps = '0',
  greenInstantEnabled = '0',
  greenIgnoreLiquidityFloor = false,
  execPremiumSlackPct = '0',
  manualAdoptEnabled = false,
  maxVol5mToLiq = '2',
  firstTouchPositionUsd,
  fundingParkMax = '10',
  leaderOpenBagEnabled = '',
  leaderOpenBagRetryMs = '60000',
  leaderOpenBagMaxAgeMs = '21600000',
  leaderOpenBagMaxEntries = '60',
  leaderOpenBagMaxPerPass = '5',
  leaderOpenBagMinFreeUsd = '0',
}) {
  return {
    ...mildDipBotApp,
    name,
    env: {
      ...mildDipBotApp.env,
      MILD_DIP_APP_NAME: name,
      MILD_DIP_WALLET_SECRET: path.join(root, walletSecret),
      MILD_DIP_WALLET_PUBKEY: walletPubkey,
      MILD_DIP_LEADER_SEED_PATH: path.join(root, 'data/milddip/leader-seed.json'),
      MILD_DIP_JOURNAL_PATH: path.join(root, dataDir, 'journal.jsonl'),
      MILD_DIP_TRADES_PATH: path.join(root, dataDir, 'trades.jsonl'),
      MILD_DIP_STATE_PATH: path.join(root, dataDir, 'state.json'),
      MILD_DIP_HOT_MINTS_PATH: path.join(root, dataDir, 'hot-mints.json'),
      MILD_DIP_PRICE_RING_PATH: path.join(root, dataDir, 'price-ring.json'),
      MILD_DIP_STATE_SAVE_FAILURE_LIMIT: '3',
      MILD_DIP_DATA_RETENTION_ENABLED: '1',
      MILD_DIP_DATA_RETENTION_COMPRESS_AFTER_DAYS: '1',
      MILD_DIP_DATA_RETENTION_DELETE_AFTER_DAYS: '7',
      MILD_DIP_DATA_RETENTION_DELETE_ENABLED: '1',
      MILD_DIP_DATA_RETENTION_INTERVAL_MS: '21600000',
      MILD_DIP_DATA_DISK_GUARD_ENABLED: '1',
      /** 1.11.1041 — emergency retention starts before the disk reaches exhaustion. */
      MILD_DIP_DATA_MIN_FREE_BYTES: '8589934592',
      MILD_DIP_DATA_MIN_FREE_PCT: '10',
      MILD_DIP_DATA_EMERGENCY_ENABLED: '1',
      MILD_DIP_DATA_EMERGENCY_KEEP_DAYS: '2',
      MILD_DIP_JOURNAL_MAX_BYTES: '536870912',
      MILD_DIP_TRADES_MAX_BYTES: '268435456',
      MILD_DIP_MIRROR_ENABLED: '1',
      MILD_DIP_MIRROR_ONLY: '1',
      MILD_DIP_MIRROR_OWN_STRUCTURAL_ENABLED: '1',
      MILD_DIP_STRUCTURAL_FALLBACK_ENABLED: '1',
      MILD_DIP_MIRROR_GREEN_COPY_ENABLED: '0',
      MILD_DIP_MIRROR_REQUIRE_DIP_CANDLE: '0',
      MILD_DIP_MIRROR_STRUCTURAL_GATES_ENABLED: structuralGatesEnabled ? '1' : '0',
      MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT: '3',
      MILD_DIP_MIRROR_GREEN_MAX_PC5M_PCT: '40',
      LIVE_CONFIRM_TIMEOUT_MS: '15000',
      MILD_DIP_MIRROR_EXIT_REFIRE_MAX: '2',
      MILD_DIP_MIRROR_LEADER_SELL_ENABLED: '1',
      MILD_DIP_MIRROR_LEADER_SELL_TRADES_PATH: path.join(root, 'data/milddip/trades.jsonl'),
      MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_INTERVAL_MS: '30000',
      MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_WINDOW_MS: '3600000',
      MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_TAIL_BYTES: '2097152',
      MILD_DIP_MIRROR_LEADER_SELL_ONLY: '1',
      MILD_DIP_MIRROR_LEADER_BALANCE_GUARD_ENABLED: '1',
      MILD_DIP_MIRROR_OBSERVATION_MAX_AGE_MS: '120000',
      MILD_DIP_MIRROR_LEADER_BALANCE_RECONCILE_ENABLED: '1',
      MILD_DIP_MIRROR_LEADER_BALANCE_RECONCILE_INTERVAL_MS: '60000',
      MILD_DIP_MIRROR_LEADER_BALANCE_RECONCILE_CONFIRMATIONS: '2',
      MILD_DIP_MIRROR_LEADER_BALANCE_RECONCILE_MIN_HOLD_MS: '30000',
      MILD_DIP_MIRROR_LEADER_BALANCE_RECONCILE_MAX_PER_PASS: '4',
      MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT: '2',
      MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS: '86400000',
      MILD_DIP_GREEN_ENABLED: '0',
      MILD_DIP_LSTYLE_ENABLED: '0',
      MILD_DIP_FAST_PATH: '0',
      MILD_DIP_STREAM: '0',
      MILD_DIP_STREAM_PRICE_SAMPLE: '0',
      MILD_DIP_TAPE_SHADOW_ENABLED: '0',
      MILD_DIP_DISCOVER_SOURCES: '',
      MILD_DIP_LEADER_SEED_ENTRY: '0',
      MILD_DIP_MIRROR_LEADERS: leaders,
      MILD_DIP_MIRROR_LEADER_MAX_AGE_MS: '45000',
      MILD_DIP_MIRROR_OBSERVE_MS: '86400000',
      MILD_DIP_MIRROR_LEADER_FILL_GRACE_MS: '60000',
      MILD_DIP_MIRROR_MIN_LEADER_SIZE_USD: '20',
      MILD_DIP_MIRROR_QUOTE_INTERVAL_MS: '1000',
      MILD_DIP_MIRROR_STALE_QUOTE_INTERVAL_MS: '5000',
      MILD_DIP_MIRROR_QUOTE_MAX_AGE_MS: '4000',
      MILD_DIP_MIRROR_MIN_LIQUIDITY_USD: minLiquidityUsd,
      MILD_DIP_MIRROR_MIN_VOL5M_USD: minVol5mUsd,
      MILD_DIP_MIRROR_MIN_PAIR_AGE_HOURS: minPairAgeHours,
      MILD_DIP_MIRROR_MIN_MCAP_USD: minMcapUsd,
      MILD_DIP_MIRROR_MAX_OPEN: '0',
      MILD_DIP_MIRROR_MAX_QUOTE_MINTS: '8',
      MILD_DIP_MIRROR_FUNDING_PARK_ENABLED: '1',
      MILD_DIP_MIRROR_FUNDING_PARK_RETRY_MS: '30000',
      MILD_DIP_MIRROR_FUNDING_PARK_MAX: fundingParkMax,
      MILD_DIP_MIRROR_TICK_INTERVAL_MS: '1000',
      MILD_DIP_MIRROR_STRUCTURAL_MAX_MINTS: '4',
      MILD_DIP_MIRROR_STRUCTURAL_GAP_MS: '2000',
      MILD_DIP_MIRROR_POSITION_USD: positionUsd,
      MILD_DIP_MIRROR_SIZE_LIQ_COEF: sizeLiqCoef,
      MILD_DIP_MIRROR_SIZE_LIQ_EXP: sizeLiqExp,
      MILD_DIP_MIRROR_SIZE_MIN_USD: sizeLiqMinUsd,
      MILD_DIP_MIRROR_SIZE_MAX_USD: sizeLiqMaxUsd,
      MILD_DIP_MIRROR_SIZE_MAX_POOL_SHARE_PCT: sizeLiqMaxPoolSharePct,
      MILD_DIP_MIRROR_SIZE_FROM_LEADER_FRACTION: sizeFromLeaderFraction,
      MILD_DIP_MIRROR_SIZE_FROM_LEADER_MIN_USD: sizeFromLeaderMinUsd,
      MILD_DIP_MIRROR_SIZE_FROM_LEADER_MAX_USD: sizeFromLeaderMaxUsd,
      MILD_DIP_MIRROR_SIZE_FROM_LEADER_SMALL_MCAP_USD: sizeFromLeaderSmallMcapUsd,
      MILD_DIP_MIRROR_SIZE_FROM_LEADER_SMALL_CLIP_USD: sizeFromLeaderSmallClipUsd,
      MILD_DIP_MIRROR_FIRST_CLIP_LEGS: firstClipLegs,
      MILD_DIP_MIRROR_MAX_ENTRY_PC5M_PCT: maxEntryPc5mPct,
      MILD_DIP_MIRROR_MAX_PC5M_PCT: '0',
      MILD_DIP_MIRROR_MIN_PC1H_PCT: minPc1hPct,
      MILD_DIP_MIRROR_MIN_PC5M_PCT: minPc5mPct,
      MILD_DIP_MIRROR_ENTRY_GRACE_MS: '60000',
      MILD_DIP_MIRROR_ENTRY_GRACE_MAX_PREMIUM_PCT: entryGraceMaxPremiumPct,
      MILD_DIP_MIRROR_MAX_VOL5M_TO_LIQ: maxVol5mToLiq,
      MILD_DIP_MIRROR_REQUIRE_DEEP_DUMP: '0',
      MILD_DIP_MIRROR_DEEP_DUMP_PCT: '-8',
      MILD_DIP_MIRROR_GREEN_IMPULSE_PCT: '5',
      MILD_DIP_MIRROR_RUNUP_PC5M_PCT: '10',
      MILD_DIP_MIRROR_KNIFE_WAIT_ENABLED: '1',
      MILD_DIP_MIRROR_KNIFE_WAIT_PC5M_PCT: '-10',
      MILD_DIP_MIRROR_KNIFE_WAIT_DISCOUNT_PCT: '2',
      MILD_DIP_MIRROR_KNIFE_WAIT_WINDOW_MS: '600000',
      MILD_DIP_MIRROR_KNIFE_WAIT_QUOTE_SLOTS: '3',
      MILD_DIP_MIRROR_MAX_PREMIUM_PCT: maxPremiumPct,
      MILD_DIP_MIRROR_EXEC_PREMIUM_SLACK_PCT: execPremiumSlackPct,
      MILD_DIP_MIRROR_GREEN_MAX_PREMIUM_PCT: greenMaxPremiumPct,
      MILD_DIP_MIRROR_EXEC_START_SLIPPAGE_BPS: executionStartSlippageBps,
      MILD_DIP_MIRROR_GREEN_INSTANT_ENABLED: greenInstantEnabled,
      ...(greenIgnoreLiquidityFloor
        ? { MILD_DIP_MIRROR_GREEN_IGNORE_LIQUIDITY_FLOOR: '1' }
        : {}),
      ...(manualAdoptEnabled
        ? { MILD_DIP_MIRROR_MANUAL_ADOPT: '1' }
        : {}),
      MILD_DIP_MAX_CHASE_PCT: '6',
      MILD_DIP_MIRROR_RETRY_WHILE_LEADER_HOLDS: '1',
      MILD_DIP_MIRROR_LADDER_STEP_PCT: ladderStepPct,
      MILD_DIP_MIRROR_LADDER_STEP_AFTER_AVG_PCT: ladderStepAfterAvgPct,
      MILD_DIP_MIRROR_LADDER_SELL_FRACTION: ladderSellFraction,
      MILD_DIP_MIRROR_LADDER_ENABLED: ladderEnabled,
      MILD_DIP_MIRROR_LADDER_MAX_RUNGS: ladderMaxRungs,
      MILD_DIP_MIRROR_LADDER_DUST_USD: '1',
      MILD_DIP_MIRROR_LADDER_MIN_SETTLE_SEC: '45',
      MILD_DIP_MIRROR_DUST_CLOSE_USD: dustCloseUsd,
      MILD_DIP_DUST_BURN_ENABLED: '1',
      MILD_DIP_DUST_BURN_MAX_USD: '0.5',
      MILD_DIP_DUST_BURN_MAX_PER_PASS: '20',
      MILD_DIP_DUST_BURN_MIN_AGE_MS: '21600000',
      MILD_DIP_DUST_BURN_SETTLE_MS: '600000',
      MILD_DIP_DUST_BURN_INTERVAL_MS: '21600000',
      MILD_DIP_ORPHAN_SELL_MIN_USD: '0.5',
      MILD_DIP_ORPHAN_SELL_INTERVAL_MS: '21600000',
      MILD_DIP_MIRROR_AVERAGE_ENABLED: '1',
      MILD_DIP_MIRROR_AVERAGE_USD: averageUsd,
      MILD_DIP_MIRROR_AVERAGE_LEVELS_PCT: averageLevelsPct,
      MILD_DIP_MIRROR_AVERAGE_SIZE_MODE: averageSizeMode,
      MILD_DIP_MIRROR_AVERAGE_MAX_USD: averageMaxUsd,
      MILD_DIP_MIRROR_CASH_RECONCILE_INTERVAL_MS: '300000',
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_ENABLED: crossLeaderAverageEnabled,
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_LEADERS: crossLeaderAverageLeaders,
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_USD: crossLeaderAverageUsd,
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_STEPS_ENABLED: crossLeaderAverageStepsEnabled,
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_DISCOUNT_PCT: crossLeaderAverageMinDiscountPct,
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_AGE_MS: '300000',
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_START_FRACTION: '0.3',
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_FULL_DISCOUNT_PCT: '50',
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_TOTAL_FRACTION: '1',
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_TIMES: crossLeaderAverageMaxTimes,
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_LEADER_SIZE_USD: '20',
      MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_STEP_USD: '3',
      MILD_DIP_MIRROR_TIER_ENABLED: tierEnabled,
      MILD_DIP_MIRROR_TIER_IGNORE_FLOORS: tierIgnoreStructuralFloors,
      MILD_DIP_MIRROR_TIER_POSITION_USD: tierPositionUsd,
      MILD_DIP_MIRROR_TIER_MAX_OPEN: tierMaxOpen,
      MILD_DIP_MIRROR_TIER_PARK_ENABLED: '1',
      MILD_DIP_MIRROR_AVERAGE_WINDOWS_MS: '3600000,7200000,10800000,14400000,21600000',
      MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS: '120000',
      MILD_DIP_MIRROR_AVERAGE_TOLERANCE_PCT: '2',
      MILD_DIP_MIRROR_AVERAGE_DEEP_DISCOUNT_ENABLED: '1',
      MILD_DIP_MIRROR_AVERAGE_MAX_PRICE_IMPACT_PCT: '5',
      MILD_DIP_MIRROR_AVERAGE_MAX_TIMES: averageMaxTimes,
      MILD_DIP_MIRROR_AVERAGE_MIN_DISCOUNT_PCT: averageMinDiscountPct,
      MILD_DIP_MIRROR_AVERAGE_NEXT_DISCOUNT_PCT: '15',
      MILD_DIP_MIRROR_AVERAGE_MIN_HOLD_MS: '120000',
      MILD_DIP_MIRROR_COOLDOWN_MS: '900000',
      MILD_DIP_MIRROR_OWN_EXIT_ENABLED: ownExitEnabled ? '1' : '0',
      MILD_DIP_MIRROR_EXIT_ARM_PCT: exitArmPct,
      MILD_DIP_MIRROR_EXIT_TRAIL_PCT: exitTrailPct,
      MILD_DIP_MIRROR_OWN_EXIT_TIME_STOP_MS: ownExitTimeStopMs,
      MILD_DIP_MIRROR_LOSS_CAP_USD: lossCapUsd,
      MILD_DIP_MIRROR_LOSS_CAP_FLATTEN: '0',
      MILD_DIP_MIRROR_LOSS_CAP_DAILY_RESET: lossCapDailyReset,
      MILD_DIP_MIRROR_LOSS_CAP_RESET_TZ_OFFSET_MIN: lossCapResetTzOffsetMin,
      MILD_DIP_MIRROR_EXIT_STOP_PCT: '45',
      MILD_DIP_MIRROR_NO_MOVE_CUT_MS: '600000',
      MILD_DIP_MIRROR_NO_MOVE_MIN_MFE_PCT: '2',
      MILD_DIP_MIRROR_MAX_HOLD_MS: '3600000',
      ...(firstTouchPositionUsd != null
        ? { MILD_DIP_FIRST_TOUCH_POSITION_USD: firstTouchPositionUsd }
        : {}),
      ...(leaderOpenBagEnabled
        ? {
            MILD_DIP_MIRROR_LEADER_OPEN_BAG_ENABLED: leaderOpenBagEnabled,
            MILD_DIP_MIRROR_LEADER_OPEN_BAG_RETRY_MS: leaderOpenBagRetryMs,
            MILD_DIP_MIRROR_LEADER_OPEN_BAG_MAX_AGE_MS: leaderOpenBagMaxAgeMs,
            MILD_DIP_MIRROR_LEADER_OPEN_BAG_MAX_ENTRIES: leaderOpenBagMaxEntries,
            MILD_DIP_MIRROR_LEADER_OPEN_BAG_MAX_PER_PASS: leaderOpenBagMaxPerPass,
            MILD_DIP_MIRROR_LEADER_OPEN_BAG_MIN_FREE_USD: leaderOpenBagMinFreeUsd,
          }
        : {}),
    },
  };
}
if (mildDipBotApp) {
  PM2_APPS.push(
    makeMirrorApp({
      name: 'mild-dip-mirror',
      walletSecret: 'data/live/mcs-wallet.json',
      walletPubkey: '2fMzAm6aTCAPrXjamCLRbjLRxEqrcD7zLdN2wNdaL7Ps',
      dataDir: 'data/milddip-mirror',
      leaders: '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
      ownExitEnabled: false,
      exitArmPct: '2',
      exitTrailPct: '0',
      ownExitTimeStopMs: '0',
      lossCapUsd: '150',
      lossCapDailyReset: '1',
      lossCapResetTzOffsetMin: '180',
      maxEntryPc5mPct: '1000',
      /**
       * 1.11.1056 — вход только по скидке к филлу лидера: замер закрытых сделок
       * дал у зелёных входов ROI ниже дипа во всех окнах (12 ч −7.1% против
       * −4.3%, вся история +21% против +27%).
       */
      entryGraceMaxPremiumPct: '1',
      maxPremiumPct: '1',
      greenMaxPremiumPct: '10',
      executionStartSlippageBps: '400',
      greenInstantEnabled: '1',
      greenIgnoreLiquidityFloor: true,
      execPremiumSlackPct: '2',
      manualAdoptEnabled: true,
      maxVol5mToLiq: '0',
      firstTouchPositionUsd: '0',
      fundingParkMax: '60',
      leaderOpenBagEnabled: '1',
      minLiquidityUsd: '30000',
      minVol5mUsd: '500',
      minMcapUsd: '50000',
      minPairAgeHours: '1',
      minPc1hPct: '-1000',
      minPc5mPct: '-1000',
      ladderStepPct: '8',
      ladderStepAfterAvgPct: '16',
      ladderSellFraction: '0.5',
      ladderEnabled: '0',
      ladderMaxRungs: '1',
      dustCloseUsd: '2',
      positionUsd: '30',
      sizeLiqCoef: '0.008749',
      sizeLiqExp: '0.866',
      sizeLiqMinUsd: '30',
      sizeLiqMaxUsd: '150',
      sizeLiqMaxPoolSharePct: '0.15',
      sizeFromLeaderFraction: '0.25',
      sizeFromLeaderMinUsd: '30',
      sizeFromLeaderMaxUsd: '150',
      sizeFromLeaderSmallMcapUsd: '40000',
      sizeFromLeaderSmallClipUsd: '30',
      firstClipLegs: '1',
      // 1.11.1057 — замер закрытых сделок показал положительный эффект усреднения
      // только глубже −50%; пол vol5m $2k отсекает покупки в мёртвых малых пулах.
      averageUsd: '10',
      averageLevelsPct: '25,50',
      averageSizeMode: 'bag_mark',
      averageMaxUsd: '200',
      averageMaxTimes: '2',
      averageMinDiscountPct: '50',
      crossLeaderAverageEnabled: '1',
      crossLeaderAverageLeaders: '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5',
      crossLeaderAverageUsd: '10',
      crossLeaderAverageStepsEnabled: '0',
      crossLeaderAverageMinDiscountPct: '50',
      crossLeaderAverageMaxTimes: '1',
      tierEnabled: '0',
      tierIgnoreStructuralFloors: '0',
      tierPositionUsd: '10',
      tierMaxOpen: '12',
    }),
    makeMirrorApp({
      name: 'mild-dip-mirror2',
      walletSecret: 'data/live/copy-8zkg.keypair.json',
      walletPubkey: 'FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX',
      dataDir: 'data/milddip-mirror2',
      leaders: '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5',
      ownExitEnabled: false,
      exitArmPct: '2',
      exitTrailPct: '0',
      ownExitTimeStopMs: '0',
      lossCapUsd: '50',
      maxEntryPc5mPct: '1000',
      entryGraceMaxPremiumPct: '1',
      minLiquidityUsd: '40000',
      minMcapUsd: '50000',
      minPc1hPct: '-1000',
      minPc5mPct: '-10',
      ladderStepPct: '5',
      ladderStepAfterAvgPct: '10',
      ladderSellFraction: '0.2',
      ladderEnabled: '0',
      ladderMaxRungs: '0',
      dustCloseUsd: '3',
      positionUsd: '10',
      sizeLiqCoef: '0.001094',
      sizeLiqExp: '0.866',
      sizeLiqMinUsd: '10',
      sizeLiqMaxUsd: '30',
      sizeLiqMaxPoolSharePct: '0.15',
      averageUsd: '7',
      crossLeaderAverageEnabled: '1',
      crossLeaderAverageLeaders: '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
      crossLeaderAverageUsd: '10',
      crossLeaderAverageStepsEnabled: '1',
      tierEnabled: '0',
      tierIgnoreStructuralFloors: '1',
      tierPositionUsd: '10',
      tierMaxOpen: '12',
    }),
  );
}

PM2_APPS.push({
  name: 'mild-dip-watchdog',
  cwd: root,
  script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
  args: 'src/scripts/mild-dip-watchdog.ts',
  interpreter: 'node',
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  restart_delay: 5000,
  merge_logs: true,
  time: true,
  env: {
    NODE_ENV: 'production',
    MILD_DIP_WATCHDOG_INSTANCES: 'mild-dip-mirror:data/milddip-mirror',
    MILD_DIP_WATCHDOG_INTERVAL_MS: '60000',
    MILD_DIP_WATCHDOG_STALE_MS: '480000',
    MILD_DIP_WATCHDOG_MAX_RESTARTS_PER_HOUR: '4',
    MILD_DIP_WATCHDOG_COOLDOWN_MS: '300000',
    MILD_DIP_WATCHDOG_JOURNAL_PATH: path.join(root, 'data/milddip/watchdog-journal.jsonl'),
    MILD_DIP_DATA_MIN_FREE_BYTES: '8589934592',
    MILD_DIP_DATA_MIN_FREE_PCT: '10',
  },
});

/**
 * Apps filtered out of PM2 on Oscar VPS so `pm2 start/reload ecosystem` cannot revive them.
 * 1.11.660 — live-oscar + 498SW copy-trader excluded (operator: no RPC/Dex burn).
 * dc-trader is a separate product (`/opt/dc-trader`) — not in this file.
 */
const OSCAR_VPS_EXCLUDED_APPS = new Set([
  'live-oscar',
  'copy-trader',
  /** 1.11.685 — Oscar trading = mild-dip only; 8zkg twins retired. */
  'copy-trader-8zkg',
  'copy-trader-8zkg-mirror',
  /** 1.11.1040 — operator permanently disabled mild-dip-bot; reload must not revive it. */
  'mild-dip-bot',
  /** 1.11.1041 — operator stopped mild-dip-mirror2; reload/watchdog must not revive it. */
  'mild-dip-mirror2',
  'live-oscar-dashboard',
  'market-spike-telegram-watch',
  'market-pullback-telegram-watch',
  'retrace-alert-watch',
  'hl-twap-telegram-watch',
  'hl-oscar-perp-watch',
  'hl-oscar-majors-watch',
  'basepulse-journal-sync',
  'bscpulse-journal-sync',
  'rh-sniper-discovery',
  'rh-sniper-executor',
  /**
   * 1.11.686 — Dex/RPC budget is for mild-dip only. Collectors must not
   * revive via `pm2 startOrReload ecosystem` and steal the 120 RPM gate.
   */
  'sa-raydium',
  'sa-meteora',
  'sa-moonshot',
  'sa-pumpswap',
  'sa-collector-watch',
  'sa-collector-health-telegram',
  'sa-rate-429-report',
  'sa-snapshot-freshness-watch',
  'sa-jupiter',
  'sa-direct-lp',
  'sa-alchemy-usage-watch',
]);

module.exports = {
  apps: PM2_APPS.filter((a) => !OSCAR_VPS_EXCLUDED_APPS.has(a.name)),
  /** Internal consumers need definitions excluded from the PM2 export. */
  allApps: PM2_APPS,
};
