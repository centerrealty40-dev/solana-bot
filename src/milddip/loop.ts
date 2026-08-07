import { executeCopySell } from '../copytrader/executor.js';
import { checkCopyFundingGate } from '../copytrader/funding-gate.js';
import { fetchMintBalanceRaw } from '../copytrader/live-exec.js';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import {
  collectCandidateMints,
  enrichAndFilterCandidates,
  priorityMintsFromCooldown,
  priorityMintsFromKnifeWatch,
} from './discover.js';
import { closeEmptyAtas } from './close-empty-ata.js';
import { attemptMildDipEntry } from './entry-attempt.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import { maybeAlertMildDipDexLoad } from './dex-load.js';
import {
  evaluateFastPathCandidate,
  fastPathChasePct,
} from './fast-path.js';
import {
  applyMarkDecisionToPosition,
  decideMarkExit,
  mapPool,
  orderMintsForMark,
  type MarkExitDecision,
} from './exit-engine.js';
import { cooldownMsAfterExit } from './cooldown.js';
import { readLeaderSeedMints } from './discover-extra.js';
import {
  loadMildDipHotMints,
  mildDipHotMints,
  saveMildDipHotMints,
} from './hot-mints.js';
import {
  loadMildDipPriceRing,
  mildDipPriceRing,
  saveMildDipPriceRing,
} from './price-ring.js';
import {
  appendMildDipJournal,
  loadMildDipState,
  saveMildDipState,
  type MildDipOpenPosition,
  type MildDipState,
} from './state.js';
import { maybeTopUpFeeSol } from './fee-sol-topup.js';
import { startMildDipHotMintStream } from './stream.js';
import { createStreamPriceSampler } from './stream-price-sampler.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Floor for a last partial clip when draining the wallet. */
const MIN_CLIP_USD = 1;
/** Raw units below this are dust — ignore for rebuy/adopt. */
const HOLDING_DUST_RAW = 1000n;

export type MildDipLoopStats = {
  open: number;
  lastScanAtMs: number | null;
  lastMarkAtMs: number | null;
  lastMarkPassMs: number | null;
  lastMarkedOk: number | null;
  lastMarkedNull: number | null;
  mode: string;
  hotMints: number;
  stream: boolean;
};

/**
 * In-flight sells — mint stays in `state.open` until sell settles so a restart
 * or concurrent mark pass cannot orphan / double-buy the bag.
 */
const sellInFlight = new Set<string>();

/** In-flight buys — seat reserved in `state.open` before Jupiter send. */
const buyInFlight = new Set<string>();

/** Live loop stats pointer for mark-pass telemetry (set in runMildDipLoop). */
let loopStatsRef: MildDipLoopStats | null = null;

function openCount(state: MildDipState): number {
  return Object.keys(state.open).length;
}

function onCooldown(state: MildDipState, mint: string, nowMs: number): boolean {
  const until = state.cooldownUntilMs[mint] ?? 0;
  return until > nowMs;
}

/** Sample stream prices for cooldown / open / recently hot mints (fast-path). */
function shouldSampleStreamPrice(
  state: MildDipState,
  mint: string,
  nowMs: number,
  lookbackMs: number,
): boolean {
  const until = state.cooldownUntilMs[mint] ?? 0;
  if (until > nowMs) return true; // actively cooling — record the trough
  if (until > 0 && nowMs - until <= lookbackMs) return true; // just ready — still useful
  if (state.open[mint]) return true; // open book — denser trail marks via stream
  // Fast-path needs live stream marks on hot names, not only cooldown.
  if (mildDipHotMints.isRecent(mint, nowMs, 180_000)) return true;
  return false;
}

async function markPriceUsd(
  mint: string,
  nowMs: number,
  cacheTtlMs: number,
): Promise<{ px: number | null; volume5mUsd: number | null }> {
  const details = await fetchDexScreenerPairDetails(mint, {
    nowMs,
    // 0 = always HTTP (legacy bypass). >0 reuses shared Dex cache within TTL.
    ...(cacheTtlMs > 0
      ? { cacheTtlMs, bypassCache: false }
      : { bypassCache: true }),
  });
  const volume5mUsd = details?.volume5mUsd ?? null;
  const px = details?.priceUsd;
  if (px != null && px > 0) {
    mildDipPriceRing.note(mint, px, { tsMs: nowMs, source: 'dex' });
    return { px, volume5mUsd };
  }
  return { px: null, volume5mUsd };
}

/** mint → last `mild_dip_mark` journal ts (throttle, process-local). */
const lastMarkJournalMs = new Map<string, number>();

/**
 * Sample the mark path of an open position into the journal so trail widths can
 * be re-fitted offline on our own trades. Throttled per mint; peak moves and
 * exits are always recorded so the upper envelope is never lost.
 */
function maybeJournalMark(
  cfg: MildDipConfig,
  pos: MildDipOpenPosition,
  decision: MarkExitDecision,
  volume5mUsd: number | null,
  nowMs: number,
): void {
  if (cfg.markJournalMs <= 0) return;
  const newPeak = decision.peakPriceUsd > (pos.peakPriceUsd ?? 0);
  const last = lastMarkJournalMs.get(pos.mint) ?? 0;
  if (!newPeak && !decision.shouldExit && nowMs - last < cfg.markJournalMs) return;
  lastMarkJournalMs.set(pos.mint, nowMs);
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_mark',
    mint: pos.mint,
    symbol: pos.symbol,
    entryPx: pos.entryPriceUsd,
    px: decision.markPriceUsd,
    peakPx: decision.peakPriceUsd,
    armed: decision.armed,
    mfePct: +decision.mfePct.toFixed(2),
    givebackPct: +decision.givebackPct.toFixed(2),
    pnlPct: +decision.pnlPct.toFixed(2),
    heldSec: Math.round(Math.max(0, nowMs - pos.openedAtMs) / 1000),
    vol5m: volume5mUsd,
    entryVol5m: pos.entryVolume5mUsd ?? null,
    newPeak,
  });
}

/** Reclaim rent on empty mint ATA after full exit (live only). */
async function reclaimEmptyAta(
  cfg: MildDipConfig,
  args: { mint?: string; symbol?: string; reason: string },
): Promise<void> {
  if (cfg.executionMode !== 'live') return;
  const secret = cfg.walletSecret?.trim();
  if (!secret) return;
  try {
    const result = await closeEmptyAtas({
      rpcUrl: cfg.rpcUrl,
      walletSecret: secret,
      mint: args.mint,
    });
    if (result.closed <= 0 && result.errors.length === 0) return;
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_ata_closed',
      reason: args.reason,
      mint: args.mint ?? null,
      symbol: args.symbol ?? null,
      closed: result.closed,
      reclaimedLamports: result.reclaimedLamports,
      reclaimedSol: +(result.reclaimedLamports / 1e9).toFixed(6),
      signatures: result.signatures,
      errors: result.errors.slice(0, 5),
    });
    if (result.closed > 0) {
      console.log(
        `[mild-dip] ATA close ${args.symbol ?? 'sweep'} n=${result.closed} ` +
          `reclaimed=${(result.reclaimedLamports / 1e9).toFixed(4)} SOL`,
      );
    } else if (result.errors.length > 0) {
      console.warn(`[mild-dip] ATA close failed: ${result.errors[0]}`);
    }
  } catch (err) {
    console.warn(
      `[mild-dip] ATA close error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve clip size from wallet USDC. No slot cap when maxOpenPositions=0 —
 * keep spending until the wallet cannot fund MIN_CLIP_USD.
 */
async function resolveEntrySizeUsd(
  cfg: MildDipConfig,
  copyCfg: ReturnType<typeof mildDipToCopyTraderConfig>,
  nowMs: number,
  wantUsd: number,
): Promise<{ sizeUsd: number; stop: boolean; reason?: string; usdc?: number }> {
  const want = wantUsd > 0 ? wantUsd : cfg.positionUsd;
  const full = await checkCopyFundingGate(copyCfg, want, nowMs);
  if (full.ok) return { sizeUsd: want, stop: false, usdc: full.quoteUsd };

  if (full.reason === 'insufficient_usdc') {
    const leftover = Math.floor(full.quoteUsd * 100) / 100;
    if (leftover + 1e-9 < MIN_CLIP_USD) {
      return { sizeUsd: 0, stop: true, reason: 'usdc_exhausted', usdc: full.quoteUsd };
    }
    const partial = await checkCopyFundingGate(copyCfg, leftover, nowMs);
    if (partial.ok) return { sizeUsd: leftover, stop: false, usdc: partial.quoteUsd };
    return { sizeUsd: 0, stop: true, reason: partial.reason, usdc: partial.quoteUsd };
  }

  // Fee SOL / RPC — do not keep hammering this scan.
  return { sizeUsd: 0, stop: true, reason: full.reason, usdc: full.quoteUsd };
}

function adoptOnChainHolding(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  mint: string;
  symbol: string;
  tokenRaw: string;
  priceUsd: number;
  pc5m: number | null;
  nowMs: number;
}): void {
  const { cfg, state, mint, symbol, tokenRaw, priceUsd, pc5m, nowMs } = args;
  const sizeUsd =
    priceUsd > 0 ? Number(tokenRaw) / 1e6 * priceUsd : cfg.positionUsd;
  const pos: MildDipOpenPosition = {
    mint,
    symbol,
    entryPriceUsd: priceUsd > 0 ? priceUsd : 0,
    sizeUsd: Number.isFinite(sizeUsd) && sizeUsd > 0 ? sizeUsd : cfg.positionUsd,
    tokenRaw,
    openedAtMs: nowMs,
    entryPc5mPct: pc5m,
    buySignature: null,
    peakPriceUsd: priceUsd > 0 ? priceUsd : 0,
    trailArmed: false,
  };
  state.open[mint] = pos;
  saveMildDipState(cfg.statePath, state);
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_adopt_holding',
    mint,
    symbol,
    tokenRaw,
    priceUsd: pos.entryPriceUsd,
    sizeUsd: pos.sizeUsd,
    pc5m,
  });
  console.log(`[mild-dip] ADOPT existing bag ${symbol} mint=${mint.slice(0, 8)}… raw=${tokenRaw}`);
}


async function tryFastPathForMint(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  trigger: 'stream' | 'leader' | 'scan',
  nowMs: number,
): Promise<boolean> {
  if (!cfg.fastPathEnabled) return false;
  if (state.open[mint] || buyInFlight.has(mint) || sellInFlight.has(mint)) return false;
  if (onCooldown(state, mint, nowMs)) return false;

  const unlimited = cfg.maxOpenPositions <= 0;
  if (!unlimited && openCount(state) >= cfg.maxOpenPositions) return false;

  const candidate = await evaluateFastPathCandidate(cfg, mint, nowMs, trigger);
  if (!candidate) return false;

  // Build copyCfg with chase aligned to fast-path (Jupiter premium uses maxChasePct).
  const chase = fastPathChasePct(cfg);
  const cfgFast = { ...cfg, maxChasePct: chase };
  const copyCfg = mildDipToCopyTraderConfig(cfgFast);
  const result = await attemptMildDipEntry({
    cfg: cfgFast,
    state,
    candidate,
    copyCfg,
    nowMs,
    buyInFlight,
    resolveEntrySizeUsd,
    adoptOnChainHolding,
    opts: {
      chasePct: chase,
      skipBounce: cfg.fastPathSkipBounce,
      skipOnchainAdopt: true,
      // One structural Dex already done in evaluateFastPath — avoid second round-trip.
      freshDexPrebuy: false,
      softSkipCooldownMs: cfg.fastPathSoftSkipCooldownMs,
      lane: 'fast',
    },
  });
  return result === 'filled';
}

async function tryEntries(cfg: MildDipConfig, state: MildDipState, nowMs: number): Promise<void> {
  const unlimited = cfg.maxOpenPositions <= 0;
  const slots = unlimited ? Number.POSITIVE_INFINITY : cfg.maxOpenPositions - openCount(state);
  if (!unlimited && slots <= 0) return;

  // Fast lane first: leader seeds (new buys) — do not wait for enrich batch.
  if (cfg.fastPathEnabled) {
    const leaders = readLeaderSeedMints(cfg.leaderSeedPath, nowMs, {
      maxAgeMs: Math.min(cfg.leaderSeedMaxAgeMs, 600_000),
      max: cfg.leaderSeedMax,
    });
    for (const mint of leaders) {
      if (!unlimited && openCount(state) >= cfg.maxOpenPositions) break;
      await tryFastPathForMint(cfg, state, mint, 'leader', nowMs);
    }
    // Hot stream mints — prefer in-band stream drawdown, but still Dex-probe
    // when the ring has no dd yet (do not wait for a leader seed).
    for (const mint of mildDipHotMints.list(nowMs).slice(0, 40)) {
      if (!unlimited && openCount(state) >= cfg.maxOpenPositions) break;
      await tryFastPathForMint(cfg, state, mint, 'stream', nowMs);
    }
  }

  // Slow lane: tiny cached enrich for knife / leftovers only.
  const priority = priorityMintsFromCooldown(state.cooldownUntilMs, nowMs, {
    postCooldownMs: 120_000,
  });
  const knifePriority = priorityMintsFromKnifeWatch(state.knifeWatch);
  const forceEnrich = [...new Set([...priority, ...knifePriority])];
  const mints = await collectCandidateMints(cfg, { priorityMints: forceEnrich, nowMs });
  const enrichPass = await enrichAndFilterCandidates(cfg, mints, {
    nowMs,
    maxEnrich: cfg.enrichMax,
    enrichConcurrency: Math.min(cfg.enrichConcurrency, 6),
    bypassCache: false,
    cacheTtlMs: 3_000,
    forceEnrich,
    knifeWatch: state.knifeWatch ?? {},
  });
  state.knifeWatch = enrichPass.knifeWatch;
  for (const ev of enrichPass.knifeEvents) {
    appendMildDipJournal(cfg.journalPath, ev);
    const k = String(ev.kind ?? '');
    if (k === 'mild_dip_knife_watch_start') {
      console.log(
        `[mild-dip] KNIFE watch ${String(ev.mint).slice(0, 8)}… dip=${ev.knifeDipPct} wait=${cfg.knifeStabilizeWaitMs}ms`,
      );
    } else if (k === 'mild_dip_knife_ready') {
      console.log(
        `[mild-dip] KNIFE ready ${String(ev.mint).slice(0, 8)}… mode=${ev.mode} bounce=${ev.bouncePct}`,
      );
    }
  }
  saveMildDipState(cfg.statePath, state);

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  let filled = 0;
  for (const c of enrichPass.candidates) {
    if (filled >= slots) break;
    // Prefer fast-path for non-knife; knife still uses slow confirm.
    if (c.dipSource !== 'knife_stabilize' && cfg.fastPathEnabled) {
      const ok = await tryFastPathForMint(cfg, state, c.mint, 'scan', nowMs);
      if (ok) {
        filled += 1;
        continue;
      }
    }
    const result = await attemptMildDipEntry({
      cfg,
      state,
      candidate: c,
      copyCfg,
      nowMs,
      buyInFlight,
      resolveEntrySizeUsd,
      adoptOnChainHolding,
      opts: {
        chasePct: cfg.maxChasePct,
        skipBounce: false,
        skipOnchainAdopt: false,
        freshDexPrebuy: true,
        softSkipCooldownMs: Math.min(cfg.mintCooldownMs, 60_000),
        lane: 'slow',
      },
    });
    if (result === 'filled') filled += 1;
    if (result === 'stop') break;
  }
}

async function executeQueuedSell(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  decision: MarkExitDecision;
  nowMs: number;
}): Promise<void> {
  const { cfg, state, decision, nowMs } = args;
  const mint = decision.mint;
  const pos = state.open[mint];
  if (!pos || !decision.reason) return;

  const fraction =
    decision.fraction > 0 && decision.fraction < 1 ? decision.fraction : 1;
  const isPartial = fraction < 1 && decision.reason === 'peak_giveback_partial';

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  // Dedicated wallet: sell on-chain balance (omit stale quote tokenRaw → 6024).
  const sell = await executeCopySell({
    cfg: copyCfg,
    mint,
    symbol: pos.symbol,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd: decision.markPriceUsd,
    sizeUsd: pos.sizeUsd,
    fraction,
    leaderSignature: `milddip_exit_${decision.reason}_${nowMs}`,
    sellDelayMs: 0,
  });

  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_sell',
    reason: decision.reason,
    mint,
    symbol: pos.symbol,
    entryPx: pos.entryPriceUsd,
    peakPx: decision.peakPriceUsd,
    exitPx: sell.priceUsd || decision.markPriceUsd,
    mfePct: +decision.mfePct.toFixed(2),
    givebackPct: +decision.givebackPct.toFixed(2),
    realizedPct: +(sell.pnlPct ?? decision.pnlPct).toFixed(2),
    fraction,
    scaleOut: isPartial,
    armed: decision.armed,
    holdSec: Math.floor((nowMs - pos.openedAtMs) / 1000),
    ok: sell.ok,
    sellReason: sell.reason ?? null,
    signature: sell.signature ?? null,
    mode: cfg.executionMode,
  });

  const realizedPnl = sell.pnlPct ?? decision.pnlPct;
  const cd = cooldownMsAfterExit({
    pnlPct: realizedPnl,
    mintCooldownMs: cfg.mintCooldownMs,
    lossCooldownMs: cfg.lossCooldownMs,
  });

  if (sell.ok) {
    if (isPartial && state.open[mint]) {
      // Leave the runner: mark scale-out done, shrink notional, refresh raw.
      const live = state.open[mint]!;
      live.scaleOutDone = true;
      live.sizeUsd = Math.max(0, live.sizeUsd * (1 - fraction));
      live.peakPriceUsd = decision.peakPriceUsd;
      live.trailArmed = decision.armed;
      const rem = await fetchMintBalanceRaw(copyCfg, mint);
      if (rem && /^\d+$/.test(rem) && BigInt(rem) > HOLDING_DUST_RAW) {
        live.tokenRaw = rem;
      } else {
        // Dust / empty after "partial" — treat as full close.
        delete state.open[mint];
        state.cooldownUntilMs[mint] = nowMs + cd.cooldownMs;
        saveMildDipState(cfg.statePath, state);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_cooldown_set',
          mint,
          symbol: pos.symbol,
          pnlPct: +realizedPnl.toFixed(2),
          cooldownMs: cd.cooldownMs,
          cooldownKind: cd.kind,
          exitReason: decision.reason,
          note: 'partial_left_dust',
        });
        console.log(
          `[mild-dip] SELL ${pos.symbol} reason=${decision.reason} (partial→flat) ` +
            `pnl=${realizedPnl.toFixed(1)}% mode=${cfg.executionMode}`,
        );
        await reclaimEmptyAta(cfg, {
          mint,
          symbol: pos.symbol,
          reason: `post_sell_${decision.reason}`,
        });
        return;
      }
      saveMildDipState(cfg.statePath, state);
      console.log(
        `[mild-dip] SCALE-OUT ${pos.symbol} frac=${fraction} pnl=${realizedPnl.toFixed(1)}% ` +
          `mfe=${decision.mfePct.toFixed(1)}% giveback=${decision.givebackPct.toFixed(1)}% ` +
          `runner≈$${live.sizeUsd.toFixed(2)} mode=${cfg.executionMode}`,
      );
      return;
    }

    // Re-read — another path must not have already cleared it.
    if (state.open[mint]) {
      delete state.open[mint];
      state.cooldownUntilMs[mint] = nowMs + cd.cooldownMs;
      saveMildDipState(cfg.statePath, state);
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_cooldown_set',
      mint,
      symbol: pos.symbol,
      pnlPct: +realizedPnl.toFixed(2),
      cooldownMs: cd.cooldownMs,
      cooldownKind: cd.kind,
      exitReason: decision.reason,
    });
    console.log(
      `[mild-dip] SELL ${pos.symbol} reason=${decision.reason} pnl=${realizedPnl.toFixed(1)}% ` +
        `mfe=${decision.mfePct.toFixed(1)}% giveback=${decision.givebackPct.toFixed(1)}% ` +
        `cooldown=${Math.round(cd.cooldownMs / 1000)}s(${cd.kind}) mode=${cfg.executionMode}`,
    );
    await reclaimEmptyAta(cfg, {
      mint,
      symbol: pos.symbol,
      reason: `post_sell_${decision.reason}`,
    });
    return;
  }

  const reason = sell.reason ?? 'unknown';
  if (reason === 'no_token_balance') {
    if (state.open[mint]) {
      delete state.open[mint];
      state.cooldownUntilMs[mint] = nowMs + cd.cooldownMs;
      saveMildDipState(cfg.statePath, state);
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_drop_empty',
      mint,
      symbol: pos.symbol,
      exitReason: decision.reason,
      pnlPct: +realizedPnl.toFixed(2),
      cooldownMs: cd.cooldownMs,
      cooldownKind: cd.kind,
    });
    console.warn(
      `[mild-dip] DROP empty bag ${pos.symbol} mint=${mint.slice(0, 8)}… ` +
        `cooldown=${Math.round(cd.cooldownMs / 1000)}s(${cd.kind})`,
    );
    await reclaimEmptyAta(cfg, {
      mint,
      symbol: pos.symbol,
      reason: 'post_drop_empty',
    });
    return;
  }

  // Keep `state.open[mint]` — retry next mark pass. Never orphan on soft fail.
  console.warn(`[mild-dip] sell failed ${mint.slice(0, 8)}…: ${reason} (still tracking)`);
}

/**
 * Phase 1: parallel Dex marks (armed first).
 * Phase 2: persist peak/arm updates (positions stay open).
 * Phase 3: sell queue with limited concurrency — mint leaves state only after
 * confirmed sell / empty bag. In-flight mints skipped on subsequent marks.
 */
async function tryExits(cfg: MildDipConfig, state: MildDipState, nowMs: number): Promise<void> {
  const ordered = orderMintsForMark(state.open).filter((m) => !sellInFlight.has(m));
  if (ordered.length === 0) return;

  const markStarted = Date.now();
  const markRows = await mapPool(ordered, cfg.markConcurrency, async (mint) => {
    const { px, volume5mUsd } = await markPriceUsd(mint, nowMs, cfg.markCacheTtlMs);
    return { mint, px, volume5mUsd };
  });
  const markPassMs = Date.now() - markStarted;
  let markedOk = 0;
  let markedNull = 0;
  for (const row of markRows) {
    if (row.px == null) markedNull += 1;
    else markedOk += 1;
  }

  const toSell: MarkExitDecision[] = [];
  for (const { mint, px, volume5mUsd } of markRows) {
    const pos = state.open[mint];
    if (!pos || sellInFlight.has(mint)) continue;

    const heldMs = Math.max(0, nowMs - (pos.openedAtMs > 0 ? pos.openedAtMs : nowMs));
    const maxHold = cfg.exit.neverArmMaxHoldMs > 0 ? cfg.exit.neverArmMaxHoldMs : 0;
    const deadMin = cfg.exit.neverArmDeadMinMs > 0 ? cfg.exit.neverArmDeadMinMs : 0;

    /**
     * Null Dex mark must NOT skip never-arm ceilings — a delisted mint can
     * otherwise sit forever. Force-exit without needing a real mark.
     */
    if (px == null) {
      if (pos.trailArmed !== true) {
        let forceReason: 'never_arm_timeout' | 'never_arm_dead' | null = null;
        if (maxHold > 0 && heldMs >= maxHold) forceReason = 'never_arm_timeout';
        else if (deadMin > 0 && heldMs >= deadMin) forceReason = 'never_arm_dead';
        if (forceReason) {
          const syn =
            pos.peakPriceUsd != null && pos.peakPriceUsd > 0
              ? pos.peakPriceUsd
              : pos.entryPriceUsd;
          console.warn(
            `[mild-dip] force-exit ${pos.symbol} mint=${mint.slice(0, 8)}… reason=${forceReason} (null mark, held=${Math.round(heldMs / 1000)}s)`,
          );
          toSell.push({
            mint,
            markPriceUsd: syn,
            peakPriceUsd: syn,
            armed: false,
            justArmed: false,
            shouldExit: true,
            fraction: 1,
            reason: forceReason,
            mfePct: 0,
            givebackPct: 0,
            pnlPct: 0,
            volFadeSamples: pos.volFadeSamples ?? [],
          });
        }
      }
      continue;
    }

    const decision = decideMarkExit({
      mint,
      pos,
      markPriceUsd: px,
      gates: cfg.exit,
      nowMs,
      volume5mUsd,
    });
    if (!decision) continue;

    // First usable volume reading becomes the fade baseline for adopted bags.
    if (pos.entryVolume5mUsd == null && volume5mUsd != null && volume5mUsd > 0) {
      pos.entryVolume5mUsd = volume5mUsd;
    }

    maybeJournalMark(cfg, pos, decision, volume5mUsd, nowMs);

    applyMarkDecisionToPosition(pos, decision);

    if (decision.justArmed) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'trail_armed',
        mint,
        symbol: pos.symbol,
        entryPx: pos.entryPriceUsd,
        peakPx: decision.peakPriceUsd,
        armPct: cfg.exit.armPct,
        mfePct: +decision.mfePct.toFixed(2),
      });
      console.log(
        `[mild-dip] ARM ${pos.symbol} mint=${mint.slice(0, 8)}… mfe=${decision.mfePct.toFixed(1)}% peak=$${decision.peakPriceUsd.toPrecision(4)}`,
      );
    }

    if (decision.shouldExit && decision.reason) {
      toSell.push(decision);
    }
  }

  // Persist peak/arm for ALL opens before any sell — crash mid-sell must not
  // lose trail state or drop mints from `open`.
  saveMildDipState(cfg.statePath, state);

  const loadStats = {
    openCount: openCount(state),
    markPassMs,
    markedOk,
    markedNull,
    markIntervalMs: cfg.markIntervalMs,
    markCacheTtlMs: cfg.markCacheTtlMs,
  };
  if (loopStatsRef) {
    loopStatsRef.lastMarkPassMs = markPassMs;
    loopStatsRef.lastMarkedOk = markedOk;
    loopStatsRef.lastMarkedNull = markedNull;
  }

  const loadResult = await maybeAlertMildDipDexLoad({
    stats: loadStats,
    gates: {
      markPassWarnMs: cfg.loadAlertMarkPassMs,
      openWarnCount: cfg.loadAlertOpenCount,
      nullRatioWarn: cfg.loadAlertNullRatio,
    },
    cooldownMs: cfg.loadAlertCooldownMs,
    enabled: cfg.loadAlertEnabled,
    nowMs,
  });
  if (loadResult.overloaded) {
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_dex_load_warn',
      ...loadStats,
      reasons: loadResult.reasons,
      alerted: loadResult.alerted,
    });
  }

  if (toSell.length === 0) return;

  await mapPool(toSell, cfg.sellConcurrency, async (decision) => {
    if (sellInFlight.has(decision.mint)) return;
    if (!state.open[decision.mint]) return;
    sellInFlight.add(decision.mint);
    try {
      await executeQueuedSell({ cfg, state, decision, nowMs });
    } finally {
      sellInFlight.delete(decision.mint);
    }
  });
}

export async function runMildDipLoop(
  cfg: MildDipConfig,
  opts?: { once?: boolean; signal?: AbortSignal },
): Promise<void> {
  const state = loadMildDipState(cfg.statePath);
  const stats: MildDipLoopStats = {
    open: openCount(state),
    lastScanAtMs: null,
    lastMarkAtMs: null,
    lastMarkPassMs: null,
    lastMarkedOk: null,
    lastMarkedNull: null,
    mode: cfg.executionMode,
    hotMints: 0,
    stream: false,
  };
  loopStatsRef = stats;

  const hotLoaded = loadMildDipHotMints(cfg.hotMintsPath);
  const ringLoaded = loadMildDipPriceRing(cfg.priceRingPath);
  if (hotLoaded > 0 || ringLoaded > 0) {
    console.log(
      `[mild-dip] restored hotMints=${hotLoaded} priceSamples=${ringLoaded} ` +
        `from ${cfg.hotMintsPath} / ${cfg.priceRingPath}`,
    );
  }

  let priceSampler: ReturnType<typeof createStreamPriceSampler> | null = null;
  const sampleWatchMs = Math.max(
    cfg.cooldownBounceLookbackMs,
    cfg.mintCooldownMs,
    cfg.lossCooldownMs,
  );
  if (cfg.streamPriceSampleEnabled) {
    priceSampler = createStreamPriceSampler({
      rpcUrl: cfg.rpcUrl,
      minGapMsPerMint: cfg.streamPriceMinGapMs,
      concurrency: cfg.streamPriceConcurrency,
      shouldSample: (mint, t) => shouldSampleStreamPrice(state, mint, t, sampleWatchMs),
    });
  }

  let streamHandle: { stop: () => void } | null = null;
  if (cfg.streamEnabled) {
    streamHandle = startMildDipHotMintStream({
      wsUrl: cfg.streamWsUrl || null,
      priceSampler,
      onMint: (mint, tsMs) => {
        // Immediate fast-path — do not wait for the 5s enrich batch.
        if (!cfg.fastPathEnabled) return;
        void tryFastPathForMint(cfg, state, mint, 'stream', tsMs).catch((err) => {
          console.warn(
            '[mild-dip] fast-path stream error',
            err instanceof Error ? err.message : err,
          );
        });
      },
    });
    stats.stream = streamHandle != null;
  }

  const buyImpactCap = process.env.LIVE_BUY_MAX_PRICE_IMPACT_PCT?.trim() || '0';
  const jupPriority = process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL?.trim() || 'n/a';
  const jupFeeCapSol = process.env.LIVE_JUPITER_PRIORITY_MAX_SOL?.trim() || 'n/a';
  console.log(
    `[mild-dip] start mode=${cfg.executionMode} positionUsd=${cfg.positionUsd} quote=USDC ` +
      `thickUsd=${cfg.thickPositionUsd}` +
      `(mcap≥$${cfg.thickMinMarketCapUsd}/liq≥$${cfg.thickMinLiquidityUsd}/age≥${cfg.thickMinPairAgeHours}h) ` +
      `entry=(${cfg.entry.minDipPct},${cfg.entry.maxDipPct}] ` +
      `h1RedShallow=${cfg.h1RedShallowEnabled ? 1 : 0}` +
      `(h1≤${cfg.h1RedShallowH1MaxPct}/pc5m∈(${cfg.h1RedShallowMinDipPct},${cfg.h1RedShallowMaxDipPct}]) ` +
      `flatMicro=${cfg.flatMicroDipEnabled ? 1 : 0}` +
      `(h1∈[${cfg.flatMicroH1MinPct},${cfg.flatMicroH1MaxPct}]/pc5m∈(${cfg.flatMicroMinDipPct},${cfg.flatMicroMaxDipPct}]) ` +
      `minLiq=$${cfg.entry.minLiquidityUsd} minVol5m=$${cfg.entry.minVolume5mUsd} ` +
      `exit=W9.1 arm=${cfg.exit.armPct}% ` +
      `partial=-${cfg.exit.partialGivebackPct}%×${cfg.exit.scaleOutFraction} ` +
      `fullGiveback=-${cfg.exit.givebackPct}% ` +
      `cliffDump=-${cfg.exit.cliffDumpPnlPct}% ` +
      `neverArmPatience=${Math.round(cfg.exit.neverArmPatienceMs / 1000)}s ` +
      `neverArmStale=${Math.round(cfg.exit.neverArmStaleMinMs / 1000)}s` +
      `/mfe≤${cfg.exit.neverArmStaleMaxMfePct}%/pnl≤-${cfg.exit.neverArmStalePnlPct}% ` +
      `neverArmDead=${Math.round(cfg.exit.neverArmDeadMinMs / 1000)}s/-${cfg.exit.neverArmDeadPnlPct}% ` +
      `neverArmVolFade=${Math.round(cfg.exit.neverArmVolFadeMinMs / 1000)}s/x${cfg.exit.neverArmVolFadeRatio}/$${cfg.exit.neverArmVolFadeFloorUsd}` +
      `/sample${Math.round(cfg.exit.neverArmVolFadeSampleMs / 1000)}s×${cfg.exit.neverArmVolFadeWeakWindows} ` +
      `neverArmMaxHold=${Math.round(cfg.exit.neverArmMaxHoldMs / 1000)}s ` +
      `scan=${cfg.scanIntervalMs}ms mark=${cfg.markIntervalMs}ms cacheTtl=${cfg.markCacheTtlMs}ms ` +
      `markConc=${cfg.markConcurrency} sellConc=${cfg.sellConcurrency} ` +
      `loadAlert=${cfg.loadAlertEnabled ? 1 : 0} ` +
      `stream=${stats.stream} streamPrice=${cfg.streamPriceSampleEnabled ? 1 : 0} ` +
      `streamDipEntry=${cfg.streamDipEntryEnabled ? 1 : 0} ` +
      `fastPath=${cfg.fastPathEnabled ? 1 : 0}/chase${cfg.fastPathChasePct}` +
      `/skipBounce=${cfg.fastPathSkipBounce ? 1 : 0}` +
      `/hotDexProbe=${cfg.fastPathHotDexProbeEnabled ? 1 : 0}` +
      `@${cfg.fastPathHotDexProbeGapMs}ms≤${cfg.fastPathHotDexProbeMaxPerMin}/min ` +
      `/enrichMax=${cfg.enrichMax} ` +
      `prebuy=${cfg.preBuyRevalidate} maxChasePct=${cfg.maxChasePct} ` +
      `slippageBps=${cfg.slippageBps} buyImpactCap=${buyImpactCap}% ` +
      `jupPriority=${jupPriority} jupFeeCapSol=${jupFeeCapSol} ` +
      `maxCooldownBouncePct=${cfg.maxCooldownBouncePct} ` +
      `lookback=${cfg.cooldownBounceLookbackMs}ms ` +
      `knifeStabilize=${cfg.knifeStabilizeEnabled ? 1 : 0}` +
      `(${cfg.knifeStabilizeMinDipPct},${cfg.knifeStabilizeMaxDipPct}]` +
      `/wait${Math.round(cfg.knifeStabilizeWaitMs / 1000)}s` +
      `/bounce[${cfg.knifeStabilizeMinBouncePct},${cfg.knifeStabilizeMaxBouncePct}] ` +
      `mintCooldown=${Math.round(cfg.mintCooldownMs / 1000)}s ` +
      `lossCooldown=${Math.round(cfg.lossCooldownMs / 1000)}s ` +
      `feeSolTopup=${cfg.feeSolTopupEnabled ? 1 : 0}` +
      `/every${Math.round(cfg.feeSolTopupIntervalMs / 3_600_000)}h` +
      `/min$${cfg.feeSolTopupMinUsd}/buy$${cfg.feeSolTopupBuyUsd} ` +
      `sources=${cfg.discoverSources} open=${openCount(state)} wallet=${cfg.walletPubkeyExpected ?? 'n/a'}`,
  );

  // One-shot: reclaim rent stuck in already-empty ATAs from prior $5 tests.
  if (!opts?.once) {
    await reclaimEmptyAta(cfg, { reason: 'startup_sweep' });
  }

  let lastScan = 0;
  let lastMark = 0;

  const tick = async (): Promise<void> => {
    if (opts?.signal?.aborted) return;
    const nowMs = Date.now();

    // Fee SOL top-up (interval-gated inside helper; first check ASAP after start).
    try {
      await maybeTopUpFeeSol(cfg, nowMs);
    } catch (err) {
      console.warn('[mild-dip] fee-sol topup tick failed', err);
    }

    // Respect markInterval (previously `|| openCount>0` hammered Dex every tick).
    if (openCount(state) > 0 && nowMs - lastMark >= cfg.markIntervalMs) {
      await tryExits(cfg, state, nowMs);
      lastMark = nowMs;
      stats.lastMarkAtMs = nowMs;
      saveMildDipState(cfg.statePath, state);
    }

    if (nowMs - lastScan >= cfg.scanIntervalMs) {
      await tryEntries(cfg, state, nowMs);
      lastScan = nowMs;
      stats.lastScanAtMs = nowMs;
      saveMildDipState(cfg.statePath, state);
      // Persist universe + trough samples across restarts/deploys.
      try {
        saveMildDipHotMints(cfg.hotMintsPath);
        saveMildDipPriceRing(cfg.priceRingPath);
      } catch (err) {
        console.warn('[mild-dip] persist hot/price ring failed', err);
      }
    }

    stats.open = openCount(state);
    stats.hotMints = mildDipHotMints.size(nowMs);
  };

  // Expose stats for heartbeat via closure property (compat) + module ref.
  (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats = stats;

  const shutdown = (): void => {
    streamHandle?.stop();
    streamHandle = null;
    priceSampler?.stop();
    try {
      saveMildDipHotMints(cfg.hotMintsPath);
      saveMildDipPriceRing(cfg.priceRingPath);
    } catch {
      /* ignore */
    }
  };

  if (opts?.once) {
    try {
      await tick();
    } finally {
      shutdown();
      if (loopStatsRef === stats) loopStatsRef = null;
    }
    return;
  }

  opts?.signal?.addEventListener('abort', shutdown, { once: true });

  try {
    for (;;) {
      if (opts?.signal?.aborted) break;
      try {
        await tick();
      } catch (err) {
        console.error('[mild-dip] tick error', err);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_tick_error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(Math.min(cfg.markIntervalMs, 5_000));
    }
  } finally {
    shutdown();
    if (loopStatsRef === stats) loopStatsRef = null;
  }
}

export function mildDipLoopStats(): MildDipLoopStats | null {
  return loopStatsRef ?? (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats ?? null;
}
