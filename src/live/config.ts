import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv } from '../core/rpc/resolve-solana-rpc-url.js';

const ExecutionModeSchema = z.enum(['dry_run', 'simulate', 'live']);
const ProfileSchema = z.enum(['oscar']);
const LiveConfirmCommitmentSchema = z.enum(['processed', 'confirmed', 'finalized']);
export type LiveConfirmCommitmentLevel = z.infer<typeof LiveConfirmCommitmentSchema>;

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

function optionalPositiveEnv(name: string): number | undefined {
  const s = process.env[name]?.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function optionalPositiveIntEnv(name: string): number | undefined {
  const s = process.env[name]?.trim();
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

function parseLiveConfirmCommitment(raw: string | undefined): 'processed' | 'confirmed' | 'finalized' | undefined {
  const s = raw?.trim().toLowerCase();
  if (s === 'processed' || s === 'confirmed' || s === 'finalized') return s;
  return undefined;
}

const LiveOscarConfigSchema = z
  .object({
    strategyEnabled: z.boolean(),
    executionMode: ExecutionModeSchema,
    profile: ProfileSchema,
    /** SSOT live journal — must never equal paper Oscar path when both are set. */
    liveTradesPath: z.string().min(1),
    strategyId: z.string().min(1).default('live-oscar'),
    /** Live JSONL + Telegram pulse cadence (overrides paper heartbeat when live-oscar runs). Default 30m. */
    heartbeatIntervalMs: z.coerce.number().int().min(5000).max(7200_000).default(1_800_000),
    /** Optional; if set alongside `liveTradesPath`, paths must differ (collision guard). */
    parityPaperTradesPath: z.string().optional(),
    /** Required when enabled + simulate|live; never loaded by Phase 0 runtime unless enabled. */
    walletSecret: z.string().optional(),
    /**
     * Optional: expected base58 pubkey for the key loaded from `walletSecret`.
     * When set, live-oscar verifies at boot so the wrong keypair file cannot sign swaps.
     */
    liveWalletPubkeyExpected: z.string().min(32).max(64).optional(),

    /** W8.0 Phase 2 — Jupiter API (defaults `api.jup.ag`; sends existing `JUPITER_API_KEY` as `x-api-key` when set — same key from Jupiter Developer dashboard, no separate “Pro key” in code). */
    liveJupiterQuoteUrl: z.string().min(1).optional(),
    liveJupiterSwapUrl: z.string().min(1).optional(),
    liveJupiterQuoteTimeoutMs: z.coerce.number().int().min(500).max(30_000).default(5000),
    liveJupiterSwapTimeoutMs: z.coerce.number().int().min(500).max(60_000).default(8000),
    liveDefaultSlippageBps: z.coerce.number().int().min(10).max(5000).default(400),
    /**
     * Optional: max prioritization lamports passed to Jupiter `/swap/v1/swap` as `priorityLevelWithMaxLamports.maxLamports`.
     * Unset ⇒ omit field (Jupiter default). Example: **0.0001 SOL** = `100_000` lamports via **`LIVE_JUPITER_PRIORITY_MAX_SOL`**.
     */
    liveJupiterPriorityMaxLamports: z.number().int().min(1).max(50_000_000).optional(),
    /** Hint level paired with `liveJupiterPriorityMaxLamports` (Jupiter API spelling). */
    liveJupiterSwapPriorityLevel: z.enum(['medium', 'high', 'veryHigh']).default('medium'),
    /**
     * Phase 4 blocks swap if `quoteSnapshot.quoteAgeMs` exceeds this (ms).
     * Default **8000** when env unset (loader); **`LIVE_QUOTE_MAX_AGE_MS=0`** disables the gate.
     */
    liveQuoteMaxAgeMs: z.number().int().min(1).max(600_000).optional(),

    /** W8.0 Phase 3 — sign + simulateTransaction (qnCall feature sim). */
    liveSimEnabled: z.boolean(),
    liveSimTimeoutMs: z.coerce.number().int().min(2000).max(60_000),
    liveSimCreditsPerCall: z.coerce.number().int().min(10).max(200),
    liveSimReplaceRecentBlockhash: z.boolean().default(true),
    liveSimSigVerify: z.boolean().default(false),

    /** W8.0 Phase 5 — §3.3 risk / §3.4 capital (optional limits: unset ⇒ check skipped). */
    liveMaxPositionUsd: z.coerce.number().positive().optional(),
    liveMaxOpenPositions: z.coerce.number().int().min(1).optional(),
    /** 0 = disabled (CHANGELOG). */
    liveKillAfterConsecFail: z.coerce.number().int().min(0).default(0),
    /** Minimum native SOL (whole SOL, not lamports) to allow new exposure. */
    liveMinWalletSol: z.coerce.number().positive().optional(),
    /**
     * **Live-only**, **buy_open only** (новый mint): require `native_SOL × SOL/USD ≥ this` before swap.
     * DCA adds use `isNewPosition: false` and skip this gate. Optional; complements `liveMinWalletSol` when both set (both must pass).
     */
    liveMinWalletSolEquityUsd: z.coerce.number().positive().optional(),

    /** Live-only: block **new** buys when Binance BTC context is fresh and drawdown exceeds thresholds below. */
    liveBtcGateEnabled: z.boolean().default(true),
    /** Skip BTC gate if `getBtcContext().updated_ts` older than this (ms). */
    liveBtcGateMaxStaleMs: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
    /** Block when `ret1h_pct ≤ −this` (percent points). Level-2 default 1%. */
    liveBtcBlockNewBuys1hDrawdownPct: z.coerce.number().min(0).max(50).default(1),
    /** Block when `ret4h_pct ≤ −this` (percent points). Level-2 default 2.5%. */
    liveBtcBlockNewBuys4hDrawdownPct: z.coerce.number().min(0).max(50).default(2.5),
    /** Block when `ret24h_pct ≤ −this` (percent points). Level-2 default 2%. `0` = off. */
    liveBtcBlockNewBuys24hDrawdownPct: z.coerce.number().min(0).max(50).default(2),
    /** Block when `ret72h_pct ≤ −this` (percent points). Level-2 default 6%. `0` = off. */
    liveBtcBlockNewBuys72hDrawdownPct: z.coerce.number().min(0).max(50).default(6),
    /** Block when drawdown from 72h peak ≤ −this (percent points). Level-2 default 6%. `0` = off. */
    liveBtcBlockNewBuysPeak72hDrawdownPct: z.coerce.number().min(0).max(50).default(6),
    liveEntryNotionalUsd: z.coerce.number().positive().optional(),
    liveEntryMinFreeMult: z.coerce.number().positive().default(2),
    /**
     * When true: enforce free native SOL (USD) ≥ k·X before buy_open / scale-in; may emit capital_skip or CAPITAL_ROTATE.
     * When false (default): skip this check entirely (Jupiter swap uses on-chain balance; RPC free-SOL estimate was unreliable in prod).
     */
    livePhase5FreeSolGateEnabled: z.boolean().default(false),
    /**
     * Only if `livePhase5FreeSolGateEnabled`: when true, may sell a profitable open to free SOL. When false, only capital_skip.
     */
    liveCapitalRotateEnabled: z.boolean().default(false),
    liveCapitalRotateCascade: z.boolean().default(false),
    /** Rent + fee cushion subtracted from getBalance lamports before free_usd (v1 SOL-only). */
    liveFreeSolBufferLamports: z.coerce.number().int().min(0).default(10_000_000),

    /** W8.0 Phase 6 — send + confirm (live). */
    liveConfirmCommitment: LiveConfirmCommitmentSchema.default('confirmed'),
    liveConfirmTimeoutMs: z.coerce.number().int().min(3000).max(600_000).default(60_000),
    liveSendSkipPreflight: z.boolean().default(false),
    liveSimBeforeSend: z.boolean().default(true),
    /**
     * Buy/sell pipelines: on transient pre-send simulation failure or `confirm_timeout`,
     * rebuild Jupiter quote/swap and retry. 1.11.168 raised cap 10→15 to enable
     * persistent retry against tight slippage (50bps) — emulates jup.ag UI manual
     * pattern «retry until pool settles». Caller-side delay is also configurable
     * (250ms..30s), default 5000ms in config; PM2 sets 3000ms in 1.11.168.
     */
    liveBuySimRetryAttempts: z.coerce.number().int().min(0).max(15).default(0),
    liveBuySimRetryDelayMs: z.coerce.number().int().min(250).max(30_000).default(5000),
    /**
     * 1.11.228 — кэп ретраев для «slippage class» sim_err (Custom:1 / 0x1771 / явное «slippage»):
     * после N таких подряд на одном intent выходим из retry-цикла, чтобы не сжигать кредиты
     * на одинаковых маршрутах. Когда `null/undefined`, кэп не применяется (fallback на legacy).
     */
    liveBuySimSlippageRetryAttempts: z.coerce.number().int().min(0).max(15).default(2),
    liveSellSimRetryAttempts: z.coerce.number().int().min(0).max(15).default(0),
    liveSellSimRetryDelayMs: z.coerce.number().int().min(250).max(30_000).default(5000),
    /** То же, но для продаж — exits должны проходить, поэтому кэп выше. */
    liveSellSimSlippageRetryAttempts: z.coerce.number().int().min(0).max(15).default(5),
    /**
     * 1.11.228 — на каждый retry в slippage-классе bump'аем `slippageBps` на эту величину,
     * чтобы дать Jupiter Pro шанс собрать маршрут с другим acceptable impact. 0 = выкл.
     */
    liveSimSlippageRetryBumpBps: z.coerce.number().int().min(0).max(500).default(50),
    /** Hard cap для адаптивного bump'а (включая базовый `liveDefaultSlippageBps`). */
    liveSimSlippageRetryMaxBps: z.coerce.number().int().min(10).max(5000).default(300),
    /**
     * 1.11.231 — pre-check Jupiter `priceImpactPct` ПЕРЕД simulate.
     *
     * Если quote вернул impact > порога, не идём ни в swap-build, ни в simulate — сразу
     * `route_too_impactful`. Это бесплатно режет 50-70% sim_err от глухих маршрутов,
     * экономя QN-кредиты + Jupiter `/swap` calls.
     *
     * Buy default: `0` (off — даём legacy слой возможность работать).
     * Sell default: `0` (off — для выходов важно успешно продать даже на хреновом маршруте).
     *
     * Включить:
     *   LIVE_BUY_MAX_PRICE_IMPACT_PCT=0.5  → блочить buy при impact > 0.5%
     *   LIVE_SELL_MAX_PRICE_IMPACT_PCT=2.0 → блочить sell при impact > 2%
     *
     * `priceImpactPct` от Jupiter — это **процент** (например `0.0123` = 1.23%, не 1.23 * 100).
     * Это видно в коде `quoteResponse.priceImpactPct` — Jupiter v6 даёт число от 0 до 1+.
     * Поэтому сравниваем `n * 100 > limitPct`.
     */
    liveBuyMaxPriceImpactPct: z.coerce.number().min(0).max(50).default(0),
    liveSellMaxPriceImpactPct: z.coerce.number().min(0).max(50).default(0),

    /**
     * 1.11.234 — Anti-chase guard для buy-pipeline.
     *
     * Внутри одного `runSolToTokenPipeline` фиксируем `tokensPerLamport`
     * первого валидного quote (anchor). Если на последующих retry'ях quote
     * ушёл по цене ВЫШЕ anchor больше чем на `liveBuyMaxChasePct` %, abort
     * (terminal kind `chase_aborted`). Это предотвращает залёт в позицию
     * по уже разогнанной цене — на следующем discovery-tick'е либо decision
     * пере-снимется на новой цене, либо recovery-veto / local-high-veto
     * заблокируют вход.
     *
     * Значение в **процентах**. `0` отключает проверку.
     * Рекомендованный default 3% — позволяет нормальный intra-retry drift,
     * но блочит реальный chase.
     */
    liveBuyMaxChasePct: z.coerce.number().min(0).max(50).default(0),

    /**
     * 1.11.231 — TTL для cache `getTokenAccountsByOwner` (live wallet SPL balances).
     * `0` (default) = off (backward-compat). Включаем `15000` (15s) — обычно
     * безопасно, потому что после buy/sell мы явно вызываем `invalidateLiveWalletSplBalanceCache()`.
     */
    liveWalletSplBalanceCacheTtlMs: z.coerce.number().int().min(0).max(120_000).default(0),
    /**
     * 1.11.228 — staged-add cooldown: после N подряд `sim_err` на одну (mint, intentKind)
     * следующая попытка staged_avg / entry_split / dca_add блокируется на `LIVE_STAGED_ADD_SIM_ERR_COOLDOWN_MS`.
     */
    liveStagedAddSimErrThreshold: z.coerce.number().int().min(1).max(20).default(3),
    liveStagedAddSimErrCooldownMs: z.coerce.number().int().min(60_000).max(6 * 60 * 60_000).default(30 * 60_000),
    /**
     * 1.11.231 — auto-permanent-denylist по числу cooldown-rearm'ов на mint.
     *
     * Если для одного mint cooldown сработал N раз (через любой intentKind: buy_open/dca_add/buy_scale_in),
     * mint автоматически добавляется в локальный permanent-denylist (`live-oscar-permanent-denylist.txt`).
     * 5 rearm'ов с 30-минутным cooldown это ~2.5 часа подряд глухих sim_err — практически точно глухой маршрут.
     *
     * 0 = выкл (только ручной denylist). Telegram ALERT при срабатывании.
     */
    liveStagedAddAutoDenylistEnabled: z.boolean().default(true),
    liveStagedAddAutoDenylistRearmsThreshold: z.coerce.number().int().min(0).max(50).default(5),
    liveStagedAddAutoDenylistTelegramEnabled: z.boolean().default(true),

    /**
     * 1.11.231 — adaptive Jupiter priority fee при congestion.
     *
     * При `N` подряд `confirm_timeout` за `windowMs` → boost'аем `liveJupiterPriorityMaxLamports`
     * на `factor` × и держим `holdMs`. Это спасает от тех редких случаев когда сеть забита и
     * наши transactions залипают в очереди валидаторов.
     */
    liveAdaptivePriorityFeeEnabled: z.boolean().default(false),
    liveAdaptivePriorityFeeThreshold: z.coerce.number().int().min(1).max(50).default(5),
    liveAdaptivePriorityFeeWindowMs: z.coerce.number().int().min(60_000).max(60 * 60_000).default(10 * 60_000),
    liveAdaptivePriorityFeeBoostFactor: z.coerce.number().min(1).max(20).default(2.5),
    liveAdaptivePriorityFeeHoldMs: z.coerce.number().int().min(60_000).max(6 * 60 * 60_000).default(30 * 60_000),
    /**
     * 1.11.230 — настройка размера MTM probe (live tracker → Jupiter buy-quote для price-verify).
     * Чем больше probe, тем меньше распределяется на dust-маршрутах и тем точнее USD-цена.
     * Cap'ом ограничиваем экспозицию к 1 неудачному квоту (если Jupiter возвращает мусор).
     * Min ⇒ нижний пол для сверх-маленьких позиций; max ⇒ верхний предел.
     */
    liveTrackerMtmProbeMinUsd: z.coerce.number().min(1).max(500).default(20),
    liveTrackerMtmProbeMaxUsd: z.coerce.number().min(5).max(2000).default(200),
    liveTrackerMtmProbeFraction: z.coerce.number().min(0.01).max(1).default(0.1),
    liveSendMaxRetries: z.coerce.number().int().min(0).max(10).default(2),
    liveSendRetryBaseMs: z.coerce.number().int().min(100).max(30_000).default(500),
    liveSendCreditsPerCall: z.coerce.number().int().min(10).max(200).default(30),
    liveSendRpcTimeoutMs: z.coerce.number().int().min(3000).max(120_000).default(25_000),
    /** When set, send + confirm use this URL instead of SA_RPC_HTTP_URL (simulate may still use SA_RPC_HTTP_URL). */
    liveRpcHttpUrl: z.string().min(1).optional(),

    /** W8.0 Phase 7 — replay `live_position_*` from LIVE_TRADES_PATH before Oscar loop. */
    liveReplayOnBoot: z.boolean(),
    liveReplayTailLines: z.coerce.number().int().min(1).optional(),
    liveReplaySinceTs: z.coerce.number().finite().optional(),
    /** Beyond this size (bytes) only the trailing chunk of `LIVE_TRADES_PATH` is scanned for replay. */
    liveReplayMaxFileBytes: z.coerce.number().int().min(65_536).max(512 * 1024 * 1024).default(26_214_400),
    /** 0 = off. Sample-verify last N confirmed `execution_result` rows via getTransaction (Phase 7 tail). */
    liveReconcileTxSampleN: z.coerce.number().int().min(0).max(50).default(0),

    /** W8.0-p7.1 — replay keeps legacy rows without `entryLegSignatures` when true (dangerous). */
    liveReplayTrustGhostPositions: z.boolean().default(false),
    /** W8.0-p7.1 — enforce `PAPER_POSITION_USD` vs live entry/max limits at boot (live mode). */
    liveStrictNotionalParity: z.boolean().default(true),
    /** W8.0-p7.1 — after replay, verify each `entryLegSignatures` tx via RPC (live mode). */
    liveAnchorVerifyOnBoot: z.boolean().default(true),
    /**
     * 0 = off. When notional parity arms exposure block for longer than this (ms), clear it and emit `risk_note`
     * `exposure_block_ttl_cleared` (emergency; ops must fix root cause).
     */
    liveReconcileBlockMaxMs: z.coerce.number().int().min(0).max(86_400_000).default(0),

    /** 0 = off. Else interval (ms) for periodic tail sweep + stale-open diagnostics (live only). */
    livePeriodicSelfHealMs: z.coerce.number().int().min(0).max(86_400_000).default(1_800_000),
    /** Skip chain-only tail sweep below this estimated USD (spam / dust). */
    livePeriodicSweepMinUsd: z.coerce.number().min(0).max(1_000_000).default(0.25),
    /**
     * When false (default), tail sweep only runs for mints that appear in this process's `closed[]` history.
     * When true, any non-open SPL balance above min USD is sold (airdrops / unknown tokens — higher risk).
     */
    livePeriodicSweepUnknownChainOnly: z.boolean().default(false),
    /** Manual opt-in. When false, periodic self-heal never force-closes normal open positions by age. */
    livePeriodicStuckForceCloseEnabled: z.boolean().default(false),
    /** Hours beyond `timeoutHours` before forcing PERIODIC_HEAL on an open with on-chain balance (only when enabled). */
    livePeriodicStuckGraceHours: z.coerce.number().min(0).max(168).default(0.5),

    /**
     * 0 = off. In **live** `buy_open` only: skip swap if wallet already holds this mint worth ≥ this USD
     * (chain balance × snapshot/Jupiter price). Does not replace full reconcile; avoids duplicate buys when journal lags.
     */
    liveSkipBuyOpenIfWalletMintMinUsd: z.coerce.number().min(0).max(1_000_000).default(0),

    /**
     * 0 = off. After **`live_position_close`** in **live**, wait this many ms then if SPL balance for that mint
     * remains on the wallet, run **`sell_full`** (chain-sized) to clear dust tails.
     */
    livePostCloseTailSweepDelayMs: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
    /** Floor USD notional hint for Jupiter when estimating microscopic tails (actual sell uses on-chain raw). */
    livePostCloseTailSweepMinUsd: z.coerce.number().min(0).max(1000).default(0.05),

    /**
     * Двухногий вход: после первого `buy_open` трекер докупает `(1 − PAPER_ENTRY_FIRST_LEG_FRACTION)×positionUsd`,
     * если Jupiter implied цена в коридоре к якорю первой ноги: до +`liveEntryScaleInCorridorUpPct` % и до −`liveEntryScaleInCorridorDownPct` %.
     * Вне коридора — ждём `liveEntryScaleInOutOfCorridorPollMs` и проверяем снова (без принудительной второй ноги).
     * Если заданы только `LIVE_ENTRY_SCALE_IN_CORRIDOR_PCT`, оба направления берут это значение (симметрично).
     */
    liveEntryScaleInEnabled: z.boolean().default(false),
    liveEntryScaleInDelayMs: z.coerce.number().int().min(1000).max(600_000).default(30_000),
    /** Симметричный fallback, когда не заданы UP/DOWN env. */
    liveEntryScaleInCorridorPct: z.coerce.number().min(0.1).max(50).default(3),
    liveEntryScaleInCorridorUpPct: z.coerce.number().min(0.01).max(50).default(3),
    liveEntryScaleInCorridorDownPct: z.coerce.number().min(0.01).max(50).default(3),
    /** Интервал повторной проверки коридора после выхода цены за допуск (мс). */
    liveEntryScaleInOutOfCorridorPollMs: z.coerce.number().int().min(1000).max(600_000).default(30_000),
    liveEntryScaleInMaxSwapAttempts: z.coerce.number().int().min(1).max(50).default(5),
    liveEntryScaleInRetryBackoffMs: z.coerce.number().int().min(200).max(120_000).default(2000),

    /**
     * Live-only: после всех paper-гейтов, перед `buy_open` — разрешать вход только если mint есть в файле whitelist.
     * Нет в списке → `live_whitelist_skip` + Telegram (категория `LIVE_MINT_WHITELIST_TELEGRAM_CATEGORY`, дефолт ADVICE).
     */
    liveMintWhitelistEnabled: z.boolean().default(false),
    /** Путь к файлу: один mint (base58) на строку, строки `#…` — комментарии. Относительный путь — от `process.cwd()`. */
    liveMintWhitelistPath: z.string().min(1).default('data/live/live-oscar-mint-whitelist.txt'),
    /** Между повторными Telegram по одному и тому же mint (мс). `0` = без кулдауна. Дефолт **5 мин** — не спамить ADVICE. */
    liveMintWhitelistNotifyCooldownMs: z.coerce.number().int().min(0).max(86_400_000).default(300_000),

    /**
     * Необратимый запрет на SOL→token для mint (объединение seed из репозитория + локальный файл на VPS).
     * Локальный файл gitignored — переживает `git reset`; seed — tracked, защищает от случайного возврата строк в whitelist.
     */
    livePermanentDenylistDisabled: z.boolean().default(false),
    livePermanentDenylistLocalPath: z
      .string()
      .min(1)
      .default('data/live/live-oscar-permanent-denylist.txt'),
    livePermanentDenylistSeedPath: z
      .string()
      .min(1)
      .default('data/live/live-oscar-permanent-denylist.seed.txt'),
    /**
     * Авто-denylist после убыточного полного закрытия (`onLiveOscarFullCloseNegativeTradeDenylist`).
     * `0` — заготовка в коде остаётся, допись в файл не выполняется.
     */
    liveNegativeTradeDenyEnabled: z.boolean().default(true),
    /**
     * First-mint-probe: убыток → permanent denylist. `0` — только graduated на профите.
     */
    liveFirstMintProbeDenyOnLossEnabled: z.boolean().default(true),

    /**
     * Первый live-вход по mint (ещё нет в `liveMintGraduatedPath`): kill −7% от сигнала, без усреднения −7/−14;
     * убыток → denylist; прибыльное закрытие → graduated.
     */
    liveMintFirstProbeEnabled: z.boolean().default(true),
    liveMintFirstProbeKillDropPct: z.coerce.number().min(1).max(50).default(7),
    liveMintGraduatedPath: z.string().min(1).default('data/live/live-oscar-mint-graduated.txt'),

    /**
     * Variant A timed loss exit (salvage24 / h48_loss): block re-entry on same mint for N ms.
     * Env: `LIVE_MINT_TIMED_LOSS_COOLDOWN_ENABLED`, `LIVE_MINT_TIMED_LOSS_COOLDOWN_MS` (default 24h).
     */
    liveMintTimedLossCooldownEnabled: z.boolean().default(false),
    liveMintTimedLossCooldownMs: z.coerce.number().int().min(0).max(7 * 24 * 3_600_000).default(86_400_000),

    /**
     * After loss or stress exit (flash-crash / SL / …): hard block re-entry on same mint.
     * Env: `LIVE_MINT_LOSS_REENTRY_COOLDOWN_*`.
     */
    liveMintLossReentryCooldownEnabled: z.boolean().default(true),
    liveMintLossReentryCooldownMs: z.coerce
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 3_600_000)
      .default(6 * 3_600_000),
    liveMintLossReentryStreakWindowMs: z.coerce
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 3_600_000)
      .default(24 * 3_600_000),
    liveMintLossReentryStreakMax: z.coerce.number().int().min(2).max(10).default(2),
    liveMintLossReentryStreakCooldownMs: z.coerce
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 3_600_000)
      .default(24 * 3_600_000),

    /**
     * Variant A v3 scratch: re-entry when price ≤ lastExitRef × (1 − dropPct). No time cooldown.
     */
    liveMintScratchReentryEnabled: z.boolean().default(false),
    liveMintScratchReentryDropPct: z.coerce.number().min(0.01).max(0.5).default(0.1),

    /**
     * Ручной blacklist mint: совпадает с paper `mintBlacklistPath` / `LIVE_MINT_BLACKLIST_*` — файл должен существовать при включении.
     */
    liveMintBlacklistEnabled: z.boolean().default(false),
    liveMintBlacklistPath: z.string().min(1).default('data/live/live-oscar-mint-blacklist.txt'),

    /**
     * When true: append `live_discovery_eval` / `live_discovery_skip_open` to LIVE_TRADES_PATH from paper Oscar discovery
     * (live-oscar otherwise drops paper `journalAppend`). Disable with LIVE_DISCOVERY_AUDIT_JSONL=0 if JSONL volume is an issue.
     */
    liveDiscoveryAuditJsonlEnabled: z.boolean().default(true),

    /**
     * Signal lab — параллельный сбор снимков до `buy_open` в отдельный JSONL (не влияет на гейты и PnL).
     * См. `src/live/signal-lab.ts`.
     */
    signalLabEnabled: z.boolean().default(false),
    /** Доля кандидатов (0–100), для которых пишется снимок после прохождения гейтов. */
    signalLabSamplePct: z.coerce.number().min(0).max(100).default(25),
    signalLabPath: z.string().min(1).default('data/live/signal-lab.jsonl'),
    /**
     * Доля от размера первого Jupiter-probe для второго котирования (0 = второй probe выключен).
     * Например `0.55` → второй запрос на ~55% нотации первого probe.
     */
    signalLabAltProbeFraction: z.coerce.number().min(0).max(1).default(0),

    /**
     * MTM shadow — второй Jupiter-probe на открытых позициях (трекер), отдельный JSONL; не влияет на MTM/PnL.
     * См. `src/live/mtm-shadow.ts`.
     */
    mtmShadowEnabled: z.boolean().default(false),
    /** Доля тиков с открытыми позициями (0–100), где делается второй probe после успешного основного. */
    mtmShadowSamplePct: z.coerce.number().min(0).max(100).default(12),
    mtmShadowPath: z.string().min(1).default('data/live/mtm-shadow.jsonl'),
    /** Размер alt-probe относительно основного probe USD (например `0.58`); `0` = выключено. */
    mtmShadowAltFraction: z.coerce.number().min(0).max(1).default(0),

    /**
     * Трекер live: если Jupiter SOL→token MTM выше последнего PG `price_usd` более чем на этот %,
     * на тике для TP / peak / trail берём snapshot (защита от «призрачного» pump на микро-маршруте).
     * `0` = выключить (приоритет Jupiter, если `jupiterSaneVsEntry`).
     */
    liveTrackerJupiterMaxPremiumOverSnapshotPct: z.coerce.number().min(0).max(200).default(6),

    /**
     * Пауза (мс) между открытыми mint в тике трекера после Jupiter MTM — снижает burst на API.
     * При Jupiter Pro (~10 RPS) можно **50–100**; `0` = без паузы.
     */
    liveTrackerInterMintDelayMs: z.coerce.number().int().min(0).max(10_000).default(120),
  })
  .superRefine((data, ctx) => {
    if (data.strategyEnabled && (data.executionMode === 'simulate' || data.executionMode === 'live')) {
      const w = data.walletSecret?.trim();
      if (!w) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'LIVE_WALLET_SECRET is required when LIVE_STRATEGY_ENABLED=1 and LIVE_EXECUTION_MODE is simulate or live',
          path: ['walletSecret'],
        });
      }
    }
  });

export type LiveExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type LiveOscarProfile = z.infer<typeof ProfileSchema>;
export type LiveOscarConfig = z.infer<typeof LiveOscarConfigSchema>;

function assertPathsDiffer(livePath: string, paperPath: string | undefined): void {
  if (!paperPath?.trim()) return;
  const a = path.resolve(livePath.trim());
  const b = path.resolve(paperPath.trim());
  if (a === b) {
    throw new Error(
      `LIVE_TRADES_PATH must differ from PAPER_TRADES_PATH / LIVE_PARITY_PAPER_TRADES_PATH (both resolved to ${a})`,
    );
  }
}

function assertSignalLabPathDistinct(labPath: string, livePath: string, parityPath: string | undefined): void {
  const lab = path.resolve(process.cwd(), labPath.trim());
  const live = path.resolve(process.cwd(), livePath.trim());
  if (lab === live) {
    throw new Error(`SIGNAL_LAB_PATH must differ from LIVE_TRADES_PATH (both resolved to ${lab})`);
  }
  if (parityPath?.trim()) {
    const paper = path.resolve(process.cwd(), parityPath.trim());
    if (lab === paper) {
      throw new Error(`SIGNAL_LAB_PATH must differ from LIVE_PARITY_PAPER_TRADES_PATH (both resolved to ${lab})`);
    }
  }
}

function assertMtmShadowPathDistinct(
  shadowPath: string,
  livePath: string,
  parityPath: string | undefined,
  signalLabPath: string,
): void {
  const sh = path.resolve(process.cwd(), shadowPath.trim());
  const live = path.resolve(process.cwd(), livePath.trim());
  if (sh === live) {
    throw new Error(`MTM_SHADOW_PATH must differ from LIVE_TRADES_PATH (both resolved to ${sh})`);
  }
  if (parityPath?.trim()) {
    const paper = path.resolve(process.cwd(), parityPath.trim());
    if (sh === paper) {
      throw new Error(`MTM_SHADOW_PATH must differ from LIVE_PARITY_PAPER_TRADES_PATH (both resolved to ${sh})`);
    }
  }
  const lab = path.resolve(process.cwd(), signalLabPath.trim());
  if (sh === lab) {
    throw new Error(`MTM_SHADOW_PATH must differ from SIGNAL_LAB_PATH (both resolved to ${sh})`);
  }
}

/**
 * W8.0 Phase 0 — load env for `live-oscar` process only (not used by papertrader).
 */
export function loadLiveOscarConfig(): LiveOscarConfig {
  const parityPaper =
    process.env.LIVE_PARITY_PAPER_TRADES_PATH?.trim() || process.env.PAPER_TRADES_PATH?.trim() || undefined;

  const symCorridorPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_PCT?.trim();
    if (!s) return 3;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.1 ? Math.min(n, 50) : 3;
  })();
  const corridorUpPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT?.trim();
    if (!s) return symCorridorPct;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.01 ? Math.min(n, 50) : symCorridorPct;
  })();
  const corridorDownPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT?.trim();
    if (!s) return symCorridorPct;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.01 ? Math.min(n, 50) : symCorridorPct;
  })();

  const parsed = LiveOscarConfigSchema.safeParse({
    strategyEnabled: envBool(process.env.LIVE_STRATEGY_ENABLED, false),
    executionMode: (process.env.LIVE_EXECUTION_MODE ?? 'dry_run').trim().toLowerCase(),
    profile: (process.env.LIVE_STRATEGY_PROFILE ?? 'oscar').trim().toLowerCase(),
    liveTradesPath: process.env.LIVE_TRADES_PATH,
    strategyId: process.env.LIVE_STRATEGY_ID,
    heartbeatIntervalMs: process.env.LIVE_HEARTBEAT_INTERVAL_MS,
    parityPaperTradesPath: parityPaper,
    walletSecret: process.env.LIVE_WALLET_SECRET,
    liveWalletPubkeyExpected: process.env.LIVE_WALLET_PUBKEY?.trim() || undefined,
    liveJupiterQuoteUrl: process.env.LIVE_JUPITER_QUOTE_URL?.trim() || undefined,
    liveJupiterSwapUrl: process.env.LIVE_JUPITER_SWAP_URL?.trim() || undefined,
    liveJupiterQuoteTimeoutMs: process.env.LIVE_JUPITER_QUOTE_TIMEOUT_MS,
    liveJupiterSwapTimeoutMs: process.env.LIVE_JUPITER_SWAP_TIMEOUT_MS,
    liveDefaultSlippageBps: process.env.LIVE_DEFAULT_SLIPPAGE_BPS,
    liveQuoteMaxAgeMs: (() => {
      const s = process.env.LIVE_QUOTE_MAX_AGE_MS?.trim();
      if (s === '0') return undefined;
      if (!s) return 8000;
      const n = Number.parseInt(s, 10);
      if (!Number.isFinite(n) || n < 1) return 8000;
      return Math.min(n, 600_000);
    })(),

    liveSimEnabled: envBool(process.env.LIVE_SIM_ENABLED, true),
    liveSimTimeoutMs: (() => {
      const s = process.env.LIVE_SIM_TIMEOUT_MS?.trim();
      if (!s) return 12_000;
      const n = Number(s);
      return Number.isFinite(n) ? n : 12_000;
    })(),
    liveSimCreditsPerCall: (() => {
      const s = process.env.LIVE_SIM_CREDITS_PER_CALL?.trim();
      if (!s) return 30;
      const n = Number(s);
      return Number.isFinite(n) ? n : 30;
    })(),
    liveSimReplaceRecentBlockhash: envBool(process.env.LIVE_SIM_REPLACE_RECENT_BLOCKHASH, true),
    liveSimSigVerify: envBool(process.env.LIVE_SIM_SIG_VERIFY, false),

    liveMaxPositionUsd: optionalPositiveEnv('LIVE_MAX_POSITION_USD'),
    liveMaxOpenPositions: optionalPositiveIntEnv('LIVE_MAX_OPEN_POSITIONS'),
    liveKillAfterConsecFail: process.env.LIVE_KILL_AFTER_CONSEC_FAIL,
    liveMinWalletSol: optionalPositiveEnv('LIVE_MIN_WALLET_SOL'),
    liveMinWalletSolEquityUsd: optionalPositiveEnv('LIVE_MIN_WALLET_SOL_EQUITY_USD'),
    liveBtcGateEnabled: envBool(process.env.LIVE_BTC_GATE_ENABLED, true),
    liveBtcGateMaxStaleMs: (() => {
      const s = process.env.LIVE_BTC_GATE_MAX_STALE_MS?.trim();
      if (!s) return 900_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 60_000 ? Math.min(n, 3_600_000) : 900_000;
    })(),
    liveBtcBlockNewBuys1hDrawdownPct: (() => {
      const s = process.env.LIVE_BTC_BLOCK_1H_DRAWDOWN_PCT?.trim();
      if (!s) return 1;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 1;
    })(),
    liveBtcBlockNewBuys4hDrawdownPct: (() => {
      const s = process.env.LIVE_BTC_BLOCK_4H_DRAWDOWN_PCT?.trim();
      if (!s) return 2.5;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 2.5;
    })(),
    liveBtcBlockNewBuys24hDrawdownPct: (() => {
      const s = process.env.LIVE_BTC_BLOCK_24H_DRAWDOWN_PCT?.trim();
      if (!s) return 2;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 2;
    })(),
    liveBtcBlockNewBuys72hDrawdownPct: (() => {
      const s = process.env.LIVE_BTC_BLOCK_72H_DRAWDOWN_PCT?.trim();
      if (!s) return 6;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 6;
    })(),
    liveBtcBlockNewBuysPeak72hDrawdownPct: (() => {
      const s = process.env.LIVE_BTC_BLOCK_PEAK_72H_DRAWDOWN_PCT?.trim();
      if (!s) return 6;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 6;
    })(),
    liveEntryNotionalUsd: optionalPositiveEnv('LIVE_ENTRY_NOTIONAL_USD'),
    liveEntryMinFreeMult: process.env.LIVE_ENTRY_MIN_FREE_MULT,
    livePhase5FreeSolGateEnabled: envBool(process.env.LIVE_PHASE5_FREE_SOL_GATE_ENABLED, false),
    liveCapitalRotateEnabled: envBool(process.env.LIVE_CAPITAL_ROTATE_ENABLED, false),
    liveCapitalRotateCascade: envBool(process.env.LIVE_CAPITAL_ROTATE_CASCADE, false),
    liveFreeSolBufferLamports: process.env.LIVE_FREE_SOL_BUFFER_LAMPORTS,

    liveConfirmCommitment: parseLiveConfirmCommitment(process.env.LIVE_CONFIRM_COMMITMENT),
    liveConfirmTimeoutMs: process.env.LIVE_CONFIRM_TIMEOUT_MS,
    liveSendSkipPreflight: envBool(process.env.LIVE_SEND_SKIP_PREFLIGHT, false),
    liveSimBeforeSend: envBool(process.env.LIVE_SIM_BEFORE_SEND, true),
    liveBuySimRetryAttempts: process.env.LIVE_BUY_SIM_RETRY_ATTEMPTS,
    liveBuySimRetryDelayMs: process.env.LIVE_BUY_SIM_RETRY_DELAY_MS,
    liveBuySimSlippageRetryAttempts: process.env.LIVE_BUY_SIM_SLIPPAGE_RETRY_ATTEMPTS,
    liveSellSimRetryAttempts: process.env.LIVE_SELL_SIM_RETRY_ATTEMPTS,
    liveSellSimRetryDelayMs: process.env.LIVE_SELL_SIM_RETRY_DELAY_MS,
    liveSellSimSlippageRetryAttempts: process.env.LIVE_SELL_SIM_SLIPPAGE_RETRY_ATTEMPTS,
    liveSimSlippageRetryBumpBps: process.env.LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS,
    liveSimSlippageRetryMaxBps: process.env.LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS,
    liveBuyMaxPriceImpactPct: process.env.LIVE_BUY_MAX_PRICE_IMPACT_PCT,
    liveSellMaxPriceImpactPct: process.env.LIVE_SELL_MAX_PRICE_IMPACT_PCT,
    liveBuyMaxChasePct: process.env.LIVE_BUY_MAX_CHASE_PCT,
    liveWalletSplBalanceCacheTtlMs: process.env.LIVE_WALLET_SPL_BALANCE_CACHE_TTL_MS,
    liveStagedAddSimErrThreshold: process.env.LIVE_STAGED_ADD_SIM_ERR_THRESHOLD,
    liveStagedAddSimErrCooldownMs: process.env.LIVE_STAGED_ADD_SIM_ERR_COOLDOWN_MS,
    liveStagedAddAutoDenylistEnabled: envBool(process.env.LIVE_STAGED_ADD_AUTO_DENYLIST_ENABLED, true),
    liveStagedAddAutoDenylistRearmsThreshold: process.env.LIVE_STAGED_ADD_AUTO_DENYLIST_REARMS_THRESHOLD,
    liveStagedAddAutoDenylistTelegramEnabled: envBool(process.env.LIVE_STAGED_ADD_AUTO_DENYLIST_TELEGRAM_ENABLED, true),
    liveAdaptivePriorityFeeEnabled: envBool(process.env.LIVE_ADAPTIVE_PRIORITY_FEE_ENABLED, false),
    liveAdaptivePriorityFeeThreshold: process.env.LIVE_ADAPTIVE_PRIORITY_FEE_THRESHOLD,
    liveAdaptivePriorityFeeWindowMs: process.env.LIVE_ADAPTIVE_PRIORITY_FEE_WINDOW_MS,
    liveAdaptivePriorityFeeBoostFactor: process.env.LIVE_ADAPTIVE_PRIORITY_FEE_BOOST_FACTOR,
    liveAdaptivePriorityFeeHoldMs: process.env.LIVE_ADAPTIVE_PRIORITY_FEE_HOLD_MS,
    liveTrackerMtmProbeMinUsd: process.env.LIVE_TRACKER_MTM_PROBE_MIN_USD,
    liveTrackerMtmProbeMaxUsd: process.env.LIVE_TRACKER_MTM_PROBE_MAX_USD,
    liveTrackerMtmProbeFraction: process.env.LIVE_TRACKER_MTM_PROBE_FRACTION,
    liveSendMaxRetries: process.env.LIVE_SEND_MAX_RETRIES,
    liveSendRetryBaseMs: process.env.LIVE_SEND_RETRY_BASE_MS,
    liveSendCreditsPerCall: process.env.LIVE_SEND_CREDITS_PER_CALL,
    liveSendRpcTimeoutMs: process.env.LIVE_SEND_RPC_TIMEOUT_MS,
    liveRpcHttpUrl: liveOscarRpcHttpUrlFromEnv(),

    liveReplayOnBoot: envBool(process.env.LIVE_REPLAY_ON_BOOT, true),
    liveReplayTailLines: optionalPositiveIntEnv('LIVE_REPLAY_TAIL_LINES'),
    liveReplaySinceTs: (() => {
      const s = process.env.LIVE_REPLAY_SINCE_TS?.trim();
      if (!s) return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    })(),
    liveReplayMaxFileBytes: process.env.LIVE_REPLAY_MAX_FILE_BYTES,
    liveReconcileTxSampleN: (() => {
      const s = process.env.LIVE_RECONCILE_TX_SAMPLE_N?.trim();
      if (!s) return 0;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 0;
    })(),
    liveReplayTrustGhostPositions: envBool(process.env.LIVE_REPLAY_TRUST_GHOST_POSITIONS, false),
    liveStrictNotionalParity: envBool(process.env.LIVE_STRICT_NOTIONAL_PARITY, true),
    liveAnchorVerifyOnBoot: envBool(process.env.LIVE_ANCHOR_VERIFY_ON_BOOT, true),

    liveReconcileBlockMaxMs: (() => {
      const s = process.env.LIVE_RECONCILE_BLOCK_MAX_MS?.trim();
      if (!s || s === '0') return 0;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 86_400_000) : 0;
    })(),

    livePeriodicSelfHealMs: (() => {
      const s = process.env.LIVE_PERIODIC_SELF_HEAL_MS?.trim();
      if (s === '0') return 0;
      if (!s) return 1_800_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 86_400_000) : 1_800_000;
    })(),
    livePeriodicSweepMinUsd: (() => {
      const s = process.env.LIVE_PERIODIC_SWEEP_MIN_USD?.trim();
      if (!s) return 0.25;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : 0.25;
    })(),
    livePeriodicSweepUnknownChainOnly: envBool(process.env.LIVE_PERIODIC_SWEEP_UNKNOWN_CHAIN_ONLY, false),
    livePeriodicStuckForceCloseEnabled: envBool(process.env.LIVE_PERIODIC_STUCK_FORCE_CLOSE_ENABLED, false),
    livePeriodicStuckGraceHours: (() => {
      const s = process.env.LIVE_PERIODIC_STUCK_GRACE_HOURS?.trim();
      if (!s) return 0.5;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 168) : 0.5;
    })(),
    liveSkipBuyOpenIfWalletMintMinUsd: (() => {
      const s = process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD?.trim();
      if (!s || s === '0') return 0;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : 0;
    })(),
    livePostCloseTailSweepDelayMs: (() => {
      const s = process.env.LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS?.trim();
      if (!s) return 60_000;
      if (s === '0') return 0;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 3_600_000) : 60_000;
    })(),
    livePostCloseTailSweepMinUsd: (() => {
      const s = process.env.LIVE_POST_CLOSE_TAIL_SWEEP_MIN_USD?.trim();
      if (!s) return 0.05;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : 0.05;
    })(),

    liveEntryScaleInEnabled: envBool(process.env.LIVE_ENTRY_SCALE_IN_ENABLED, false),
    liveEntryScaleInDelayMs: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_DELAY_MS?.trim();
      if (!s) return 30_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 1000 ? Math.min(n, 600_000) : 30_000;
    })(),
    liveEntryScaleInCorridorPct: symCorridorPct,
    liveEntryScaleInCorridorUpPct: corridorUpPct,
    liveEntryScaleInCorridorDownPct: corridorDownPct,
    liveEntryScaleInMaxSwapAttempts: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS?.trim();
      if (!s) return 5;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : 5;
    })(),
    liveEntryScaleInRetryBackoffMs: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS?.trim();
      if (!s) return 2000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 200 ? Math.min(n, 120_000) : 2000;
    })(),
    liveEntryScaleInOutOfCorridorPollMs: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_OUT_OF_CORRIDOR_POLL_MS?.trim();
      if (!s) return 30_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 1000 ? Math.min(n, 600_000) : 30_000;
    })(),
    liveMintWhitelistEnabled: envBool(process.env.LIVE_MINT_WHITELIST_ENABLED, false),
    liveMintWhitelistPath: process.env.LIVE_MINT_WHITELIST_PATH?.trim() || 'data/live/live-oscar-mint-whitelist.txt',
    liveMintWhitelistNotifyCooldownMs: (() => {
      const s = process.env.LIVE_MINT_WHITELIST_NOTIFY_COOLDOWN_MS?.trim();
      if (s === '0') return 0;
      if (!s) return 300_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 86_400_000) : 300_000;
    })(),
    livePermanentDenylistDisabled: envBool(process.env.LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED, false),
    livePermanentDenylistLocalPath:
      process.env.LIVE_OSCAR_PERMANENT_DENYLIST_LOCAL_PATH?.trim() ||
      'data/live/live-oscar-permanent-denylist.txt',
    livePermanentDenylistSeedPath:
      process.env.LIVE_OSCAR_PERMANENT_DENYLIST_SEED_PATH?.trim() ||
      'data/live/live-oscar-permanent-denylist.seed.txt',
    liveNegativeTradeDenyEnabled: envBool(process.env.LIVE_NEGATIVE_TRADE_DENY_ENABLED, true),
    liveFirstMintProbeDenyOnLossEnabled: envBool(
      process.env.LIVE_FIRST_MINT_PROBE_DENY_ON_LOSS_ENABLED,
      true,
    ),
    liveMintFirstProbeEnabled: envBool(process.env.LIVE_MINT_FIRST_PROBE_ENABLED, true),
    liveMintFirstProbeKillDropPct: (() => {
      const s = process.env.LIVE_MINT_FIRST_PROBE_KILL_DROP_PCT?.trim();
      if (!s) return 7;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.min(50, n) : 7;
    })(),
    liveMintGraduatedPath:
      process.env.LIVE_MINT_GRADUATED_PATH?.trim() || 'data/live/live-oscar-mint-graduated.txt',
    liveMintTimedLossCooldownEnabled: envBool(process.env.LIVE_MINT_TIMED_LOSS_COOLDOWN_ENABLED, false),
    liveMintTimedLossCooldownMs: (() => {
      const s = process.env.LIVE_MINT_TIMED_LOSS_COOLDOWN_MS?.trim();
      if (!s) return 86_400_000;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(7 * 24 * 3_600_000, Math.floor(n)) : 86_400_000;
    })(),
    liveMintLossReentryCooldownEnabled: envBool(process.env.LIVE_MINT_LOSS_REENTRY_COOLDOWN_ENABLED, true),
    liveMintLossReentryCooldownMs: (() => {
      const s = process.env.LIVE_MINT_LOSS_REENTRY_COOLDOWN_MS?.trim();
      if (!s) return 6 * 3_600_000;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(7 * 24 * 3_600_000, Math.floor(n)) : 6 * 3_600_000;
    })(),
    liveMintLossReentryStreakWindowMs: (() => {
      const s = process.env.LIVE_MINT_LOSS_REENTRY_STREAK_WINDOW_MS?.trim();
      if (!s) return 24 * 3_600_000;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(7 * 24 * 3_600_000, Math.floor(n)) : 24 * 3_600_000;
    })(),
    liveMintLossReentryStreakMax: (() => {
      const s = process.env.LIVE_MINT_LOSS_REENTRY_STREAK_MAX?.trim();
      if (!s) return 2;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 2 ? Math.min(10, n) : 2;
    })(),
    liveMintLossReentryStreakCooldownMs: (() => {
      const s = process.env.LIVE_MINT_LOSS_REENTRY_STREAK_COOLDOWN_MS?.trim();
      if (!s) return 24 * 3_600_000;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(7 * 24 * 3_600_000, Math.floor(n)) : 24 * 3_600_000;
    })(),
    liveMintScratchReentryEnabled: envBool(process.env.LIVE_MINT_SCRATCH_REENTRY_ENABLED, false),
    liveMintScratchReentryDropPct: (() => {
      const s = process.env.LIVE_MINT_SCRATCH_REENTRY_DROP_PCT?.trim();
      if (!s) return 0.1;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.min(0.5, n) : 0.1;
    })(),
    liveMintBlacklistEnabled: envBool(process.env.LIVE_MINT_BLACKLIST_ENABLED, false),
    liveMintBlacklistPath: process.env.LIVE_MINT_BLACKLIST_PATH?.trim() || 'data/live/live-oscar-mint-blacklist.txt',
    liveDiscoveryAuditJsonlEnabled: envBool(process.env.LIVE_DISCOVERY_AUDIT_JSONL, true),
    signalLabEnabled: envBool(process.env.SIGNAL_LAB_ENABLED, false),
    signalLabSamplePct: (() => {
      const s = process.env.SIGNAL_LAB_SAMPLE_PCT?.trim();
      if (!s) return 25;
      const n = Number(s);
      return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 25;
    })(),
    signalLabPath: process.env.SIGNAL_LAB_PATH?.trim() || 'data/live/signal-lab.jsonl',
    signalLabAltProbeFraction: (() => {
      const s = process.env.SIGNAL_LAB_ALT_PROBE_FRACTION?.trim();
      if (!s || s === '0') return 0;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0;
    })(),
    mtmShadowEnabled: envBool(process.env.MTM_SHADOW_ENABLED, false),
    mtmShadowSamplePct: (() => {
      const s = process.env.MTM_SHADOW_SAMPLE_PCT?.trim();
      if (!s) return 12;
      const n = Number(s);
      return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 12;
    })(),
    mtmShadowPath: process.env.MTM_SHADOW_PATH?.trim() || 'data/live/mtm-shadow.jsonl',
    mtmShadowAltFraction: (() => {
      const s = process.env.MTM_SHADOW_ALT_FRACTION?.trim();
      if (!s || s === '0') return 0;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0;
    })(),
    liveTrackerJupiterMaxPremiumOverSnapshotPct: (() => {
      const s = process.env.LIVE_TRACKER_JUPITER_MAX_PREMIUM_OVER_SNAPSHOT_PCT?.trim();
      if (s === '0') return 0;
      if (!s) return 6;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(200, n) : 6;
    })(),
    liveTrackerInterMintDelayMs: (() => {
      const s = process.env.LIVE_TRACKER_INTER_MINT_DELAY_MS?.trim();
      if (s === '0') return 0;
      if (!s) return 120;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? Math.min(10_000, n) : 120;
    })(),
    liveJupiterPriorityMaxLamports: (() => {
      const sol = process.env.LIVE_JUPITER_PRIORITY_MAX_SOL?.trim();
      if (sol) {
        const n = Number(sol);
        if (Number.isFinite(n) && n > 0) {
          const lam = Math.round(n * 1e9);
          if (lam >= 1 && lam <= 50_000_000) return lam;
        }
      }
      const lamEnv = process.env.LIVE_JUPITER_PRIORITY_MAX_LAMPORTS?.trim();
      if (!lamEnv) return undefined;
      const n = Number.parseInt(lamEnv, 10);
      if (!Number.isFinite(n) || n < 1) return undefined;
      return Math.min(n, 50_000_000);
    })(),
    liveJupiterSwapPriorityLevel: (() => {
      const s = (process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL ?? 'medium').trim().toLowerCase();
      if (s === 'high') return 'high';
      if (s === 'veryhigh' || s === 'very_high') return 'veryHigh';
      return 'medium';
    })(),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid live-oscar env:\n${issues}`);
  }

  const cfg = parsed.data;
  assertPathsDiffer(cfg.liveTradesPath, cfg.parityPaperTradesPath);
  assertSignalLabPathDistinct(cfg.signalLabPath, cfg.liveTradesPath, cfg.parityPaperTradesPath);
  assertMtmShadowPathDistinct(
    cfg.mtmShadowPath,
    cfg.liveTradesPath,
    cfg.parityPaperTradesPath,
    cfg.signalLabPath,
  );

  if (cfg.liveMintWhitelistEnabled) {
    const abs = path.isAbsolute(cfg.liveMintWhitelistPath.trim())
      ? cfg.liveMintWhitelistPath.trim()
      : path.resolve(process.cwd(), cfg.liveMintWhitelistPath.trim());
    if (!fs.existsSync(abs)) {
      throw new Error(`LIVE_MINT_WHITELIST_ENABLED=1 but whitelist file missing: ${abs}`);
    }
  }

  if (cfg.liveMintBlacklistEnabled) {
    const abs = path.isAbsolute(cfg.liveMintBlacklistPath.trim())
      ? cfg.liveMintBlacklistPath.trim()
      : path.resolve(process.cwd(), cfg.liveMintBlacklistPath.trim());
    if (!fs.existsSync(abs)) {
      throw new Error(`LIVE_MINT_BLACKLIST_ENABLED=1 but blacklist file missing: ${abs}`);
    }
  }

  return cfg;
}
