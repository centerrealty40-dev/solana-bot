import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import type { MildDipEntryGates, MildDipExitGates } from './gates.js';

const ExecutionModeSchema = z.enum(['paper', 'dry_run', 'live']);

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

const MildDipConfigSchema = z.object({
  executionMode: ExecutionModeSchema,
  rpcUrl: z.string().min(8),
  walletSecret: z.string().optional(),
  walletPubkeyExpected: z.string().min(32).max(64).optional(),
  journalPath: z.string().min(1),
  statePath: z.string().min(1),
  /** 1.11.754 — flat $30 across base/thick/micro. */
  positionUsd: z.coerce.number().positive().max(10_000).default(5),
  /**
   * Thick-name clip (mcap/liq/age). 0 = off.
   * 1.11.754 — same $30 as base (flat book).
   */
  thickPositionUsd: z.coerce.number().min(0).max(10_000).default(5),
  thickMinMarketCapUsd: z.coerce.number().min(0).default(100_000),
  thickMinLiquidityUsd: z.coerce.number().min(0).default(50_000),
  thickMinPairAgeHours: z.coerce.number().min(0).default(6),
  /**
   * Micro-cap clip: mcap ∈ [min, max] → this size (knife_stabilize only).
   * 1.11.754 — same $30 as base (flat book). 0 = off.
   */
  microPositionUsd: z.coerce.number().min(0).max(10_000).default(5),
  microMinMarketCapUsd: z.coerce.number().min(0).default(15_000),
  microMaxMarketCapUsd: z.coerce.number().min(0).default(50_000),
  /** 0 = unlimited — keep buying while USDC remains. */
  maxOpenPositions: z.coerce.number().int().min(0).max(500).default(0),
  /** Background lane may run at 3s when stream/leader fast-path owns entries. */
  scanIntervalMs: z.coerce.number().int().min(3_000).max(600_000).default(5_000),
  /**
   * Open-book exit poll cadence. Live target ≤5s (1.11.736); was 2s on paper
   * but Dex-only marks + scan blocking stretched real gaps to ~60s.
   */
  markIntervalMs: z.coerce.number().int().min(1_000).max(120_000).default(2_000),
  /**
   * Prefer stream/ring for open marks. Fresh target ≤ this (ms); usable ring
   * may be older (see loop ringStaleMax). 0 = Dex-only.
   */
  markStreamMaxAgeMs: z.coerce.number().int().min(0).max(60_000).default(5_000),
  /**
   * How often to still hit Dex on an open mint (vol fade + structural warm).
   * Price exits use stream between Dex refreshes.
   */
  markDexRefreshMs: z.coerce.number().int().min(0).max(300_000).default(15_000),
  /**
   * DexScreener mark cache TTL — avoid bypassCache hammering the gate.
   * Keep ≈ markIntervalMs (default 2s on sole-consumer Oscar).
   */
  markCacheTtlMs: z.coerce.number().int().min(0).max(120_000).default(2_000),
  /** Parallel DexScreener marks per exit pass. */
  markConcurrency: z.coerce.number().int().min(1).max(64).default(48),
  /** Parallel Dex enrich during candidate scan (still behind Dex gate). */
  enrichConcurrency: z.coerce.number().int().min(1).max(32).default(12),
  /** Parallel Jupiter sells — sole consumer can push higher. */
  sellConcurrency: z.coerce.number().int().min(1).max(8).default(6),
  /**
   * Max bounce % off the price-ring trough (cooldown lookback) before rebuy.
   * 0 = off. Default 6 — refuse buying a “good” bounce off the wick.
   */
  maxCooldownBouncePct: z.coerce.number().min(0).max(100).default(6),
  /** Lookback window for trough / stream drawdown (default = 5m cooldown). */
  cooldownBounceLookbackMs: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
  /**
   * After a full exit: require mark ≥ this % below exit price before rebuy.
   * Stream mark only — no Dex. 0 = off. Default 4.
   */
  /** 1.11.757 — live default 10 (was 20). */
  rebuyBelowExitPct: z.coerce.number().min(0).max(50).default(10),
  /** How long the last-exit floor applies (ms). Default 15m. */
  rebuyBelowExitMaxAgeMs: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
  /** Allow entry when stream drawdown is in dip band even if Dex pc5m is flat. */
  streamDipEntryEnabled: z.boolean().default(true),
  /** Decode program-log signatures → stream price samples (RPC). */
  streamPriceSampleEnabled: z.boolean().default(true),
  streamPriceMinGapMs: z.coerce.number().int().min(500).max(60_000).default(2_000),
  streamPriceConcurrency: z.coerce.number().int().min(1).max(8).default(3),
  /**
   * On open mints: if a stream sell empties a wallet bag (post≈0) and is large,
   * defer peak_giveback for graceMs. cliff_dump still fires. 0 grace = off.
   */
  oneshotDumpGraceEnabled: z.boolean().default(true),
  oneshotDumpGraceMs: z.coerce.number().int().min(0).max(600_000).default(60_000),
  oneshotDumpMinSellUsd: z.coerce.number().min(0).max(1_000_000).default(500),
  /** post/pre ≤ this counts as emptied (dust left OK). */
  oneshotDumpMaxPostResidualFrac: z.coerce.number().min(0).max(1).default(0.02),
  /**
   * Before soft peak_giveback: classify red candle as whale oneshot vs mass flee
   * from stream sell tape. 0 wait = classify-only (no pending hold).
   */
  dumpClassifyEnabled: z.boolean().default(true),
  dumpClassifyWindowMs: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  /** Hold giveback while class=unknown, then timeout → sell as mass_flee. */
  dumpClassifyWaitMs: z.coerce.number().int().min(0).max(60_000).default(5_000),
  dumpClassifyMassMinSellers: z.coerce.number().int().min(2).max(20).default(3),
  /** Top seller USD share ≥ this (and ≥ minSellUsd) ⇒ whale_oneshot. */
  dumpClassifyWhaleShare: z.coerce.number().min(0.5).max(1).default(0.6),
  /**
   * Defer soft exits (stale/dead/vol_fade/giveback) when mark has bounced
   * ≥ minBouncePct off the ring trough in lookback. cliff/timeout still fire.
   */
  /** 1.11.749 default off — was blocking trail giveback on green-vs-trough. */
  recoverDeferEnabled: z.boolean().default(false),
  recoverDeferLookbackMs: z.coerce.number().int().min(30_000).max(3_600_000).default(300_000),
  recoverDeferMinBouncePct: z.coerce.number().min(0).max(50).default(3),
  /**
   * 1.11.761 — when a soft exit is about to fire and a tracked leader just
   * bought the same mint (average-down), defer the sell and optionally
   * scale-in once. Narrow: requires shouldExit + red pnl + fresh leader hit.
   * Not a general −5% scale-in.
   */
  leaderAlignEnabled: z.boolean().default(true),
  /** Max age of leader seed hit to count as “just bought”. */
  leaderAlignMaxAgeMs: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
  /** Still-red floor vs entry (default 3%). Blocks green/flat align. */
  leaderAlignRequireRedPct: z.coerce.number().min(0).max(50).default(3),
  /** Leader fill/mark must be ≥ this % below our entry (0 = ≤ entry). */
  leaderAlignMinBelowEntryPct: z.coerce.number().min(0).max(50).default(0),
  /** Only count leader isAdd (not first bag open). Default off — any buy OK. */
  leaderAlignRequireAdd: z.boolean().default(false),
  /** One-shot average-in USD while deferring (0 = defer only, no buy). */
  leaderAlignScaleInEnabled: z.boolean().default(true),
  leaderAlignScaleInUsd: z.coerce.number().min(0).max(10_000).default(15),
  /**
   * Journal one `mild_dip_mark` row per open position at most this often.
   * Gives an offline price path per trade so trail widths can be re-fitted on
   * our own tape instead of the leader's. 0 = off. 1.11.736 default 5s.
   */
  markJournalMs: z.coerce.number().int().min(0).max(3_600_000).default(5_000),
  hotMintsPath: z.string().default(path.join('data', 'milddip', 'hot-mints.json')),
  priceRingPath: z.string().default(path.join('data', 'milddip', 'price-ring.json')),
  /** Telegram ALERT when mark pass / opens / null-ratio signal Dex pressure. */
  loadAlertEnabled: z.boolean().default(true),
  loadAlertMarkPassMs: z.coerce.number().int().min(5_000).max(600_000).default(20_000),
  loadAlertOpenCount: z.coerce.number().int().min(5).max(500).default(50),
  loadAlertNullRatio: z.coerce.number().min(0.1).max(1).default(0.4),
  loadAlertCooldownMs: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
  /** After any close — short so bounce clip can re-enter (1.11.715 → 60s). */
  mintCooldownMs: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  /**
   * After a losing exit (pnl &lt; 0). 1.11.715: same 60s as base so bounce
   * after close is not blocked for 10m.
   */
  lossCooldownMs: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(150),
  minFeeSolReserve: z.coerce.number().min(0).max(10).default(0.02),
  /**
   * Periodic USDC→native SOL top-up when fee SOL wallet value is below floor.
   * Default on: check every 6h; if SOL &lt; $5, buy $20 SOL.
   */
  feeSolTopupEnabled: z.boolean().default(true),
  /** How often to re-check fee SOL when healthy (urgent path still bypasses). */
  feeSolTopupIntervalMs: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
  feeSolTopupMinUsd: z.coerce.number().min(0).max(1_000).default(5),
  feeSolTopupBuyUsd: z.coerce.number().positive().max(500).default(20),
  /**
   * Candidate mint sources: comma list —
   * stream,boosts,profiles,leaders,pg_volume,gecko,seed
   */
  discoverSources: z.string().default('stream,boosts,profiles'),
  seedMintsPath: z.string().optional(),
  /** Sidecar written by leader-observer (`leader_buy_observed` → seed). */
  leaderSeedPath: z.string().default(path.join('data', 'milddip', 'leader-seed.json')),
  leaderSeedMaxAgeMs: z.coerce.number().int().min(60_000).max(86_400_000).default(7_200_000),
  leaderSeedMax: z.coerce.number().int().min(0).max(80).default(40),
  /** PumpSwap PG top-vol seed (freshness-gated; soft-fail). */
  pgVolumeMax: z.coerce.number().int().min(0).max(80).default(30),
  pgVolumeCacheMs: z.coerce.number().int().min(15_000).max(600_000).default(60_000),
  pgVolumeLookbackMin: z.coerce.number().int().min(2).max(60).default(10),
  /** GeckoTerminal trending pools seed. */
  geckoMax: z.coerce.number().int().min(0).max(80).default(25),
  geckoCacheMs: z.coerce.number().int().min(30_000).max(600_000).default(120_000),
  geckoPages: z.coerce.number().int().min(1).max(2).default(1),
  /**
   * Deep knife (−50, −20]: wait, then buy only on stabilize / controlled bounce.
   * Ecosystem enables for live mild-dip-bot.
   */
  knifeStabilizeEnabled: z.boolean().default(false),
  knifeStabilizeMinDipPct: z.coerce.number().max(0).default(-50),
  knifeStabilizeMaxDipPct: z.coerce.number().max(0).default(-20),
  knifeStabilizeWaitMs: z.coerce.number().int().min(0).max(3_600_000).default(120_000),
  knifeStabilizeMaxWatchMs: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  knifeStabilizeQuietMs: z.coerce.number().int().min(0).max(600_000).default(45_000),
  knifeStabilizeBandPct: z.coerce.number().min(0).max(50).default(2.5),
  knifeStabilizeMinBouncePct: z.coerce.number().min(0).max(50).default(1.5),
  knifeStabilizeMaxBouncePct: z.coerce.number().min(0).max(50).default(10),
  /**
   * 1.11.753 — park signal; buy only after extra dump from signal.
   * 1.11.762 — default −10%; main-band only (stabilize buys immediate).
   * 0 waitDipPct = off shape.
   */
  waitDipEnabled: z.boolean().default(true),
  waitDipPct: z.coerce.number().max(0).default(-10),
  waitDipMaxWatchMs: z.coerce.number().int().min(30_000).max(3_600_000).default(1_200_000),
  /**
   * 1.11.753 — after ready, allow at most this many pp of dump edge to erode
   * before abort (wait −7% + overshoot 2 → fill/quote must stay ≤ −5% vs signal).
   */
  waitDipMaxOvershootPct: z.coerce.number().min(0).max(20).default(2),
  /** Chase vs ready mark only (not vs park signal). */
  waitDipMaxChasePct: z.coerce.number().min(0).max(20).default(3),
  /** Jupiter quote premium above signal ceiling (must be >0 so live guard runs). */
  waitDipQuotePremiumPct: z.coerce.number().min(0.1).max(10).default(1),
  /**
   * Leader-style bounce clip: dump from ring peak then buy reclaim off trough.
   * Additive to main-band / deep-knife. Second-clip scale-in removed (1.11.730).
   */
  mildStabilizeEnabled: z.boolean().default(false),
  /**
   * When false (default): no fresh mild_stabilize seats
   * (Gymbmn/7rMnp9 green-candle noise).
   */
  mildStabilizeFreshEntryEnabled: z.boolean().default(false),
  mildStabilizeMinDumpPct: z.coerce.number().max(0).default(-25),
  /** Shallowest dump allowed (more negative = require deeper). Was −5. */
  mildStabilizeMaxDumpPct: z.coerce.number().max(0).default(-8),
  mildStabilizeMinBouncePct: z.coerce.number().min(0).max(50).default(1.5),
  mildStabilizeMaxBouncePct: z.coerce.number().min(0).max(50).default(8),
  mildStabilizeTroughMinAgeMs: z.coerce.number().int().min(0).max(600_000).default(15_000),
  /** Last must stay ≥ this % below local peak (0 = off). */
  mildStabilizeMinBelowPeakPct: z.coerce.number().min(0).max(50).default(2),
  /**
   * Autonomous red-hour shallow: when 1h ≤ h1Max and pc5m ∈ (min,max],
   * enter without the main mild band (own logic — not leader copy).
   */
  h1RedShallowEnabled: z.boolean().default(false),
  h1RedShallowH1MaxPct: z.coerce.number().max(0).default(-15),
  h1RedShallowMinDipPct: z.coerce.number().default(-10),
  h1RedShallowMaxDipPct: z.coerce.number().max(0).default(-3),
  /**
   * Flat/chop micro-dip: pc5m ∈ (min,max] while pc1h ∈ [h1Min,h1Max].
   * Own logic (not leader copy) — small scrapes leaders take on range names.
   */
  flatMicroDipEnabled: z.boolean().default(false),
  flatMicroMinDipPct: z.coerce.number().default(-5),
  flatMicroMaxDipPct: z.coerce.number().max(0).default(-1.5),
  /** 1h floor — reject fresh nukes (pc1h worse than this). */
  flatMicroH1MinPct: z.coerce.number().default(-35),
  /** 1h ceiling — reject strong green hours. */
  flatMicroH1MaxPct: z.coerce.number().default(10),
  /** Helius/RPC logsSubscribe on pump programs → hot mint universe. */
  streamEnabled: z.boolean().default(true),
  streamWsUrl: z.string().optional(),
  /** Hard skip — stables / junk mints (comma-separated env). */
  deniedMints: z.array(z.string()).default([]),
  /**
   * Fresh DexScreener check immediately before send — skip if pc5m left the
   * band or price bounced above the signal by more than maxChasePct.
   */
  preBuyRevalidate: z.boolean().default(true),
  /** Max % mark can rise vs signal price before abort (0 = chase check off). */
  maxChasePct: z.coerce.number().min(0).max(50).default(10),
  /**
   * Stream/leader fast-path: skip the Dex enrich batch; one structural fetch +
   * stream drawdown → Jupiter. Default ON.
   */
  fastPathEnabled: z.boolean().default(true),
  /** Chase allowance on fast-path (latency-tolerant). */
  fastPathChasePct: z.coerce.number().min(0).max(50).default(12),
  /** Skip cooldown-bounce guard on fast-path (0 = use maxCooldownBouncePct). */
  fastPathSkipBounce: z.boolean().default(true),
  /** Min gap between fast-path attempts per mint. */
  fastPathMinGapMs: z.coerce.number().int().min(0).max(120_000).default(2_000),
  /**
   * When stream trigger has no local drawdown yet, still Dex-probe hot mints
   * (restores autonomous discovery vs leader-only wake). 0 gap / 0 max = off.
   */
  fastPathHotDexProbeEnabled: z.boolean().default(true),
  fastPathHotDexProbeGapMs: z.coerce.number().int().min(0).max(120_000).default(10_000),
  fastPathHotDexProbeMaxPerMin: z.coerce.number().int().min(0).max(120).default(40),
  /**
   * Soft cooldown after a failed fast-path buy (impact/sim/etc).
   * Default 0 — 15s was burning the dump while price ran +10%.
   * Does NOT touch Helius WS; only gates Jupiter/Dex retries.
   */
  fastPathSoftSkipCooldownMs: z.coerce.number().int().min(0).max(120_000).default(0),
  /**
   * Stream-only main-band entries must be at least this deep (more negative).
   * Blocks −5% ring wiggles (Gs2Liw). Dex+stream / Dex-only use entry band.
   */
  streamOnlyMaxDipPct: z.coerce.number().max(0).default(-10),
  /**
   * When true (live default): stream-only also needs Dex pc5m ≤ dexMaxDipPct.
   * JBKWfC 07:47 — ring −21% / Dex ≈0 after reclaim; leaders sat out.
   */
  streamOnlyRequireDexDip: z.boolean().default(true),
  /** Dex ceiling for stream-only (e.g. −8 = still a dump on Dex tape). */
  streamOnlyDexMaxDipPct: z.coerce.number().max(0).default(-8),
  /** Reuse structural Dex metrics this long (ms). */
  fastPathStructuralCacheMs: z.coerce.number().int().min(1_000).max(120_000).default(8_000),
  /** Background enrich size (slow lane). Keep small — fast-path owns entries. */
  enrichMax: z.coerce.number().int().min(5).max(80).default(12),
  entry: z.object({
    minDipPct: z.number(),
    maxDipPct: z.number(),
    minVolume5mUsd: z.number(),
    minLiquidityUsd: z.number(),
    minMarketCapUsd: z.number(),
    maxMarketCapUsd: z.number(),
    minPairAgeHours: z.number(),
    maxPairAgeHours: z.number(),
    allowedDexIds: z.array(z.string()),
  }),
  exit: z.object({
    /** W9.1: arm when MFE ≥ armPct. */
    armPct: z.number(),
    /** Armed: sell scaleOutFraction at this giveback % (0=off). */
    partialGivebackPct: z.coerce.number().min(0).max(100).default(3),
    /** Fraction sold on partial giveback (default 0.5). */
    scaleOutFraction: z.coerce.number().min(0).max(1).default(0.5),
    /** W9.1: full exit when giveback from peak ≤ −givebackPct. */
    givebackPct: z.number(),
    /**
     * 1.11.750 — MFE bank + runner sleeve (default on).
     * When on, classic armed −3%/−8% giveback scale-out is skipped.
     */
    mfeBankEnabled: z.boolean().default(true),
    mfeBank1Pct: z.coerce.number().min(0).max(500).default(8),
    mfeBank1Fraction: z.coerce.number().min(0).max(1).default(0.4),
    mfeBank2Pct: z.coerce.number().min(0).max(500).default(15),
    mfeBank2Fraction: z.coerce.number().min(0).max(1).default(0.4),
    mfeBankSleeveGivebackPct: z.coerce.number().min(0).max(100).default(12),
    /**
     * 1.11.759 — underwater sleeve: sell this fraction first (0 = full legacy).
     */
    mfeBankSleeveLossPartialFraction: z.coerce.number().min(0).max(1).default(0.5),
    /** Never-armed soft giveback after this many ms (0=off). Default off. */
    neverArmPatienceMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
    /** Never-armed: force exit after this many ms (0=off). Hard ceiling. */
    neverArmMaxHoldMs: z.coerce.number().int().min(0).max(86_400_000).default(2_400_000),
    /** Never-armed deep-loss cut min hold (0=off). Default 15m. */
    /** 1.11.728 — default 30m (was 15m). */
    neverArmDeadMinMs: z.coerce.number().int().min(0).max(86_400_000).default(1_800_000),
    /** Never-armed deep-loss cut: exit if pnl ≤ −this % (0=off). Default 10. */
    neverArmDeadPnlPct: z.coerce.number().min(0).max(100).default(10),
    /**
     * Never-armed stale: min hold before stagnation cut (0=off). Default 20m.
     * If MFE ≤ maxMfe and pnl ≤ −stalePnl → exit (`never_arm_stale`).
     * 1.11.733 — was 10m (BV5wre full exit at ~11m / MFE 0).
     */
    neverArmStaleMinMs: z.coerce.number().int().min(0).max(86_400_000).default(1_200_000),
    neverArmStaleMaxMfePct: z.coerce.number().min(0).max(100).default(2),
    neverArmStalePnlPct: z.coerce.number().min(0).max(100).default(5),
    /** Never-armed sustained fade: min hold before checks (0=off). Default 15m. */
    neverArmVolFadeMinMs: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
    /** A 5m window is weak if vol ≤ ratio × entry (0=off). Default 0.25. */
    neverArmVolFadeRatio: z.coerce.number().min(0).max(10).default(0.25),
    /** A 5m window is weak if vol ≤ this USD floor (0=off). Default 300. */
    neverArmVolFadeFloorUsd: z.coerce.number().min(0).default(300),
    /** Min spacing between vol samples (distinct Dex m5 windows). Default 5m. */
    neverArmVolFadeSampleMs: z.coerce.number().int().min(0).max(86_400_000).default(300_000),
    /** Consecutive weak windows required before exit. Default 3. */
    neverArmVolFadeWeakWindows: z.coerce.number().int().min(0).max(48).default(3),
    /** Instant rug / LP-pull cut when pnl ≤ −this % (0=off). Default 50. */
    cliffDumpPnlPct: z.coerce.number().min(0).max(100).default(50),
    /**
     * 1.11.747 — never-arm bounce reclaim (sell into bounce off post-entry trough).
     * 0 bouncePct = off.
     */
    neverArmBounceMinDumpPct: z.coerce.number().min(0).max(100).default(8),
    neverArmBouncePct: z.coerce.number().min(0).max(100).default(8),
    neverArmBounceMinTroughAgeMs: z.coerce
      .number()
      .int()
      .min(0)
      .max(3_600_000)
      .default(60_000),
    neverArmBounceRequireRedPct: z.coerce.number().min(0).max(100).default(3),
    /** 1.11.759 — first bounce cut (0.5); 0 = full on first bounce. */
    neverArmBouncePartialFraction: z.coerce.number().min(0).max(1).default(0.5),
    /** 1.11.759 — second bounce for runner (default 16). */
    neverArmBounce2Pct: z.coerce.number().min(0).max(100).default(16),
    /** Never-arm freefall floor (no bounce). 0 = off. */
    neverArmFreefallPnlPct: z.coerce.number().min(0).max(100).default(25),
    neverArmFreefallMinMs: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
    /**
     * 1.11.755 — never-arm time-red: min hold then exit if still ≤ −pnl%.
     * Live option-2 default 15m / −5%. 0 min = off.
     */
    neverArmTimeRedMinMs: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
    neverArmTimeRedPnlPct: z.coerce.number().min(0).max(100).default(5),
  }),
});

export type MildDipConfig = z.infer<typeof MildDipConfigSchema>;

export function loadMildDipConfig(): MildDipConfig {
  const rpcUrl =
    process.env.MILD_DIP_RPC_URL?.trim() ||
    process.env.COPY_TRADER_RPC_URL?.trim() ||
    liveOscarRpcHttpUrlFromEnv() ||
    resolveSolanaRpcUrl() ||
    '';

  const allowedDexRaw = (process.env.MILD_DIP_ALLOWED_DEX_IDS ?? 'pumpswap,pumpfun,raydium').trim();
  const allowedDexIds = allowedDexRaw
    ? allowedDexRaw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

  const entry: MildDipEntryGates = {
    /** 1.11.702 — wider knife floor (default −25 ⇒ pc5m > −25%). */
    minDipPct: envNum('MILD_DIP_MIN_DIP_PCT', -25),
    /** Inclusive upper bound — require dump depth (default −8 ⇒ pc5m ≤ −8%). */
    maxDipPct: envNum('MILD_DIP_MAX_DIP_PCT', -8),
    /** 1.11.735 — default $500 (was $1500). Dex 5m volume floor before buy. */
    minVolume5mUsd: envNum('MILD_DIP_MIN_VOLUME_5M_USD', 500),
    /** 1.11.700 — default $10k (canary $40k was too tight for mild dips). */
    minLiquidityUsd: envNum('MILD_DIP_MIN_LIQUIDITY_USD', 10_000),
    /**
     * Global entry floor ($50k). Knife+micro may arm down to
     * MILD_DIP_MICRO_MIN_MCAP_USD (see knifeStabilizeMinMarketCapUsd).
     */
    minMarketCapUsd: envNum('MILD_DIP_MIN_MCAP_USD', 50_000),
    maxMarketCapUsd: envNum('MILD_DIP_MAX_MCAP_USD', 300_000_000),
    /** 1.11.724 — floor 30m (was 15m). Youngest bucket had worst cliffs. */
    minPairAgeHours: envNum('MILD_DIP_MIN_PAIR_AGE_HOURS', 0.5),
    /** 0 = no max age cap (older pump names like CATE still eligible). */
    maxPairAgeHours: envNum('MILD_DIP_MAX_PAIR_AGE_HOURS', 0),
    allowedDexIds,
  };

  /** Built-in junk/stables + optional env extras. */
  const defaultDenied = [
    '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'So11111111111111111111111111111111111111112', // WSOL
  ];
  const deniedExtra = (process.env.MILD_DIP_DENIED_MINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= 32);
  const deniedMints = [...new Set([...defaultDenied, ...deniedExtra])];

  /**
   * W9.1 peak-giveback + never-armed finite exits (no infinite hold).
   * No SL% from entry / hard TP on the armed path.
   */
  const exit: MildDipExitGates = {
    /** 1.11.699 — arm earlier so NV2RYH-style +5.5% MFE is not invisible. */
    armPct: envNum('MILD_DIP_EXIT_ARM_PCT', 5),
    /** Scale-out half at −3% from peak; full remainder at givebackPct. */
    partialGivebackPct: envNum('MILD_DIP_EXIT_PARTIAL_GIVEBACK_PCT', 3),
    scaleOutFraction: envNum('MILD_DIP_EXIT_SCALE_OUT_FRACTION', 0.5),
    givebackPct: envNum('MILD_DIP_EXIT_GIVEBACK_PCT', 8),
    /**
     * 1.11.750 — bank +8%×40% / +15%×40%, sleeve 20% trails −12% from peak.
     * Set MILD_DIP_EXIT_MFE_BANK=0 to restore classic −3%/−8% giveback trail.
     */
    mfeBankEnabled: envBool('MILD_DIP_EXIT_MFE_BANK', true),
    mfeBank1Pct: envNum('MILD_DIP_EXIT_MFE_BANK1_PCT', 8),
    mfeBank1Fraction: envNum('MILD_DIP_EXIT_MFE_BANK1_FRACTION', 0.4),
    mfeBank2Pct: envNum('MILD_DIP_EXIT_MFE_BANK2_PCT', 15),
    mfeBank2Fraction: envNum('MILD_DIP_EXIT_MFE_BANK2_FRACTION', 0.4),
    mfeBankSleeveGivebackPct: envNum('MILD_DIP_EXIT_MFE_BANK_SLEEVE_GIVEBACK_PCT', 12),
    mfeBankSleeveLossPartialFraction: envNum(
      'MILD_DIP_EXIT_MFE_BANK_SLEEVE_LOSS_PARTIAL_FRACTION',
      0.5,
    ),
    /** 0 = disable never_arm_giveback (early −6% cuts were the grind loss). */
    neverArmPatienceMs: envNum('MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS', 0),
    neverArmMaxHoldMs: envNum('MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS', 2_400_000),
    /** Deep-loss cut before max-hold (rugs); not the early 5m knife. */
    neverArmDeadMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS', 1_800_000),
    /** 1.11.706 — align with leader loser med (~−10%), was 15. */
    neverArmDeadPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT', 10),
    /**
     * 1.11.706 — stagnation: 10m unarmed + MFE≤2% + pnl≤−5% → never_arm_stale.
     * Dead-path names flatten early; don't wait for −10/−15.
     */
    neverArmStaleMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS', 1_200_000),
    neverArmStaleMaxMfePct: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_MAX_MFE_PCT', 2),
    neverArmStalePnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_PNL_PCT', 5),
    /**
     * Sustained activity fade — leave only after N consecutive weak 5m windows.
     * One-shot Dex dips (Gymbmn) must not sell.
     */
    neverArmVolFadeMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS', 900_000),
    neverArmVolFadeRatio: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_RATIO', 0.25),
    neverArmVolFadeFloorUsd: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD', 300),
    neverArmVolFadeSampleMs: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_SAMPLE_MS', 300_000),
    neverArmVolFadeWeakWindows: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_WEAK_WINDOWS', 3),
    /** 1.11.697 — LP-pull cliff: exit immediately at ≤ −50% mark pnl. */
    cliffDumpPnlPct: envNum('MILD_DIP_EXIT_CLIFF_DUMP_PNL_PCT', 50),
    /**
     * 1.11.751 — never-arm bounce hardened vs stream-wick churn (F1XdRe/AENK1Y):
     * trough ≤ −8%, bounce ≥ 8%, trough age ≥ 60s, still red ≤ −3% vs entry.
     * Freefall floor −25% if no bounce ever prints.
     */
    neverArmBounceMinDumpPct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_DUMP_PCT', 8),
    neverArmBouncePct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PCT', 8),
    neverArmBounceMinTroughAgeMs: envNum(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_TROUGH_AGE_MS',
      60_000,
    ),
    neverArmBounceRequireRedPct: envNum(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_REQUIRE_RED_PCT',
      3,
    ),
    neverArmBouncePartialFraction: envNum(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PARTIAL_FRACTION',
      0.5,
    ),
    neverArmBounce2Pct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_2_PCT', 16),
    neverArmFreefallPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_FREEFALL_PNL_PCT', 25),
    neverArmFreefallMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_FREEFALL_MIN_MS', 60_000),
    /**
     * 1.11.755 — option-2 never-arm: bounce + time-red 15m/−5%.
     * Ecosystem zeros freefall/stale/dead/vol_fade/max_hold.
     */
    neverArmTimeRedMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_TIME_RED_MIN_MS', 900_000),
    neverArmTimeRedPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_TIME_RED_PNL_PCT', 5),
  };

  const raw = {
    executionMode: (process.env.MILD_DIP_EXECUTION_MODE?.trim() || 'live') as string,
    rpcUrl,
    walletSecret: process.env.MILD_DIP_WALLET_SECRET?.trim() || undefined,
    walletPubkeyExpected: process.env.MILD_DIP_WALLET_PUBKEY?.trim() || undefined,
    journalPath:
      process.env.MILD_DIP_JOURNAL_PATH?.trim() || path.join('data', 'milddip', 'journal.jsonl'),
    statePath: process.env.MILD_DIP_STATE_PATH?.trim() || path.join('data', 'milddip', 'state.json'),
    positionUsd: process.env.MILD_DIP_POSITION_USD ?? 5,
    thickPositionUsd: process.env.MILD_DIP_THICK_POSITION_USD ?? 5,
    thickMinMarketCapUsd: process.env.MILD_DIP_THICK_MIN_MCAP_USD ?? 100_000,
    thickMinLiquidityUsd: process.env.MILD_DIP_THICK_MIN_LIQUIDITY_USD ?? 50_000,
    thickMinPairAgeHours: process.env.MILD_DIP_THICK_MIN_PAIR_AGE_HOURS ?? 6,
    /** 1.11.754 — $30 live; knife_stabilize only (see mildDipMicroSizeGatesForSource). */
    microPositionUsd: process.env.MILD_DIP_MICRO_POSITION_USD ?? 5,
    microMinMarketCapUsd: process.env.MILD_DIP_MICRO_MIN_MCAP_USD ?? 15_000,
    microMaxMarketCapUsd: process.env.MILD_DIP_MICRO_MAX_MCAP_USD ?? 50_000,
    maxOpenPositions: process.env.MILD_DIP_MAX_OPEN_POSITIONS ?? 0,
    scanIntervalMs: process.env.MILD_DIP_SCAN_INTERVAL_MS ?? 5_000,
    markIntervalMs: process.env.MILD_DIP_MARK_INTERVAL_MS ?? 2_000,
    markStreamMaxAgeMs: process.env.MILD_DIP_MARK_STREAM_MAX_AGE_MS ?? 5_000,
    markDexRefreshMs: process.env.MILD_DIP_MARK_DEX_REFRESH_MS ?? 15_000,
    markCacheTtlMs: process.env.MILD_DIP_MARK_CACHE_TTL_MS ?? 2_000,
    /** 1.11.736 — tighter journal so giveback gaps are visible (was 30s). */
    markJournalMs: process.env.MILD_DIP_MARK_JOURNAL_MS ?? 5_000,
    markConcurrency: process.env.MILD_DIP_MARK_CONCURRENCY ?? 48,
    enrichConcurrency: process.env.MILD_DIP_ENRICH_CONCURRENCY ?? 12,
    sellConcurrency: process.env.MILD_DIP_SELL_CONCURRENCY ?? 6,
    loadAlertEnabled: (() => {
      const v = process.env.MILD_DIP_LOAD_ALERT?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    loadAlertMarkPassMs: process.env.MILD_DIP_LOAD_ALERT_MARK_PASS_MS ?? 20_000,
    loadAlertOpenCount: process.env.MILD_DIP_LOAD_ALERT_OPEN_COUNT ?? 50,
    loadAlertNullRatio: process.env.MILD_DIP_LOAD_ALERT_NULL_RATIO ?? 0.4,
    loadAlertCooldownMs: process.env.MILD_DIP_LOAD_ALERT_COOLDOWN_MS ?? 1_800_000,
    mintCooldownMs: process.env.MILD_DIP_MINT_COOLDOWN_MS ?? 60_000,
    lossCooldownMs: process.env.MILD_DIP_LOSS_COOLDOWN_MS ?? 60_000,
    slippageBps: process.env.MILD_DIP_SLIPPAGE_BPS ?? 150,
    minFeeSolReserve: process.env.MILD_DIP_MIN_FEE_SOL_RESERVE ?? 0.02,
    feeSolTopupEnabled: (() => {
      const v = process.env.MILD_DIP_FEE_SOL_TOPUP?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    feeSolTopupIntervalMs: process.env.MILD_DIP_FEE_SOL_TOPUP_INTERVAL_MS ?? 1_800_000,
    feeSolTopupMinUsd: process.env.MILD_DIP_FEE_SOL_TOPUP_MIN_USD ?? 5,
    feeSolTopupBuyUsd: process.env.MILD_DIP_FEE_SOL_TOPUP_BUY_USD ?? 20,
    discoverSources: process.env.MILD_DIP_DISCOVER_SOURCES ?? 'stream,boosts,profiles',
    seedMintsPath: process.env.MILD_DIP_SEED_MINTS_PATH?.trim() || undefined,
    leaderSeedPath:
      process.env.MILD_DIP_LEADER_SEED_PATH?.trim() ||
      path.join('data', 'milddip', 'leader-seed.json'),
    leaderSeedMaxAgeMs: process.env.MILD_DIP_LEADER_SEED_MAX_AGE_MS ?? 7_200_000,
    leaderSeedMax: process.env.MILD_DIP_LEADER_SEED_MAX ?? 40,
    pgVolumeMax: process.env.MILD_DIP_PG_VOLUME_MAX ?? 30,
    pgVolumeCacheMs: process.env.MILD_DIP_PG_VOLUME_CACHE_MS ?? 60_000,
    pgVolumeLookbackMin: process.env.MILD_DIP_PG_VOLUME_LOOKBACK_MIN ?? 10,
    geckoMax: process.env.MILD_DIP_GECKO_MAX ?? 25,
    geckoCacheMs: process.env.MILD_DIP_GECKO_CACHE_MS ?? 120_000,
    geckoPages: process.env.MILD_DIP_GECKO_PAGES ?? 1,
    knifeStabilizeEnabled: envBool('MILD_DIP_KNIFE_STABILIZE_ENABLED', false),
    knifeStabilizeMinDipPct: envNum('MILD_DIP_KNIFE_STABILIZE_MIN_DIP_PCT', -50),
    knifeStabilizeMaxDipPct: envNum('MILD_DIP_KNIFE_STABILIZE_MAX_DIP_PCT', -20),
    knifeStabilizeWaitMs: envNum('MILD_DIP_KNIFE_STABILIZE_WAIT_MS', 120_000),
    knifeStabilizeMaxWatchMs: envNum('MILD_DIP_KNIFE_STABILIZE_MAX_WATCH_MS', 600_000),
    knifeStabilizeQuietMs: envNum('MILD_DIP_KNIFE_STABILIZE_QUIET_MS', 45_000),
    knifeStabilizeBandPct: envNum('MILD_DIP_KNIFE_STABILIZE_BAND_PCT', 2.5),
    knifeStabilizeMinBouncePct: envNum('MILD_DIP_KNIFE_STABILIZE_MIN_BOUNCE_PCT', 1.5),
    knifeStabilizeMaxBouncePct: envNum('MILD_DIP_KNIFE_STABILIZE_MAX_BOUNCE_PCT', 10),
    /**
     * 1.11.752 — wait extra −7% from signal before buy (MFE-bank CF winner).
     * Set MILD_DIP_WAIT_DIP=0 to restore immediate entries (all branches).
     */
    waitDipEnabled: envBool('MILD_DIP_WAIT_DIP', true),
    waitDipPct: envNum('MILD_DIP_WAIT_DIP_PCT', -10),
    waitDipMaxWatchMs: envNum('MILD_DIP_WAIT_DIP_MAX_WATCH_MS', 1_200_000),
    waitDipMaxOvershootPct: envNum('MILD_DIP_WAIT_DIP_MAX_OVERSHOOT_PCT', 2),
    waitDipMaxChasePct: envNum('MILD_DIP_WAIT_DIP_MAX_CHASE_PCT', 3),
    waitDipQuotePremiumPct: envNum('MILD_DIP_WAIT_DIP_QUOTE_PREMIUM_PCT', 1),
    mildStabilizeEnabled: envBool('MILD_DIP_MILD_STABILIZE_ENABLED', false),
    mildStabilizeFreshEntryEnabled: envBool('MILD_DIP_MILD_STABILIZE_FRESH_ENTRY', false),
    mildStabilizeMinDumpPct: envNum('MILD_DIP_MILD_STABILIZE_MIN_DUMP_PCT', -25),
    mildStabilizeMaxDumpPct: envNum('MILD_DIP_MILD_STABILIZE_MAX_DUMP_PCT', -8),
    mildStabilizeMinBouncePct: envNum('MILD_DIP_MILD_STABILIZE_MIN_BOUNCE_PCT', 1.5),
    mildStabilizeMaxBouncePct: envNum('MILD_DIP_MILD_STABILIZE_MAX_BOUNCE_PCT', 8),
    mildStabilizeTroughMinAgeMs: envNum('MILD_DIP_MILD_STABILIZE_TROUGH_MIN_AGE_MS', 15_000),
    mildStabilizeMinBelowPeakPct: envNum('MILD_DIP_MILD_STABILIZE_MIN_BELOW_PEAK_PCT', 2),
    h1RedShallowEnabled: envBool('MILD_DIP_H1_RED_SHALLOW_ENABLED', false),
    h1RedShallowH1MaxPct: envNum('MILD_DIP_H1_RED_SHALLOW_H1_MAX_PCT', -15),
    h1RedShallowMinDipPct: envNum('MILD_DIP_H1_RED_SHALLOW_MIN_DIP_PCT', -10),
    h1RedShallowMaxDipPct: envNum('MILD_DIP_H1_RED_SHALLOW_MAX_DIP_PCT', -3),
    flatMicroDipEnabled: envBool('MILD_DIP_FLAT_MICRO_ENABLED', false),
    flatMicroMinDipPct: envNum('MILD_DIP_FLAT_MICRO_MIN_DIP_PCT', -5),
    flatMicroMaxDipPct: envNum('MILD_DIP_FLAT_MICRO_MAX_DIP_PCT', -1.5),
    flatMicroH1MinPct: envNum('MILD_DIP_FLAT_MICRO_H1_MIN_PCT', -35),
    flatMicroH1MaxPct: envNum('MILD_DIP_FLAT_MICRO_H1_MAX_PCT', 10),
    streamEnabled: (() => {
      const v = process.env.MILD_DIP_STREAM?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    streamWsUrl: process.env.MILD_DIP_STREAM_WS_URL?.trim() || undefined,
    deniedMints,
    preBuyRevalidate: (() => {
      const v = process.env.MILD_DIP_PREBUY_REVALIDATE?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    maxChasePct: process.env.MILD_DIP_MAX_CHASE_PCT ?? 10,
    fastPathEnabled: envBool('MILD_DIP_FAST_PATH', true),
    fastPathChasePct: process.env.MILD_DIP_FAST_PATH_CHASE_PCT ?? 12,
    fastPathSkipBounce: envBool('MILD_DIP_FAST_PATH_SKIP_BOUNCE', true),
    fastPathMinGapMs: process.env.MILD_DIP_FAST_PATH_MIN_GAP_MS ?? 2_000,
    /** Stream-hot Dex probe when ring has no dd yet (Agmu8X-class). */
    fastPathHotDexProbeEnabled: envBool('MILD_DIP_FAST_PATH_HOT_DEX_PROBE_ENABLED', true),
    fastPathHotDexProbeGapMs: process.env.MILD_DIP_FAST_PATH_HOT_DEX_PROBE_GAP_MS ?? 10_000,
    fastPathHotDexProbeMaxPerMin: process.env.MILD_DIP_FAST_PATH_HOT_DEX_PROBE_MAX_PER_MIN ?? 40,
    fastPathSoftSkipCooldownMs: process.env.MILD_DIP_FAST_PATH_SOFT_SKIP_MS ?? 0,
    streamOnlyMaxDipPct: process.env.MILD_DIP_STREAM_ONLY_MAX_DIP_PCT ?? -10,
    streamOnlyRequireDexDip: envBool('MILD_DIP_STREAM_ONLY_REQUIRE_DEX_DIP', true),
    streamOnlyDexMaxDipPct: process.env.MILD_DIP_STREAM_ONLY_DEX_MAX_DIP_PCT ?? -8,
    fastPathStructuralCacheMs: process.env.MILD_DIP_FAST_PATH_STRUCTURAL_CACHE_MS ?? 8_000,
    enrichMax: process.env.MILD_DIP_ENRICH_MAX ?? 12,
    maxCooldownBouncePct: process.env.MILD_DIP_MAX_COOLDOWN_BOUNCE_PCT ?? 6,
    rebuyBelowExitPct: process.env.MILD_DIP_REBUY_BELOW_EXIT_PCT ?? 10,
    rebuyBelowExitMaxAgeMs: process.env.MILD_DIP_REBUY_BELOW_EXIT_MAX_AGE_MS ?? 900_000,
    cooldownBounceLookbackMs: process.env.MILD_DIP_COOLDOWN_BOUNCE_LOOKBACK_MS ?? 300_000,
    streamDipEntryEnabled: (() => {
      const v = process.env.MILD_DIP_STREAM_DIP_ENTRY?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    streamPriceSampleEnabled: (() => {
      const v = process.env.MILD_DIP_STREAM_PRICE_SAMPLE?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    streamPriceMinGapMs: process.env.MILD_DIP_STREAM_PRICE_MIN_GAP_MS ?? 500,
    streamPriceConcurrency: process.env.MILD_DIP_STREAM_PRICE_CONCURRENCY ?? 6,
    /** 1.11.734 — oneshot emptied-bag dump grace on peak_giveback. */
    oneshotDumpGraceEnabled: envBool('MILD_DIP_ONESHOT_DUMP_GRACE', true),
    oneshotDumpGraceMs: process.env.MILD_DIP_ONESHOT_DUMP_GRACE_MS ?? 60_000,
    oneshotDumpMinSellUsd: process.env.MILD_DIP_ONESHOT_DUMP_MIN_SELL_USD ?? 500,
    oneshotDumpMaxPostResidualFrac:
      process.env.MILD_DIP_ONESHOT_DUMP_MAX_POST_RESIDUAL_FRAC ?? 0.02,
    /** 1.11.740 — classify whale vs mass flee before soft giveback. */
    dumpClassifyEnabled: envBool('MILD_DIP_DUMP_CLASSIFY', true),
    dumpClassifyWindowMs: process.env.MILD_DIP_DUMP_CLASSIFY_WINDOW_MS ?? 30_000,
    dumpClassifyWaitMs: process.env.MILD_DIP_DUMP_CLASSIFY_WAIT_MS ?? 5_000,
    dumpClassifyMassMinSellers: process.env.MILD_DIP_DUMP_CLASSIFY_MASS_MIN_SELLERS ?? 3,
    dumpClassifyWhaleShare: process.env.MILD_DIP_DUMP_CLASSIFY_WHALE_SHARE ?? 0.6,
    /** 1.11.744 — defer soft exits while reclaiming off local trough. */
    /** 1.11.749 — default off; dump_classify owns soft-giveback gating. */
    recoverDeferEnabled: envBool('MILD_DIP_RECOVER_DEFER', false),
    recoverDeferLookbackMs: process.env.MILD_DIP_RECOVER_DEFER_LOOKBACK_MS ?? 300_000,
    recoverDeferMinBouncePct: process.env.MILD_DIP_RECOVER_DEFER_MIN_BOUNCE_PCT ?? 3,
    /** 1.11.761 — leader-align defer + one-shot average-in near soft exit. */
    leaderAlignEnabled: envBool('MILD_DIP_LEADER_ALIGN', true),
    leaderAlignMaxAgeMs: process.env.MILD_DIP_LEADER_ALIGN_MAX_AGE_MS ?? 120_000,
    leaderAlignRequireRedPct: process.env.MILD_DIP_LEADER_ALIGN_REQUIRE_RED_PCT ?? 3,
    leaderAlignMinBelowEntryPct: process.env.MILD_DIP_LEADER_ALIGN_MIN_BELOW_ENTRY_PCT ?? 0,
    leaderAlignRequireAdd: envBool('MILD_DIP_LEADER_ALIGN_REQUIRE_ADD', false),
    leaderAlignScaleInEnabled: envBool('MILD_DIP_LEADER_ALIGN_SCALE_IN', true),
    leaderAlignScaleInUsd: process.env.MILD_DIP_LEADER_ALIGN_SCALE_IN_USD ?? 15,
    hotMintsPath:
      process.env.MILD_DIP_HOT_MINTS_PATH?.trim() || path.join('data', 'milddip', 'hot-mints.json'),
    priceRingPath:
      process.env.MILD_DIP_PRICE_RING_PATH?.trim() || path.join('data', 'milddip', 'price-ring.json'),
    entry,
    exit,
  };

  const parsed = MildDipConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`mild-dip config invalid: ${msg}`);
  }

  if (parsed.data.executionMode === 'live' && !parsed.data.walletSecret) {
    throw new Error('mild-dip live mode requires MILD_DIP_WALLET_SECRET');
  }
  if (!parsed.data.rpcUrl) {
    throw new Error('mild-dip requires MILD_DIP_RPC_URL / COPY_TRADER_RPC_URL / SA_RPC_HTTP_URL');
  }
  if (!(parsed.data.entry.minDipPct < parsed.data.entry.maxDipPct)) {
    throw new Error('mild-dip requires MILD_DIP_MIN_DIP_PCT < MILD_DIP_MAX_DIP_PCT');
  }
  if (
    parsed.data.knifeStabilizeEnabled &&
    !(parsed.data.knifeStabilizeMinDipPct < parsed.data.knifeStabilizeMaxDipPct)
  ) {
    throw new Error(
      'mild-dip requires MILD_DIP_KNIFE_STABILIZE_MIN_DIP_PCT < MILD_DIP_KNIFE_STABILIZE_MAX_DIP_PCT',
    );
  }
  if (
    parsed.data.flatMicroDipEnabled &&
    !(parsed.data.flatMicroMinDipPct < parsed.data.flatMicroMaxDipPct)
  ) {
    throw new Error(
      'mild-dip requires MILD_DIP_FLAT_MICRO_MIN_DIP_PCT < MILD_DIP_FLAT_MICRO_MAX_DIP_PCT',
    );
  }
  if (
    parsed.data.mildStabilizeEnabled &&
    !(parsed.data.mildStabilizeMinDumpPct < parsed.data.mildStabilizeMaxDumpPct)
  ) {
    throw new Error(
      'mild-dip requires MILD_DIP_MILD_STABILIZE_MIN_DUMP_PCT < MILD_DIP_MILD_STABILIZE_MAX_DUMP_PCT',
    );
  }

  return parsed.data;
}
