/**
 * PR3 — persistent in-memory watchlist + optional JSON persistence for «Первый выстрел».
 * Phase machine: A (organic momentum) → B (surveillance) → C (cluster dump) → D (phantom re-ramp).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PervyyVystrelConfig } from './live-oscar-pervyy-vystrel-config.js';
import type { PervyyVystrelMintMaterialized } from './discovery/pervyy-vystrel-snapshot-cache.js';

/** Journal payloads emitted by watchlist ticks (merged upstream). */
export type PervyyVystrelWatchJournalEvent = Record<string, unknown> & {
  kind: string;
  mint: string;
};

/** Spec §3 Phase A → B peak threshold (default $400k). */
export const PHASE_A_PEAK_MCAP_USD = 400_000;
/** Spec §3 Phase B grace — peak already ≥ $300k allows vol dip. */
export const PHASE_B_PEAK_GRACE_MCAP_USD = 300_000;
/** Spec §3 Phase A min dwell before vol-sustain transition (4h). */
export const PHASE_A_MIN_DWELL_MS = 4 * 60 * 60 * 1000;
/** Spec §3 Phase D arm window max (180m). */
export const PHASE_D_ARM_WINDOW_MS = 180 * 60 * 1000;
/** Phase A tick throttle (15m/mint). */
export const PHASE_A_TICK_THROTTLE_MS = 15 * 60 * 1000;
/** Phase B surveillance tick cadence (1h). */
export const SURVEILLANCE_TICK_MS = 60 * 60 * 1000;
/** Retail dump cooldown (24h). */
export const RETAIL_DUMP_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type PervyyVystrelWatchPhase =
  | 'phase_a'
  | 'phase_b'
  | 'phase_c'
  | 'phase_d'
  | 'cooldown'
  | 'dropped';

export interface PervyyVystrelWatchState {
  mint: string;
  phase: PervyyVystrelWatchPhase;
  onboardedAtMs: number;
  lastTickMs: number;
  peakMcapUsd: number;
  peakPriceUsd: number;
  peakTsMs: number;
  bottomMcapUsd: number | null;
  dumpBottomTsMs: number | null;
  volAtDumpBottom: number | null;
  phaseAEnteredMs: number;
  phaseBEnteredMs: number | null;
  phaseCConfirmedMs: number | null;
  phaseDArmedMs: number | null;
  vol1hSustainSamples: number;
  lastPhaseATickMs: number;
  lastSurveillanceTickMs: number;
  cooldownUntilMs: number | null;
  holderCountAtOnboard: number | null;
  holderCountPrev: number | null;
  holderCount30mAgo: number | null;
  holder30mSnapshotMs: number | null;
  volGraceUntilMs: number | null;
  volAuthDecayStreak: number;
}

export interface PervyyVystrelWatchlistFile {
  savedAtMs: number;
  mints: Record<string, PervyyVystrelWatchState>;
}

export interface PervyyVystrelTickInput {
  mint: string;
  refMcapUsd: number;
  priceUsd: number;
  vol1hUsd: number;
  vol12hUsd?: number;
  holderCount?: number | null;
  buys5m?: number;
  sells5m?: number;
  materialized?: PervyyVystrelMintMaterialized | null;
  nowMs?: number;
}

export interface PervyyVystrelTickResult {
  state: PervyyVystrelWatchState;
  phaseChanged: boolean;
  journalEvents: PervyyVystrelWatchJournalEvent[];
  /** Internal — all D gates satisfied (PR3 still emits would_enter:false). */
  phantomGatesPass: boolean;
}

const watchByMint = new Map<string, PervyyVystrelWatchState>();

export function pervyyVystrelWatchlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PERVYY_VYSTREL_WATCHLIST_PATH?.trim() ||
    path.join('data', 'pervyy-vystrel', 'watchlist-state.json')
  );
}

export function getPervyyVystrelWatchState(mint: string): PervyyVystrelWatchState | undefined {
  return watchByMint.get(mint);
}

export function getPervyyVystrelWatchCount(): number {
  return watchByMint.size;
}

export function resetPervyyVystrelWatchlistForTests(): void {
  watchByMint.clear();
}

export function loadPervyyVystrelWatchlistFromDisk(env: NodeJS.ProcessEnv = process.env): void {
  const p = pervyyVystrelWatchlistPath(env);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as PervyyVystrelWatchlistFile;
    if (!parsed?.mints || typeof parsed.mints !== 'object') return;
    for (const [mint, state] of Object.entries(parsed.mints)) {
      if (state?.mint && state.phase) watchByMint.set(mint, state);
    }
  } catch {
    // missing file is normal on first boot
  }
}

export function persistPervyyVystrelWatchlist(env: NodeJS.ProcessEnv = process.env): void {
  const p = pervyyVystrelWatchlistPath(env);
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const file: PervyyVystrelWatchlistFile = {
    savedAtMs: Date.now(),
    mints: Object.fromEntries(watchByMint.entries()),
  };
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(file), 'utf8');
  fs.renameSync(tmp, p);
}

function dumpPctFromPeak(peak: number, now: number): number {
  if (peak <= 0) return 0;
  return ((peak - now) / peak) * 100;
}

function isDumpTriggered(peak: number, nowMcap: number, pv: PervyyVystrelConfig): boolean {
  if (peak <= 0 || nowMcap <= 0) return false;
  const pctDrop = dumpPctFromPeak(peak, nowMcap);
  if (pctDrop + 1e-9 >= pv.dumpMinPct) return true;
  if (nowMcap * pv.dumpMinMultiple <= peak + 1e-9) return true;
  return false;
}

function holderDelta30mPct(state: PervyyVystrelWatchState, holderNow: number | null | undefined): number | null {
  if (holderNow == null || state.holderCount30mAgo == null || state.holderCount30mAgo <= 0) return null;
  return ((holderNow - state.holderCount30mAgo) / state.holderCount30mAgo) * 100;
}

function updateHolderSnapshots(state: PervyyVystrelWatchState, holderNow: number | null | undefined, nowMs: number): void {
  if (holderNow == null || !Number.isFinite(holderNow)) return;
  if (state.holderCountPrev == null) {
    state.holderCountPrev = holderNow;
    state.holderCount30mAgo = holderNow;
    state.holder30mSnapshotMs = nowMs;
    return;
  }
  if (state.holder30mSnapshotMs == null || nowMs - state.holder30mSnapshotMs >= 30 * 60 * 1000) {
    state.holderCount30mAgo = state.holderCountPrev;
    state.holder30mSnapshotMs = nowMs;
  }
  state.holderCountPrev = holderNow;
}

export function onboardPervyyVystrelMint(args: {
  mint: string;
  refMcapUsd: number;
  priceUsd: number;
  holderCount?: number | null;
  nowMs?: number;
}): PervyyVystrelWatchState {
  const nowMs = args.nowMs ?? Date.now();
  const existing = watchByMint.get(args.mint);
  if (existing && existing.phase !== 'dropped') return existing;

  const state: PervyyVystrelWatchState = {
    mint: args.mint,
    phase: 'phase_a',
    onboardedAtMs: nowMs,
    lastTickMs: nowMs,
    peakMcapUsd: args.refMcapUsd,
    peakPriceUsd: args.priceUsd,
    peakTsMs: nowMs,
    bottomMcapUsd: null,
    dumpBottomTsMs: null,
    volAtDumpBottom: null,
    phaseAEnteredMs: nowMs,
    phaseBEnteredMs: null,
    phaseCConfirmedMs: null,
    phaseDArmedMs: null,
    vol1hSustainSamples: 0,
    lastPhaseATickMs: 0,
    lastSurveillanceTickMs: 0,
    cooldownUntilMs: null,
    holderCountAtOnboard: args.holderCount ?? null,
    holderCountPrev: args.holderCount ?? null,
    holderCount30mAgo: args.holderCount ?? null,
    holder30mSnapshotMs: args.holderCount != null ? nowMs : null,
    volGraceUntilMs: null,
    volAuthDecayStreak: 0,
  };
  watchByMint.set(args.mint, state);
  return state;
}

function evaluatePhaseDPhantomGates(args: {
  state: PervyyVystrelWatchState;
  refMcapUsd: number;
  vol1hUsd: number;
  buys5m: number;
  sells5m: number;
  materialized: PervyyVystrelMintMaterialized | null | undefined;
  pv: PervyyVystrelConfig;
}): { pass: boolean; reasons: string[]; freshRetailAbsorption: boolean; rerampConfirmation: boolean } {
  const { state, refMcapUsd, vol1hUsd, buys5m, sells5m, materialized, pv } = args;
  const reasons: string[] = [];
  const bottom = state.bottomMcapUsd;
  const peak = state.peakMcapUsd;

  if (bottom == null || bottom <= 0) reasons.push('pervyy_vystrel_phase_d_no_dump_bottom');
  if (state.phaseCConfirmedMs == null) reasons.push('pervyy_vystrel_phase_d_cluster_not_confirmed');

  const rerampMin = bottom != null ? bottom * (1 + pv.rerampMinFromBottomPct / 100) : Number.POSITIVE_INFINITY;
  if (refMcapUsd + 1e-9 < rerampMin) reasons.push('pervyy_vystrel_phase_d_reramp_below_min');
  if (peak > 0 && refMcapUsd > peak * pv.rerampMaxVsPeakPct + 1e-9) {
    reasons.push('pervyy_vystrel_phase_d_reramp_above_peak_cap');
  }

  const volAtBottom = state.volAtDumpBottom ?? 0;
  if (vol1hUsd + 1e-9 < pv.surveillanceMinVol1hUsd) reasons.push('pervyy_vystrel_phase_d_vol_below_min');
  if (volAtBottom > 0 && vol1hUsd < volAtBottom * 0.7 - 1e-9) {
    reasons.push('pervyy_vystrel_phase_d_vol_not_sustained');
  }

  const bs15m = sells5m > 0 ? buys5m / sells5m : buys5m > 0 ? 2 : 0;
  if (bs15m + 1e-9 < 1.05) reasons.push('pervyy_vystrel_phase_d_bs15m_low');

  const organic = materialized?.organicFlow;
  const freshRetailAbsorption =
    organic?.pass === true && (organic.unclusteredBuyers ?? 0) >= Math.min(12, pv.minUnclusteredBuyers1h);
  if (!freshRetailAbsorption) reasons.push('pervyy_vystrel_phase_d_missing_fresh_retail_absorption');

  const volAuth = materialized?.volAuth;
  const volumeAuthentic = volAuth?.authenticPass === true && (volAuth.organicScore ?? 0) >= 0.5;
  if (!volumeAuthentic) reasons.push('pervyy_vystrel_phase_d_missing_volume_authenticity');

  const rerampConfirmation = freshRetailAbsorption && volumeAuthentic;
  if (!rerampConfirmation) reasons.push('pervyy_vystrel_phase_d_reramp_unconfirmed');

  return { pass: reasons.length === 0, reasons, freshRetailAbsorption, rerampConfirmation };
}

export function tickPervyyVystrelWatch(args: {
  cfg: PervyyVystrelConfig;
  input: PervyyVystrelTickInput;
}): PervyyVystrelTickResult | null {
  const state = watchByMint.get(args.input.mint);
  if (!state || state.phase === 'dropped') return null;

  const pv = args.cfg;
  const nowMs = args.input.nowMs ?? Date.now();
  const journalEvents: PervyyVystrelWatchJournalEvent[] = [];
  let phaseChanged = false;
  let phantomGatesPass = false;

  if (state.cooldownUntilMs != null && nowMs < state.cooldownUntilMs) {
    state.lastTickMs = nowMs;
    return { state, phaseChanged: false, journalEvents, phantomGatesPass: false };
  }
  if (state.cooldownUntilMs != null && nowMs >= state.cooldownUntilMs) {
    state.cooldownUntilMs = null;
    if (state.phase === 'cooldown') state.phase = 'phase_b';
  }

  const { refMcapUsd, priceUsd, vol1hUsd, materialized } = args.input;
  updateHolderSnapshots(state, args.input.holderCount, nowMs);

  if (refMcapUsd > state.peakMcapUsd) {
    state.peakMcapUsd = refMcapUsd;
    state.peakPriceUsd = priceUsd;
    state.peakTsMs = nowMs;
  }

  state.lastTickMs = nowMs;

  // --- Phase A ---
  if (state.phase === 'phase_a') {
    const organic = materialized?.organicFlow;
    const volAuth = materialized?.volAuth;

    if (vol1hUsd + 1e-9 >= pv.surveillanceMinVol1hUsd) {
      state.vol1hSustainSamples += 1;
    } else {
      state.vol1hSustainSamples = 0;
    }

    if (nowMs - state.lastPhaseATickMs >= PHASE_A_TICK_THROTTLE_MS) {
      state.lastPhaseATickMs = nowMs;
      journalEvents.push({
        kind: 'pervyy_vystrel_phase_a_tick',
        mint: state.mint,
        peakMcap: state.peakMcapUsd,
        unique_buyers_1h: organic?.uniqueBuyers1h ?? undefined,
        cluster_ratio: organic?.clusterBuyerRatio ?? undefined,
      });
    }

    if (pv.volAuthEnabled && volAuth && !volAuth.insufficientData && !volAuth.authenticPass) {
      journalEvents.push({
        kind: 'pervyy_vystrel_vol_auth_wash_blocked',
        mint: state.mint,
        wash_score: volAuth.washScore,
        reasons: volAuth.reasons.slice(0, 8),
      });
      state.phase = 'dropped';
      phaseChanged = true;
      journalEvents.push({
        kind: 'pervyy_vystrel_watch_evicted',
        mint: state.mint,
        reason: 'vol_auth_wash_blocked',
      });
      return { state, phaseChanged, journalEvents, phantomGatesPass: false };
    }

    const dwellMs = nowMs - state.phaseAEnteredMs;
    const peakReady = state.peakMcapUsd >= pv.phaseAPeakMcapUsd;
    const sustainReady =
      dwellMs >= pv.phaseAMinDwellHours * 60 * 60 * 1000 && state.vol1hSustainSamples >= 2;
    if (peakReady || sustainReady) {
      state.phase = 'phase_b';
      state.phaseBEnteredMs = nowMs;
      phaseChanged = true;
    }
  }

  // --- Phase B ---
  if (state.phase === 'phase_b') {
    const holderDelta = holderDelta30mPct(state, args.input.holderCount);

    if (nowMs - state.lastSurveillanceTickMs >= SURVEILLANCE_TICK_MS) {
      state.lastSurveillanceTickMs = nowMs;
      journalEvents.push({
        kind: 'pervyy_vystrel_surveillance_tick',
        mint: state.mint,
        mcap: refMcapUsd,
        vol1h: vol1hUsd,
        holder_delta_30m: holderDelta ?? undefined,
      });
    }

    const volAuth = materialized?.volAuth;
    if (volAuth?.signals.volumeWithoutHolderGrowth) {
      state.volAuthDecayStreak += 1;
      if (state.volAuthDecayStreak >= 2) {
        journalEvents.push({
          kind: 'pervyy_vystrel_vol_auth_decay_flag',
          mint: state.mint,
          vol1h: vol1hUsd,
          holder_delta_30m: holderDelta ?? undefined,
        });
      }
    } else {
      state.volAuthDecayStreak = 0;
    }

    const volLow = vol1hUsd + 1e-9 < pv.surveillanceMinVol1hUsd;
    if (volLow && state.peakMcapUsd >= PHASE_B_PEAK_GRACE_MCAP_USD) {
      if (state.volGraceUntilMs == null) state.volGraceUntilMs = nowMs + 2 * 60 * 60 * 1000;
    } else if (!volLow) {
      state.volGraceUntilMs = null;
    }

    const inVolGrace = state.volGraceUntilMs != null && nowMs < state.volGraceUntilMs;
    if (volLow && !inVolGrace && state.peakMcapUsd < PHASE_B_PEAK_GRACE_MCAP_USD) {
      state.phase = 'dropped';
      phaseChanged = true;
      journalEvents.push({
        kind: 'pervyy_vystrel_watch_evicted',
        mint: state.mint,
        reason: 'vol_sustain_lost',
      });
      return { state, phaseChanged, journalEvents, phantomGatesPass: false };
    }

    if (isDumpTriggered(state.peakMcapUsd, refMcapUsd, pv)) {
      state.phase = 'phase_c';
      state.bottomMcapUsd = refMcapUsd;
      state.dumpBottomTsMs = nowMs;
      state.volAtDumpBottom = vol1hUsd;
      phaseChanged = true;
    }
  }

  // --- Phase C ---
  if (state.phase === 'phase_c') {
    if (refMcapUsd < (state.bottomMcapUsd ?? refMcapUsd)) {
      state.bottomMcapUsd = refMcapUsd;
      state.dumpBottomTsMs = nowMs;
      state.volAtDumpBottom = vol1hUsd;
    }

    const dumpPct = dumpPctFromPeak(state.peakMcapUsd, refMcapUsd);
    const clusterDump = materialized?.clusterDumpShadow;
    const volAuth = materialized?.volAuth;

    if (volAuth?.signals.cycleShare != null && volAuth.signals.cycleShare >= 0.5) {
      const csr = clusterDump?.clusterSellRatio ?? 0;
      if (csr < 0.4) {
        journalEvents.push({
          kind: 'pervyy_vystrel_vol_auth_fake_dump_skipped',
          mint: state.mint,
          cycle_share: volAuth.signals.cycleShare,
          cluster_sell_ratio: csr,
        });
        state.phase = 'cooldown';
        state.cooldownUntilMs = nowMs + RETAIL_DUMP_COOLDOWN_MS;
        phaseChanged = true;
        return { state, phaseChanged, journalEvents, phantomGatesPass: false };
      }
    }

    if (clusterDump) {
      journalEvents.push({
        kind: 'pervyy_vystrel_phase_c_candidate',
        mint: state.mint,
        cluster_dump_completed: clusterDump.pass,
        cluster_sell_ratio: clusterDump.clusterSellRatio,
        cluster_unique_sellers: clusterDump.clusterUniqueSellers,
        retail_panic_score: clusterDump.retailPanicScore,
        pass: false,
        reasons: clusterDump.pass
          ? ['pervyy_vystrel_phase_c_cluster_dump_shadow_pass']
          : clusterDump.reasons,
      });

      if (clusterDump.pass) {
        state.phase = 'phase_d';
        state.phaseCConfirmedMs = nowMs;
        state.phaseDArmedMs = nowMs;
        phaseChanged = true;
        journalEvents.push({
          kind: 'pervyy_vystrel_cluster_dump_confirmed',
          mint: state.mint,
          dump_pct: dumpPct,
          cluster_sell_ratio: clusterDump.clusterSellRatio ?? undefined,
        });
        journalEvents.push({
          kind: 'pervyy_vystrel_phase_d_armed',
          mint: state.mint,
          bottom_mcap: state.bottomMcapUsd ?? undefined,
          reramp_pct: pv.rerampMinFromBottomPct,
        });
      } else if (clusterDump.retailPanicScore != null && clusterDump.retailPanicScore > pv.retailPanicMax) {
        journalEvents.push({
          kind: 'pervyy_vystrel_dump_retail_skipped',
          mint: state.mint,
          retail_panic_score: clusterDump.retailPanicScore,
        });
        state.phase = 'cooldown';
        state.cooldownUntilMs = nowMs + RETAIL_DUMP_COOLDOWN_MS;
        phaseChanged = true;
      }
    }
  }

  // --- Phase D (phantom replay only) ---
  if (state.phase === 'phase_d') {
    if (
      state.phaseDArmedMs != null &&
      nowMs - state.phaseDArmedMs > PHASE_D_ARM_WINDOW_MS
    ) {
      state.phase = 'dropped';
      phaseChanged = true;
      journalEvents.push({
        kind: 'pervyy_vystrel_watch_evicted',
        mint: state.mint,
        reason: 'phase_d_arm_window_expired',
      });
      return { state, phaseChanged, journalEvents, phantomGatesPass: false };
    }

    const dEval = evaluatePhaseDPhantomGates({
      state,
      refMcapUsd,
      vol1hUsd,
      buys5m: args.input.buys5m ?? 0,
      sells5m: args.input.sells5m ?? 0,
      materialized,
      pv,
    });
    phantomGatesPass = dEval.pass;

    const volAuth = materialized?.volAuth;
    const organic = materialized?.organicFlow;

    journalEvents.push({
      kind: 'pervyy_vystrel_phase_d_candidate',
      mint: state.mint,
      cluster_dump_completed: state.phaseCConfirmedMs != null,
      fresh_retail_absorption: dEval.freshRetailAbsorption,
      reramp_confirmation: dEval.rerampConfirmation,
      organic_score: volAuth?.organicScore ?? null,
      unique_buyers_1h: organic?.uniqueBuyers1h ?? null,
      unclustered_buyers: organic?.unclusteredBuyers ?? null,
      wash_score: volAuth?.washScore ?? null,
      pass: false,
      would_enter: false,
      reasons: dEval.pass
        ? ['pervyy_vystrel_phase_d_phantom_replay_only', 'pervyy_vystrel_phase_d_gates_pass']
        : dEval.reasons,
    });

    if (dEval.pass) {
      journalEvents.push({
        kind: 'pervyy_vystrel_entry_signal',
        mint: state.mint,
        would_enter: false,
        enter: false,
      });
    } else if (dEval.reasons.some((r) => r.includes('falling_knife') || r.includes('reramp_unconfirmed'))) {
      journalEvents.push({
        kind: 'pervyy_vystrel_shadow_skip',
        mint: state.mint,
        phase: 'phase_d',
        reasons: dEval.reasons.slice(0, 12),
      });
    }
  }

  return { state, phaseChanged, journalEvents, phantomGatesPass };
}

export function evictStalePervyyVystrelWatches(args: {
  pv: PervyyVystrelConfig;
  nowMs?: number;
}): PervyyVystrelWatchJournalEvent[] {
  const nowMs = args.nowMs ?? Date.now();
  const ttlMs = args.pv.watchTtlHours * 60 * 60 * 1000;
  const events: PervyyVystrelWatchJournalEvent[] = [];

  for (const [mint, state] of watchByMint) {
    if (state.phase === 'dropped') {
      watchByMint.delete(mint);
      continue;
    }
    if (nowMs - state.onboardedAtMs > ttlMs) {
      watchByMint.delete(mint);
      events.push({
        kind: 'pervyy_vystrel_watch_evicted',
        mint,
        reason: 'watch_ttl_expired',
      });
    }
  }
  return events;
}
