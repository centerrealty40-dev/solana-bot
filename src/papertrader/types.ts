export type Lane = 'launchpad_early' | 'migration_event' | 'post_migration';
export type StrategyKind = 'fresh' | 'dip' | 'smart_lottery' | 'fresh_validated';
export type ExitReason =
  | 'TP'
  | 'SL'
  | 'TRAIL'
  | 'TIMEOUT'
  /** Hard profit-agnostic time-stop: force full exit once position age ≥ configured hours (downhill capital rotation). */
  | 'TIME_STOP'
  | 'NO_DATA'
  | 'KILLSTOP'
  /** Wave B: full exit at ≤0% avg after TP ≥+7.5% (no staged add path). */
  | 'BREAKEVEN_EXIT'
  | 'LIQ_DRAIN'
  /** Volume-collapse kill-stop: rolling 1h volume fell >= threshold vs baseline, sustained >= N hours. */
  | 'VOL_COLLAPSE'
  | 'FLASH_CRASH_KILL'
  /** Journal replay expected tokens but boot reconcile reported wallet raw balance 0 (live). */
  | 'RECONCILE_ORPHAN'
  /** Live periodic job: force full exit + chain-sized sell, skipping exit price-verify defer loop. */
  | 'PERIODIC_HEAL'
  /** Phase 5: полный on-chain sell для освобождения SOL под новый вход (не ошибка журнала). */
  | 'CAPITAL_ROTATE'
  /** Wave B: full exit after TP1 when price ≤ scratch drop vs signal anchor. */
  | 'WAVE_B_POST_TP1_SCRATCH';
export type DexId = 'pumpfun' | 'pumpswap' | 'raydium' | 'orca' | 'meteora' | 'moonshot';

export interface Metrics {
  uniqueBuyers: number;
  uniqueSellers: number;
  sumBuySol: number;
  sumSellSol: number;
  topBuyerShare: number;
  bcProgress: number;
}

export interface PositionLeg {
  ts: number;
  /** EFFECTIVE entry price (with buy costs applied) — used for TP/SL/trail vs avgEntry. */
  price: number;
  /** Raw market price at entry — kept for gross PnL / post-mortem. */
  marketPrice: number;
  /** Money we paid for this leg (paper) — reduces our paper bank. */
  sizeUsd: number;
  reason: 'open' | 'dca' | 'scale_in' | 'entry_split' | 'staged_avg';
  /** For dca: trigger percentage that fired (e.g. -0.07, -0.15). */
  triggerPct?: number;
}

/** Paper TP-grid regime fork — метка по статистике цены в PG snapshots до входа. */
export type TpRegime = 'unknown' | 'up' | 'down' | 'sideways';

/** Переопределения глобального TP-grid для конкретного открытия (см. `tp-regime.ts`). */
export interface TpGridOverrides {
  gridStepPnl?: number;
  gridSellFraction?: number;
  /**
   * 1.11.167: per-open override восходящего sellFraction-профиля по ступеням
   * (1-based, см. `PAPER_TP_GRID_SELL_FRACTION_PROFILE`). Когда задан — заменяет
   * глобальный `tpGridSellFractionByStep` для этой позиции; когда не задан —
   * используется глобальный из cfg, иначе плоский `gridSellFraction`.
   */
  gridSellFractionByStep?: number[];
  gridMaxRungs?: number;
  gridFirstRungRetraceMinPnlPct?: number;
  /** Regime fork: override `PAPER_DCA_KILLSTOP` for this open (negative fraction). */
  dcaKillstop?: number;
}

export interface TpRegimeFeatures {
  netMovePct: number;
  rangePct: number;
  sampleCount: number;
  table: string | null;
}

export type DynamicKillstopShadowStatus =
  | 'used'
  | 'used_min_capped'
  | 'fallback_disabled'
  | 'fallback_no_table'
  | 'fallback_bad_input'
  | 'fallback_no_history'
  | 'fallback_low_coverage'
  | 'fallback_no_support_below_entry'
  | 'fallback_support_too_far'
  | 'fallback_query_error';

export interface DynamicKillstopShadow {
  version: 'dynamic-killstop-shadow-v1';
  status: DynamicKillstopShadowStatus;
  recommendedAction: 'use_dynamic' | 'fallback_static';
  reason: string;
  ts: number;
  mint: string;
  source: string | null;
  table: string | null;
  pairAddress: string | null;
  windowDays: number;
  entryPriceUsd: number;
  entryMarketCapUsd: number | null;
  supportPriceUsd: number | null;
  supportDistancePct: number | null;
  clusterTouches: number;
  rawKillPriceUsd: number | null;
  rawKillDropPct: number | null;
  cappedKillPriceUsd: number | null;
  cappedKillDropPct: number | null;
  dcaPriceUsd: number | null;
  dcaDropPct: number | null;
  params: {
    bufferPct: number;
    minKillDropPct: number;
    maxKillDropPct: number;
    supportClusterPct: number;
    minTouches: number;
    minHourlySamples: number;
  };
  coverage: {
    hourlySamples: number;
    rawSamples: number;
    firstTs: string | null;
    lastTs: string | null;
  };
}

export interface PartialSell {
  ts: number;
  /** EFFECTIVE sell price (with sell costs applied). */
  price: number;
  marketPrice: number;
  /** Fraction of REMAINING position sold (0..1). */
  sellFraction: number;
  reason:
    | 'TP_LADDER'
    | 'BREAKEVEN_TRIM'
    | 'WAVE_B_BREAKEVEN_INSURANCE'
    | 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL'
    | 'WAVE_B_DIP10_FIRST_TP5_PARTIAL'
    | 'WAVE_B_POST_TP1_DERISK'
    | 'TRAIL_STEP'
    | 'TRAIL'
    | 'TIMEOUT'
    | 'KILLSTOP'
    | 'SL'
    | 'SCRATCH_FLUSH0'
    | 'SCRATCH_GAP_FLUSH'
    | 'THIN_VOL_FLUSH'
    | 'FLASH_CRASH_KILL';
  proceedsUsd: number;
  grossProceedsUsd: number;
  pnlUsd: number;
  grossPnlUsd: number;
  /**
   * Live: gross SOL credited by swap (lamports), from confirmed tx meta when available.
   * When set with `proceedsUsdSource === 'chain_sol'`, proceedsUsd/pnlUsd use SOL×spot vs cost slice.
   */
  solProceedsLamports?: string;
  /** `chain_sol` = lamports из подтверждённой tx meta; `jupiter_quote` = outAmount котировки; `model` = только снимок/applyExitCosts. */
  proceedsUsdSource?: 'chain_sol' | 'jupiter_quote' | 'model';
  /** Live: подпись подтверждённого partial sell (Jupiter), для сверки с RPC. */
  exitTxSignature?: string;
  /**
   * 1.11.168: priceImpactPct из Jupiter quote того attempt, что прошёл (0..1, не %).
   * Сохраняется в JSONL для retro-аналитики leakage без необходимости сопоставлять
   * `partialSells[]` с `execution_attempt` по времени. На тонком пуле impact 2-3%
   * объясняет основную разницу между market_price и effective_price.
   */
  priceImpactPct?: number;
  /**
   * 1.11.168: фактический slippage между snapshot/marketPrice и effective sell-price
   * в процентах (positive = потеряли). Удобно: `(marketPrice - price) / marketPrice * 100`.
   * Дублируется здесь чтобы dashboard не пересчитывал на лету.
   */
  slipRealizedPct?: number;
  /** Wave B `TRAIL_STEP`: PnL fraction threshold (0..1) for this rung. */
  trailLevelPnlFrac?: number;
  /** Russian dashboard label when set at sell time. */
  timelineLabelRu?: string;
  /** Live: SPL=0 after partial while journal still had remainder — chain under-recovered vs MTM. */
  walletDrainedFlush?: boolean;
  /** Journal `remainingFraction` immediately before this partial sell. */
  remainingFractionBeforePartial?: number;
  /** MTM USD for full journal remainder at `marketPrice` when wallet drained with chain drift. */
  mtmFlushProceedsUsd?: number;
}

export interface LivePendingTpSellIntent {
  id: string;
  createdTs: number;
  updatedTs: number;
  retryUntilTs: number;
  attempts: number;
  sellFraction: number;
  reason: PartialSell['reason'];
  ladderStepIndex: number;
  ladderRungsTotal: number;
  ladderPnlPct: number;
  tpGrid: boolean;
  logLabelPct: string;
  timelineLabelRu?: string;
  triggerPnlFrac: number;
  protectBelowPnlFrac: number;
  terminalKind?: 'sim_err' | 'send_failed' | 'confirm_timeout' | 'preflight' | 'other';
  terminalMessage?: string;
}

export interface OpenTrade {
  mint: string;
  symbol: string;
  lane: Lane;
  source?: string;
  /** Parallel lane accounting (runner / pervyy lanes do not block prod open on same mint). */
  positionSource?: 'runner_probe' | 'runner_lite' | 'pervyy_vystrel';
  metricType: 'mc' | 'price';
  dex: DexId;
  entryTs: number;
  /** First-leg EFFECTIVE entry price (kept for back-compat). */
  entryMcUsd: number;
  /** USD circulating market cap at entry (from discovery snapshot, not per-token price). */
  entryMarketCapUsd: number | null;
  entryMetrics: Metrics;
  peakMcUsd: number;
  peakPnlPct: number;
  peakPnlPctAnchor?: number;
  trailingArmed: boolean;
  legs: PositionLeg[];
  partialSells: PartialSell[];
  totalInvestedUsd: number;
  /** Weighted-average EFFECTIVE entry price — used for TP/SL/trail. */
  avgEntry: number;
  /** Weighted-average MARKET entry price — used for gross PnL. */
  avgEntryMarket: number;
  remainingFraction: number;
  /** DCA drawdown levels (as fraction) already used — legacy; use with epsilon match and `dcaUsedIndices`. */
  dcaUsedLevels: Set<number>;
  /** Indices into sorted `PAPER_DCA_LEVELS` (canonical, prevents double-fills). */
  dcaUsedIndices: Set<number>;
  /**
   * Last tick's drawdown vs first leg: `(price/first-1)`.
   * Drives one-way (down) DCA: avoid re-entries after relief rallies. Not in JSONL `open`; in-memory + restore via replay.
   */
  dcaLastEvalDropFromFirstPct?: number;
  /**
   * Last tick's PnL fraction vs weighted avg: `(price/avgEntry - 1)`.
   * Used for live-oscar A/B **neutral** phase (§2 `IDEALIZED_OSCAR_STACK_SPEC_V2`): DCA triggers vs `avgEntry` after full split, not vs first leg.
   */
  dcaLastEvalPnlVsAvgFrac?: number;
  /** TP-ladder pnl levels already used (0.05, 0.10, …) — legacy; kept for restore / JSONL without step index. */
  ladderUsedLevels: Set<number>;
  /** 0-based indices into the sorted `PAPER_TP_LADDER` rungs — canonical «already fired» marker. */
  ladderUsedIndices: Set<number>;
  /** W7.5 — pool/pair address from discovery snapshot (liquidity drain watch). */
  pairAddress: string | null;
  /** W7.5 — pool liquidity USD at entry (baseline for drain detection). */
  entryLiqUsd: number | null;
  /** W7.5 — consecutive tracker ticks with liquidity below drain threshold. */
  liqWatchConsecutiveFailures?: number;
  liqWatchLastLiqUsd?: number | null;
  liqWatchLastDropPct?: number | null;
  /** VOL_COLLAPSE — rolling 1h volume USD at entry (baseline seed for collapse detection). */
  entryVol1hUsd?: number | null;
  /** VOL_COLLAPSE — high-water baseline: max(entry vol1h, peak observed vol1h). */
  volWatchBaselineUsd?: number | null;
  /** VOL_COLLAPSE — epoch ms when the current sustained collapse streak began (null = not collapsed). */
  volWatchCollapseSinceTs?: number | null;
  /** VOL_COLLAPSE — last observed rolling 1h volume USD (for journal/telemetry). */
  volWatchLastVolUsd?: number | null;
  /** VOL_COLLAPSE — last computed drop% vs baseline. */
  volWatchLastDropPct?: number | null;
  /** W7.5 — last good snapshot price from tracker (for emergency LIQ_DRAIN exit). */
  lastObservedPriceUsd?: number | null;
  /** Flash-kill ring buffer (min(Jupiter, snapshot) MTM samples). */
  flashKillPriceRing?: Array<{ ts: number; px: number }>;
  /** Last buy leg market price for post-fill velocity guard. */
  liveFlashLastBuyLegMarketPx?: number;
  liveFlashLastBuyLegTs?: number;
  /** Block DCA until this timestamp after a flash-kill event. */
  liveFlashDcaBlockedUntilTs?: number;
  /** Last tick quote inputs for flash divergence gate. */
  liveFlashLastSnapshotPx?: number | null;
  liveFlashLastJupiterPx?: number | null;
  /** W8.0-p4 — SPL decimals for Jupiter sizing (live-oscar); optional on paper restore. */
  tokenDecimals?: number | null;
  /** Last partial TP sell timestamp (ms) — throttle Jupiter partial exits; in-memory + restore from partialSells. */
  lastPartialSellTs?: number;
  /**
   * W8.0-p7.1 — confirmed buy tx signatures (open first, then each DCA leg). Required for chain replay filtering.
   */
  entryLegSignatures?: string[];
  /** W8.0-p7.1 — `simulate` skips on-chain anchor verification at boot. */
  liveAnchorMode?: 'chain' | 'simulate';

  /**
   * Live Oscar — запланированная вторая нога входа (доля позиции после первого SOL→token).
   * Сериализуется в `live_position_*` для replay; сбрасывается при DCA раньше второй ноги или при выходе цены из коридора.
   */
  livePendingScaleIn?: LivePendingScaleIn | null;

  /**
   * Live Oscar staged entry: signal anchor stays fixed while the first/second legs
   * and kill-stop are evaluated as drops from the original discovery signal price.
   */
  liveStagedEntry?: LiveStagedEntryState;

  /** TP-grid regime + overrides — заполняется при `PAPER_TP_REGIME_ENABLED` на открытии. */
  tpRegime?: TpRegime;
  tpRegimeFeatures?: TpRegimeFeatures;
  tpGridOverrides?: TpGridOverrides;
  /** Shadow-only diagnostic: proposed support-capped dynamic kill/DCA, not used by tracker yet. */
  dynamicKillstopShadow?: DynamicKillstopShadow;

  /**
   * Live Oscar (`PAPER_LIVE_EXIT_MODE_AB`): **A** до первого усреднения (DCA или scale-in), **B** после.
   * Paper игнорирует; задаётся в main/трекере при включённом флаге.
   */
  liveExitProfileMode?: 'A' | 'B';

  /**
   * Live Oscar — подряд идущие тики трекера, на которых выполняется условие KILLSTOP (PnL vs avg).
   * После пополнения позиции (`legs.length > 1`) выход только при streak ≥ 2; иначе сброс в 0.
   */
  liveKillstopBelowStreak?: number;

  /**
   * Live Oscar: после частичного выхода «у безубытка» после первой TP (`BREAKEVEN_TRIM`) — не повторять.
   */
  liveBreakevenTrimDone?: boolean;

  /**
   * Wave B: одноразовая страховка при откате к безубытку после первых двух TP (+2.5% / +5%).
   */
  liveWaveBreakevenInsuranceTaken?: boolean;
  /** Wave B half8_runner: +5% partial taken in pre-arm-without-+8%-TP ladder. */
  liveWavePreArmNoHalf8PartialTaken?: boolean;
  /** Live: retryable TP/pre-arm partial sell failed pre-broadcast; retry before marking TP. */
  livePendingTpSell?: LivePendingTpSellIntent;
  /** Wave B half8_runner: signal −10% touched before +8% TP (E+2 dip10-first path). */
  liveWaveDip10ReachedBeforeTp8?: boolean;
  /** Wave B half8_runner: dip10-first +5% partial taken (replaces half8 +8% for that path). */
  liveWaveDip10FirstTp5PartialTaken?: boolean;
  /** E+2: one-time PG/mark backfill for dip10-before-tp8 attempted on this open. */
  liveE2Dip10BackfillAttempted?: boolean;

  /**
   * Wave B: одноразовый de-risk после первой TP — продажа доли остатка при просадке ниже порога vs avg.
   */
  liveWavePostTp1DeriskTaken?: boolean;

  /**
   * Wave B: одноразовый scratch после первой TP — полное закрытие при просадке vs signal anchor.
   */
  liveWavePostTp1ScratchTaken?: boolean;

  /**
   * Wave B flat-take (1.11.475): stamped on the open when the flat-TP flag was on at open time.
   * `half8_runner` — sell 50% at each +8% + defensive-trail runner; `flat` — sell 100% at +15%, no trail.
   * Absent → legacy escalating ladder. Drives `waveBTpGridProfileFor` + the wave-B time-stop gate.
   */
  liveWaveFlatTpMode?: 'half8_runner' | 'flat';

  /** Variant A v2 thin-volume flush: `volume_5m` at entry (PG snapshot). */
  liveThinVolEntryVol5mUsd?: number;
  /** Consecutive tracker ticks with thin-volume condition after first TP. */
  liveThinVolStreak?: number;
  /** Thin-volume remainder flush executed this cycle. */
  liveThinVolFlushDone?: boolean;

  /**
   * Live Oscar — политика выхода, зафиксированная при open/restore.
   * `legacy_grid` — ladder_retrace + prod grid snapshot; `wave_b_v1` — wave TP + stepped trail;
   * `variant_a_v1` — legacy discrete TP + moon50 + full trail + smart48/96h.
   * `variant_a_v2` — infinite +5% TP grid, partial trail from +10%, DCA resets rungs.
   * `variant_a_v3` — scratch harvest: +5%→30%, flush @0% avg, no DCA after TP, price re-entry −10%.
   */
  liveExitPolicyId?:
    | 'legacy_grid'
    | 'wave_b_v1'
    | 'variant_a_v1'
    | 'variant_a_v2'
    | 'variant_a_v3'
    | 'scalp_wave_v1'
    | 'runner_probe_v1'
    | 'runner_lite_v1'
    | 'pervyy_vystrel_v1'
    | 'preset_c_scalp_v1'
    | 'fast_dip_scalp_v1'
    | 'dormant_awakening_v1';
  /** Live Oscar trade lane — prod/scalp_wave mutex; parallel lanes via composite open key. */
  liveOscarTradeLane?:
    | 'prod'
    | 'scalp_wave'
    | 'runner_probe'
    | 'runner_lite'
    | 'pervyy_vystrel'
    | 'fast_dip_scalp'
    | 'dormant_awakening';
  /** Live Oscar mcap tier: micro $500k–$1.3M; low $1.3M–$3M; scalp_wave $800k–$30M; absent = prod. */
  liveOscarMcapTier?: 'micro' | 'low' | 'prod' | 'scalp_wave';
  /** Set when scalp_wave hands off to prod/low staged management. */
  liveOscarPhaseEscalatedFrom?: 'scalp_wave';
  /** Copy-leader leg promoted to Oscar discovery management on shared wallet. */
  copyToOscarPromoted?: boolean;
  /** v3: at least one TP partial taken — blocks DCA and timed exits. */
  liveVariantAScratchHadTp?: boolean;
  liveVariantAScratchPrevPnlFrac?: number;
  liveVariantAScratchPeakPnlFrac?: number;
  liveVariantAScratchFlushedAtZero?: boolean;

  /** Variant A: peak PnL fraction (vs avg) on remainder for trail / salvage24. */
  liveVariantARemainderPeakPnlFrac?: number;
  liveVariantATrailArmed?: boolean;
  liveVariantASmart48Extended?: boolean;
  liveVariantASalvage24Checked?: boolean;
  liveVariantAH48Checked?: boolean;
  /** Set on close path for journal / mint cooldown. */
  liveVariantAExitTag?:
    | 'salvage24'
    | 'h48_loss'
    | 'horizon48'
    | 'horizon96'
    | 'moon50'
    | 'trail'
    | 'scratch_flush0'
    | 'scratch_gap_flush';

  /**
   * Wave B: max TP grid threshold (PnL frac vs avg) ever executed via partial sell.
   * Survives `waveBMaybeResetTpImpulse` — drives `BREAKEVEN_EXIT` after deep pullback.
   */
  liveWaveMaxExecutedTpFrac?: number;
  /** Wave B: last peak PnL fraction (vs avg) for wave reset. */
  liveWavePeakPnlFrac?: number;
  /** Wave B: trail anchor (local high PnL fraction). */
  liveWaveTrailAnchorPnlFrac?: number;
  /** Wave B: trail partial levels already fired (PnL fraction keys). */
  liveWaveTrailLevelsTaken?: number[];
  /** Wave B: first +7.5% vs entry market reached — early kill-stop disabled after this. */
  liveWavePreArmReached?: boolean;
  /** Wave B (pre +7.5%): price dipped below +2.5% — re-arm TP/insurance on next rally. */
  liveWaveImpulseBelowFirstRung?: boolean;

  /** Live Oscar — открытие в режиме «первый раз по mint» (жёсткий kill, без усреднения). */
  liveMintFirstProbe?: boolean;
  /** Signal-kill % зафиксирован при open (обычно 7 для first-probe). */
  liveMintFirstProbeKillDropPct?: number;

  /** Preset C: TG channel dedupe keys that unlocked entry (`mint|peakBucket`). */
  presetCTgDedupeKeys?: string[];

  /** Preset C scalp: signal anchor for entry/exit levels (TG discovery pass price). */
  presetCScalpAnchorPriceUsd?: number;
  /** Preset C scalp: +2.5% partial (50%) taken once. */
  presetCScalpTp25Taken?: boolean;
  /** Preset C scalp: +5% partial (50%) taken, trail armed. */
  presetCScalpTp5Taken?: boolean;
  /** Preset C scalp: +10% partial (50% of remainder) taken once. */
  presetCScalpTp10Taken?: boolean;
  presetCScalpTrailArmed?: boolean;
  /** Preset C scalp: −10% DCA leg filled. */
  presetCScalpDcaLegDone?: boolean;
  /** Preset C scalp: −20% DCA leg filled. */
  presetCScalpDca2LegDone?: boolean;
}

export interface LiveStagedEntryState {
  signalTs: number;
  signalPriceUsd: number;
  firstDropPct: number;
  /** Entry split leg size (USD); legacy field name kept for JSONL. */
  firstLegUsd: number;
  killDropPct: number;
  /**
   * v2: entry = 2× split (anti book impact), then optional staged averaging at −7% / −14%.
   * Legacy rows omit `entrySplitV2` — tracker keeps old immediate add-on legs vs signal.
   */
  entrySplitV2?: boolean;
  entrySplitLegUsd?: number;
  /** Asymmetric split leg-2; when omitted, same as `entrySplitLegUsd`. */
  entrySplitLeg2Usd?: number;
  /** Optional third timed entry-split leg (prod 3×+ split). */
  entrySplitLeg3Usd?: number;
  /** Prod timed entry-split legs 4–8 (8×$300 slice model). */
  entrySplitLeg4Usd?: number;
  entrySplitLeg5Usd?: number;
  entrySplitLeg6Usd?: number;
  entrySplitLeg7Usd?: number;
  entrySplitLeg8Usd?: number;
  entrySplitDelayMs?: number;
  entrySplitMaxUpPct?: number;
  entrySplitMaxDownPct?: number;
  /** When >0: leg-2 at −N% from signal instead of delay+corridor. */
  entrySplitTargetDropPct?: number;
  entrySplitAnchorUsd?: number;
  entrySplitLeg1Ts?: number;
  entrySplitLeg2Done?: boolean;
  entrySplitLeg3Done?: boolean;
  entrySplitLeg4Done?: boolean;
  entrySplitLeg5Done?: boolean;
  entrySplitLeg6Done?: boolean;
  entrySplitLeg7Done?: boolean;
  entrySplitLeg8Done?: boolean;
  entrySplitLeg2Ts?: number;
  entrySplitLeg3Ts?: number;
  entrySplitLeg4Ts?: number;
  entrySplitLeg5Ts?: number;
  entrySplitLeg6Ts?: number;
  entrySplitLeg7Ts?: number;
  entrySplitLeg8Ts?: number;
  avgSecondDropPct?: number;
  avgSecondLegUsd?: number;
  avgThirdDropPct?: number;
  avgThirdLegUsd?: number;
  avgFirstCooldownMs?: number;
  avgSecondCooldownMs?: number;
  avgFirstLegDone?: boolean;
  avgSecondLegDone?: boolean;
  avgFirstLegTs?: number;
  /** Prod: avg @ −10% as $500 slices (same size as entry-split leg). */
  avgSplitV2?: boolean;
  avgSplitLeg2Usd?: number;
  avgSplitLeg3Usd?: number;
  avgSplitLeg4Usd?: number;
  avgSplitLeg2Done?: boolean;
  avgSplitLeg3Done?: boolean;
  avgSplitLeg4Done?: boolean;
  avgSplitLeg2Ts?: number;
  avgSplitLeg3Ts?: number;
  avgSplitLeg4Ts?: number;
  /** Legacy / mirror: staged averaging (−7%) — same as `avgFirstLegDone` on v2. */
  secondDropPct: number;
  secondLegUsd: number;
  thirdDropPct?: number;
  thirdLegUsd?: number;
  secondLegDone?: boolean;
  thirdLegDone?: boolean;
  /** Первый live-вход по mint: без staged avg, kill `killDropPct` обычно 7. */
  mintFirstProbe?: boolean;
  /** Copy-adopt: avg legs = % of initial open leg; skip canonical sizing on restore. */
  copyLeaderAdoptStagedPlan?: boolean;
}

/** Параметры отложенной докупки второй ноги (Live Oscar, Jupiter-коридор к якорю первой ноги). */
export interface LivePendingScaleIn {
  /** Рыночная цена первой ноги (USD/token) — якорь для коридора. */
  anchorMarketUsd: number;
  /** USD-нотация второй ноги (= positionUsd × (1 − entryFirstLegFraction)). */
  secondLegUsd: number;
  /** Не раньше этого времени (ms) планировать проверку коридора и своп. */
  executeAfterTs: number;
  /** Допустимое отклонение вверх от якоря, в процентных пунктах (например 1 = до +1%). */
  corridorUpPct: number;
  /** Допустимое отклонение вниз от якоря, в процентных пунктах (например 2 = до −2%). */
  corridorDownPct: number;
  maxSwapAttempts: number;
  /** Число завершённых попыток свопа (успех или провал после коридора). */
  swapAttempts: number;
  /** После неудачного свопа в коридоре — не пытаться раньше этого ts. */
  nextAttemptAfterTs: number;
}

export interface CloseCosts {
  dex: DexId;
  fee_bps_per_side: number;
  slip_base_bps_per_side: number;
  slip_dynamic_bps_entry: number;
  slip_dynamic_bps_exit: number;
  network_fee_usd_total: number;
  gross_pnl_usd: number;
  fee_cost_usd: number;
  slippage_cost_usd: number;
  network_cost_usd: number;
  net_pnl_usd: number;
}

/**
 * Rich context attached to every `close` event so the dashboard can render a
 * concrete, audit-ready exit reason (instead of just "TP" or "SL").
 *
 * Goal: when reviewing a closed trade you should be able to tell within ~2 sec
 * whether the exit was justified by checking peakPnlPct, retraceFromPeakPct,
 * triggerLabel, and whether the trail was actually armed.
 */
export interface ExitContext {
  /** Final realized PnL % from average entry (== ClosedTrade.pnlPct, copied for self-contained UI). */
  closePnlPct: number;
  /** Highest PnL % observed during the lifetime of the position. */
  peakPnlPct: number;
  /** ((peak - close) / peak) * 100. Positive number = how much we gave up after the peak. NaN if peak<=0. */
  retraceFromPeakPct: number | null;
  /** Whether trail mechanism actually armed (price reached cfg.trailTriggerX). */
  trailingArmed: boolean;
  /** Hours in position when the close fired. */
  ageHours: number;
  /** Number of TP-ladder levels that fired before final close. */
  tpLadderHits: number;
  /** Total TP-ladder levels configured for this strategy. */
  tpLadderTotal: number;
  /** Number of DCA legs added (excluding the initial entry leg). */
  dcaLegsAdded: number;
  /** Fraction of the position still open at the moment of final close (0 = fully sold via TP ladder). */
  remainingFractionAtClose: number;
  /** Short human label of the trigger that actually fired, e.g. "TP xAvg≥1.50", "SL xAvg≤0.90", "ladder retrace from 1.20x→below 1.10x", "peak retrace -10%", "TIMEOUT 1h", "DCA killstop -25%", "no-data 1h", "liq drop -84% in 60s". */
  triggerLabel: string;
  /** Strategy parameter snapshot at the moment of close — for audit (was tpX 1.5? trail 5 %?). */
  cfgSnapshot: {
    tpX: number;
    slX: number;
    trailMode: 'ladder_retrace' | 'peak' | 'stepped_grid';
    trailDrop: number;
    trailTriggerX: number;
    timeoutHours: number;
    dcaKillstop: number;
  };
}

export interface ClosedTrade extends OpenTrade {
  exitTs: number;
  exitMcUsd: number;
  exitReason: ExitReason;
  /** Realized NET total return % vs invested. */
  pnlPct: number;
  durationMin: number;
  totalProceedsUsd: number;
  netPnlUsd: number;
  grossTotalProceedsUsd: number;
  grossPnlUsd: number;
  grossPnlPct: number;
  costs: CloseCosts;
  /** Effective entry/exit prices (with costs). */
  effective_entry_price: number;
  effective_exit_price: number;
  /** Theoretical entry/exit prices (raw market). */
  theoretical_entry_price: number;
  theoretical_exit_price: number;
  /** Audit-ready breakdown of why this trade closed; stamped by tracker. */
  exitContext?: ExitContext;
  /** Live: подпись финального `sell_full`, если был on-chain выход. */
  fullExitTxSignature?: string;
}

export type JsonlEventKind =
  | 'heartbeat'
  | 'eval'
  | 'eval-skip-open'
  | 'eval-skip-exit'
  | 'open'
  | 'peak'
  | 'dca_add'
  | 'partial_sell'
  | 'close'
  | 'followup_snapshot'
  | 'liq_watch_tick'
  | 'live_oscar_intel_shadow'
  | 'live_oscar_intel_block';

export interface JsonlEventBase {
  ts: number;
  strategyId: string;
  kind: JsonlEventKind;
}

export interface HeartbeatEvent extends JsonlEventBase {
  kind: 'heartbeat';
  uptimeSec: number;
  openPositions: number;
  closedTotal: number;
  solUsd: number;
  btc: { ret1h_pct: number | null; ret4h_pct: number | null; updated_ts: number | null };
  /** "no candidates" / "filters not implemented" / "discovery skipped" — диагностика. */
  note?: string;
  /** W7.5 — exit counters including LIQ_DRAIN (same object as tracker stats RAM). */
  trackerStats?: Record<ExitReason, number>;
  /** W7.4.2 — deferred exits (blocked pre-exit Jupiter quote with block_on_fail). */
  skippedPriceVerifyExit?: number;
}

export interface SnapshotCandidateRow {
  mint: string;
  symbol: string;
  ts: Date | string;
  launch_ts: Date | string | null;
  age_min: number | null;
  price_usd: number;
  liquidity_usd: number;
  volume_5m: number;
  /** DEX snapshot hourly volume (USD), same source as collectors — used for 5m vs 1h consistency guard. */
  volume_1h: number;
  buys_5m: number;
  sells_5m: number;
  market_cap_usd: number | null;
  source: string;
  holder_count: number;
  token_age_min: number;
  /** Pool address from DEX snapshot row (W7.5). */
  pair_address: string | null;
}

export interface DipContext {
  high_px: number;
  low_px: number;
}

export interface SnapshotFeatures {
  price_usd: number;
  /**
   * Epoch ms of the PG snapshot row whose `price_usd` is used here (from `*_pair_snapshots.ts`).
   * Observability only — lets the entry path measure how stale the polled PG price is
   * (collector poll 30s + reeval throttle). `null`/absent for legacy rows without a parseable ts.
   */
  snapshot_ts_ms?: number | null;
  liq_usd: number;
  /** Pool/pair address from snapshot (W7.5). */
  pair_address: string | null;
  vol5m_usd: number;
  /** Hourly volume from pair snapshot row (USD). */
  vol1h_usd: number;
  buys5m: number;
  sells5m: number;
  buy_sell_ratio_5m: number | null;
  holders: number;
  token_age_min: number;
  dip_pct: number | null;
  impulse_pct: number | null;
  /** Lookback window (minutes) that satisfied the dip OR-gate; null if eval failed or legacy rows. */
  dip_lookback_min: number | null;
  /**
   * Per-window dip% (last_price/high - 1) for every configured lookback window with ctx data.
   * Always populated when DipContext exists, regardless of pass/fail. Empty record if no PG ctx.
   * Use to see "how far we were from −20% threshold" in retro telemetry.
   */
  dip_pct_by_window?: Record<number, number>;
  /** Pool-reported mcap (or FDV coalesced in SQL) at discovery row — stamped into jsonl for dashboards. */
  market_cap_usd: number | null;
  /** Live Oscar двухфазный вход: `low` ($1.3M–$3M) | `prod` (>$3M). */
  live_oscar_mcap_tier?: 'micro' | 'low' | 'prod';
  recovery_veto?: {
    threshold_pct: number;
    veto_windows_min: number[];
    dip_window_used_min: number | null;
    bounces_pct: Record<string, number>;
    vetoed: boolean;
    veto_reasons: string[];
  };
  /** Post-exit re-entry fork observability (breakout bypass path). */
  reentry_fork?: {
    observability: string[];
  };
  local_high_veto?: {
    threshold_pct: number;
    veto_windows_min: number[];
    distance_from_high_pct: Record<string, number>;
    vetoed: boolean;
    veto_reasons: string[];
  };
  /** 1.11.249: multi-day trend / stale-runner structure veto (retro / audit). */
  trend_structure_veto?: {
    enabled: boolean;
    coverageOk: boolean;
    lookbackDays: number;
    highLookbackUsd: number | null;
    daysSinceHighBreak: number | null;
    price7dAgoUsd: number | null;
    price3dAgoUsd: number | null;
    slope7dPct: number | null;
    slope3dPct: number | null;
    pxVsHighLookback: number | null;
    localLowLookbackUsd: number | null;
    hoursSinceLocalLow: number | null;
    skiSlopeReversalBypass: boolean;
    pgSnapsCount: number;
    vetoed: boolean;
    veto_reasons: string[];
    thresholds: {
      minDaysSinceHighBreak: number;
      maxPxVsHighLookback: number;
      maxSlope7dPct: number;
    };
  };
  post_crash_fast?: {
    enabled: boolean;
    pass: boolean;
    coverageOk: boolean;
    lookbackMin: number;
    peakPx: number | null;
    minutesSincePeak: number | null;
    dropFromPeakPct: number | null;
    maxVol5mSpikeRatio: number | null;
    priceChange15mPct: number | null;
    pgSnapsCount: number;
    reasons: string[];
    thresholds: {
      minDropPct: number;
      maxDropPct: number;
      minVolSpikeMult: number;
      stabilizeMin: number;
      maxAgeMin: number;
      maxKnife15mPct: number;
    };
  };
  range_base_dip?: {
    enabled: boolean;
    pass: boolean;
    coverageOk: boolean;
    lookbackHours: number;
    rangeLo: number | null;
    rangeHi: number | null;
    rangeSpanPct: number | null;
    netMove48hPct: number | null;
    dropFromRangeLowPct: number | null;
    vol5mSpikeRatio: number | null;
    pgSnapsCount: number;
    reasons: string[];
    thresholds: {
      maxSpanPct: number;
      maxNetMovePct: number;
      minVol5mSpikeMult: number;
    };
  };
  /**
   * 1.11.167: вычисленные метрики Policy A+ для retro-анализа. Прикрепляются к
   * decision независимо от того, заблокирован ли вход (если фильтр выключен —
   * блок `enabled: false`, `coverageOk: false` и метрики могут быть null).
   */
  policy_a_plus?: {
    enabled: boolean;
    coverageOk: boolean;
    bounceFromMin30mPct: number | null;
    priceChange30mPct: number | null;
    priceChange1hPct: number | null;
    vol1hUsd: number | null;
    min30m: number | null;
    price30mAgo: number | null;
    price1hAgo: number | null;
    pgSnapsCount: number;
    thresholds: {
      bounceFromMin30mMaxPct: number;
      priceChange1hMinPct: number;
      priceChangeWindowMin: number;
      priceChange30mMinPct: number;
      vol1hMaxUsd: number;
    };
  };
  /** 1.11.216: dead→spike volume sybil pattern metrics (retro / audit). */
  volume_sybil?: {
    enabled: boolean;
    coverageOk: boolean;
    lookbackHours: number;
    recentMinutes: number;
    baselineSampleCount: number;
    baselineDeadCount: number;
    baselineDeadFraction: number | null;
    baselineP10Vol5mUsd: number | null;
    baselineP50Vol5mUsd: number | null;
    recentMaxVol5mUsd: number | null;
    currentVol5mUsd: number | null;
    effectiveRecentVol5mUsd: number | null;
    spikeRatio: number | null;
    thresholds: {
      baselineP10MaxUsd: number;
      minBaselineSamples: number;
      minRecentVol5mUsd: number;
      spikeRatioMin: number;
      deadVol5mUsd: number;
      minDeadFraction: number;
      vol1hAliveExemptUsd: number;
    };
  };
  /** 1.11.219: narrow-window hourly volume burst metrics (retro / audit). */
  volume_ephemeral?: {
    enabled: boolean;
    /** Prior bot trade in lookback — ephemeral spike blocks skipped (1.11.544). */
    knownMint?: boolean;
    /** Familiar repeat-traded mint with bypass flag enabled. */
    familiarMint?: boolean;
    familiarMintBypass?: boolean;
    /** Fresh Birdeye/DexScreener quote bypassed PG-blind ephemeral blocks. */
    birdeyeFreshBypass?: boolean;
    coverageOk: boolean;
    lookbackHours: number;
    hoursWithData: number;
    activeHours: number;
    peakHourVol5mUsd: number | null;
    currentVol5mUsd: number | null;
    peakToCurrentRatio: number | null;
    /** PG neighbor-hour sanity (1.11.545). */
    vol5mPrev1hUsd?: number | null;
    vol5mPrev2hUsd?: number | null;
    medianVol5m12hUsd?: number | null;
    neighborHealthy?: boolean;
    singleTickStaleIgnored?: boolean;
    staleIgnoreFlag?: string;
    thresholds: {
      minActiveHourVol5mUsd: number;
      maxActiveHours: number;
      minPeakVol5mUsd: number;
      minHoursWithData: number;
      sparseHoursBuffer: number;
      tailBlockEnabled: boolean;
      tailMaxPeakRatio: number;
      newMintMinActiveHours?: number;
    };
  };
  /** Ephemeral volume spike: dormant baseline → sudden vol1h (48h, age-agnostic). */
  old_mint_dormant_vol_spike?: {
    enabled: boolean;
    tokenAgeDays: number | null;
    coverageOk: boolean;
    lookbackHours: number;
    baselineStartHoursAgo: number;
    baselineEndHoursAgo: number;
    baselineMode: 'primary' | 'fallback_first24h' | null;
    dormantLookbackHours: number;
    recentHours: number;
    baselineHoursWithData: number;
    dormantHours: number;
    dormantHourFraction: number | null;
    baselineMedianVol1hUsd: number | null;
    baselineP90Vol1hUsd: number | null;
    recentMaxVol1hUsd: number | null;
    currentVol1hUsd: number | null;
    effectiveRecentVol1hUsd: number | null;
    vol1hSpikeRatio: number | null;
    thresholds: {
      minTokenAgeDays: number;
      maxYoungTokenAgeDays: number;
      dormantVol1hMaxUsd: number;
      minDormantHourFraction: number;
      minSpikeVol1hUsd: number;
      vol1hRatioMin: number;
    };
  };
  /** 1.11.545: holistic volume/holder profile for repeat mints on each discovery eval. */
  known_mint_vol_profile?: {
    vol5mUsd: number;
    vol1hUsd: number;
    vol5mPrev1hUsd: number | null;
    vol5mPrev2hUsd: number | null;
    activeHours24h: number | null;
    holderCount: number | null;
    medianVol5m12hUsd: number | null;
    singleTickStaleIgnored: boolean;
  };
  /** 1.11.222: PG minute-bar coverage / gap metrics for volume guard trust. */
  pg_data_coverage?: {
    enabled: boolean;
    nearEntry: boolean;
    lookbackHours: number;
    recentHours?: number;
    minuteSamples: number;
    hoursWithData: number;
    recentHoursWithData?: number;
    hourCoverageRatio: number | null;
    recentHourCoverageRatio?: number | null;
    maxGapMinutes: number | null;
    sybilBaselineSamples: number;
    sybilCoverageOk: boolean;
    ephemeralCoverageOk: boolean;
    knownMintGapBypass?: boolean;
    familiarMintStaleBypass?: boolean;
    birdeyeFreshBypass?: boolean;
    global: {
      pgStaleNow: boolean;
      systemHourRatio: number | null;
      strictRecoveryActive: boolean;
      hoursSinceLastRecovery: number | null;
      coverageMode?: 'relaxed' | 'full';
    };
    thresholds: {
      minHourRatio: number;
      strictMinHourRatio: number;
      minSystemHourRatio: number;
      minRecentHoursWithData?: number;
      maxGapMinutes: number;
    };
  };
  /**
   * 1.11.232: Runner Mode features (Open Interest Magnet).
   *
   * Аггрегаты vol/buys/sells/liq/mcap/price по окнам 1ч/12ч/24ч, посчитанные на PG
   * минутных снапшотах. Заполняются всегда, когда `runnerModeEnabled=true`, независимо
   * от итогового решения — это даёт возможность задним числом крутить пороги.
   */
  runner?: {
    enabled: boolean;
    coverageOk: boolean;
    pgSamples24h: number;
    vol1hUsd: number;
    vol12hUsd: number;
    vol24hUsd: number;
    vol1hAvg24hUsd: number;
    vol1hVelocity: number | null;
    bs1h: number | null;
    bs12h: number | null;
    vol5mPeak1hUsd: number;
    liqNowUsd: number;
    liqP25_24hUsd: number | null;
    liqP50_24hUsd: number | null;
    mcapNowUsd: number;
    mcapMax24hUsd: number | null;
    priceNowUsd: number;
    priceMax24hUsd: number | null;
    thresholds: {
      minVol1hUsd: number;
      minVol12hUsd: number;
      velocityMinX: number;
      minVol5mPeak1hUsd: number;
      bs1hMin: number;
      bs12hMin: number;
      liqVsP25Min: number;
      priceHoldMin: number;
      minMcapUsd: number;
      maxMcapUsd: number;
      minLiqUsd: number;
      staleVolRatioMax: number;
      minPgSamples24h: number;
    };
  };
}

export type SellerProfile =
  | 'capitulator'
  | 'still_dumping'
  | 'dca_predictable'
  | 'dca_aggressive'
  | 'panic_random'
  | 'unknown';

export interface WhaleSeller {
  wallet: string;
  amount_usd: number;
  pct_of_position_dumped: number;
  pct_total_dumped_now: number;
  is_creator: boolean;
  profile: SellerProfile;
  n_sells_24h: number;
  median_interval_min: number | null;
  median_chunk_usd: number | null;
}

export interface WhaleAnalysis {
  enabled: boolean;
  creator_wallet: string | null;
  creator_dumped_pct: number;
  creator_dump_block: boolean;
  large_sells: WhaleSeller[];
  single_whale_capitulation: boolean;
  group_sell_pressure: boolean;
  dca_predictable_present: boolean;
  dca_aggressive_present: boolean;
  trigger_fired: 'whale_capitulation' | 'group_pressure' | 'dca_predictable' | null;
  block_reasons: string[];
}

/** W7.2 on-chain pre-entry safety (QuickNode batch). */
export interface SafetyVerdict {
  ok: boolean;
  reasons: string[];
  mint_authority: string | null;
  freeze_authority: string | null;
  top_holder_pct: number | null;
  decimals: number | null;
  /** Raw supply (u64 as string). */
  supply: string | null;
  ts: number;
}

export interface EvalEvent extends JsonlEventBase {
  kind: 'eval';
  lane: Lane;
  source?: string;
  mint: string;
  symbol: string;
  ageMin: number;
  pass: boolean;
  reasons: string[];
  m: SnapshotFeatures;
  btc: { ret1h_pct: number | null; ret4h_pct: number | null; updated_ts: number | null };
  whale_analysis: WhaleAnalysis | null;
  /** См. `PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP`; только наблюдаемость. */
  entry_path?: 'dip_windows' | 'impulse_pg_snap';
}

export interface EvalSkipOpenEvent extends JsonlEventBase {
  kind: 'eval-skip-open';
  lane: Lane;
  source?: string;
  mint: string;
  symbol?: string;
  reason: string;
}

/** W7.4.2 — deferred exit because Jupiter pre-exit quote vs snapshot failed gates. */
export interface EvalSkipExitEvent extends JsonlEventBase {
  kind: 'eval-skip-exit';
  mint: string;
  context: 'partial_sell' | 'close';
  reason: string;
  priceVerifyExit: PriceVerifyVerdict;
}

export interface PreEntryDynamics {
  holders_30m_ago: number;
  holders_10m_ago: number;
  holders_now: number;
  holders_delta_30_to_now: number;
  holders_delta_10_to_now: number;
  vol5m_30m_ago_usd: number;
  vol5m_10m_ago_usd: number;
  vol5m_now_usd: number;
  vol_growth_30m_pct: number | null;
  vol_growth_10m_pct: number | null;
  bs_5m_30m_ago: number | null;
  bs_5m_10m_ago: number | null;
  bs_5m_now: number | null;
  price_30m_ago: number | null;
  price_10m_ago: number | null;
  price_now: number | null;
  price_growth_30m_pct: number | null;
  price_growth_10m_pct: number | null;
  trend_holders: 'rising' | 'flat' | 'falling' | 'unknown';
  trend_volume: 'rising' | 'flat' | 'falling' | 'unknown';
  trend_price: 'rising' | 'flat' | 'falling' | 'unknown';
}

export interface PendingFollowup {
  mint: string;
  symbol: string;
  entryTs: number;
  entryPrice: number;
  entryMarketPrice: number;
  metricType: 'mc' | 'price';
  source?: string;
  offsetMin: number;
  dueTs: number;
}

export interface ContextSwap {
  ts: number;
  side: string;
  amount_usd: number;
  price_usd: number;
  wallet?: string;
}

/** W7.3 — live priority fee snapshot stamped onto open/dca_add/partial_sell/close events. */
export interface PriorityFeeQuote {
  microLamportsPerCu: number | null;
  computeUnits: number;
  usd: number;
  source: 'live' | 'fallback';
  ageMs: number | null;
  ts: number;
}

/** W7.5 — DEX snapshot source for pool liquidity lookup. */
export type DexSource =
  | 'raydium'
  | 'meteora'
  | 'orca'
  | 'moonshot'
  | 'pumpswap'
  | 'pump'
  | 'jupiter';

/**
 * W7.5 — liquidity drain watch verdict (per tracker tick).
 * Stamped onto `close` events with exitReason='LIQ_DRAIN'.
 */
export type LiqWatchVerdict =
  | {
      kind: 'ok';
      currentLiqUsd: number;
      dropPct: number;
      ageMs: number;
      from: 'snapshot' | 'rpc';
      ts: number;
    }
  | {
      kind: 'pending';
      currentLiqUsd: number | null;
      consecutiveFailures: number;
      ageMs: number | null;
      ts: number;
    }
  | {
      kind: 'force-close';
      reason: 'LIQ_DRAIN';
      currentLiqUsd: number;
      dropPct: number;
      ageMs: number;
      from: 'snapshot' | 'rpc';
      ts: number;
    }
  | {
      kind: 'skipped';
      reason:
        | 'feature-disabled'
        | 'no-pair-address'
        | 'no-entry-liq'
        | 'snapshot-stale'
        | 'rpc-disabled'
        | 'rpc-failed'
        | 'pre-min-age'
        | 'liq-disagreement';
      ts: number;
      pgLiqUsd?: number;
      referenceLiqUsd?: number;
      disagreementPct?: number;
    };

/**
 * VOL_COLLAPSE — rolling-volume drain verdict. Mirrors {@link LiqWatchVerdict}: pure state machine
 * evaluated each tracker tick. `collapseSinceTs` carries the streak anchor forward across ticks.
 */
export type VolWatchVerdict =
  | {
      /** Volume above collapse threshold — healthy; streak reset. */
      kind: 'ok';
      currentVolUsd: number;
      baselineUsd: number;
      dropPct: number;
      collapseSinceTs: null;
      ts: number;
    }
  | {
      /** Collapsed but not yet sustained long enough (or no fresh volume this tick). */
      kind: 'pending';
      currentVolUsd: number | null;
      baselineUsd: number | null;
      dropPct: number | null;
      collapseSinceTs: number | null;
      sustainedMs: number | null;
      ts: number;
    }
  | {
      kind: 'force-close';
      reason: 'VOL_COLLAPSE';
      currentVolUsd: number;
      baselineUsd: number;
      dropPct: number;
      collapseSinceTs: number;
      sustainedMs: number;
      ts: number;
    }
  | {
      kind: 'skipped';
      reason: 'feature-disabled' | 'pre-min-age' | 'baseline-too-small';
      collapseSinceTs: number | null;
      ts: number;
    };

/** Wrapped SOL mint — Jupiter quote `inputMint` for SOL → token. */
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * W7.4 — pre-entry price verification verdict (Jupiter quote sanity check).
 * Stamped on `open` when cfg.priceVerifyEnabled === true.
 * W7.4.2 — same shape for pre-exit (token→SOL quote vs snapshot exit price).
 */
export type PriceVerifyVerdict =
  | {
      kind: 'ok';
      jupiterPriceUsd: number;
      snapshotPriceUsd: number;
      slipPct: number;
      priceImpactPct: number;
      routeHops: number;
      source: 'jupiter';
      ageMs: number;
      ts: number;
    }
  | {
      kind: 'blocked';
      jupiterPriceUsd: number;
      snapshotPriceUsd: number;
      slipPct: number;
      priceImpactPct: number;
      routeHops: number;
      reason: 'slip-too-high' | 'impact-too-high' | 'no-route';
      source: 'jupiter';
      ageMs: number;
      ts: number;
    }
  | {
      kind: 'skipped';
      reason:
        | 'feature-disabled'
        | 'sol-px-missing'
        | 'fetch-fail'
        | 'timeout'
        | 'http-error'
        | 'parse-error'
        | 'circuit-open'
        | 'no-route';
      ts: number;
    };

/** W7.8 — on-chain `simulateTransaction` audit (Jupiter-unsigned build + QN). Stamped on `open` when enabled / sampled. */
export type SimAuditStamp =
  | { kind: 'skipped'; reason: string; ts: number; wallMs?: number }
  | {
      kind: 'ok' | 'err';
      ts: number;
      wallMs: number;
      qnCredits: number;
      err?: { code: number; message: string } | null;
      unitsConsumed?: number | null;
      buildKind: 'jupiter' | 'disabled';
      notes?: string;
    };
