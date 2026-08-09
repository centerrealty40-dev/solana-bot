import { executeCopyBuy, executeCopySell } from '../copytrader/executor.js';
import {
  checkCopyFundingGate,
  resetCopyFundingCache,
} from '../copytrader/funding-gate.js';
import { fetchMintBalanceRaw } from '../copytrader/live-exec.js';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import {
  collectCandidateMints,
  enrichAndFilterCandidates,
  priorityMintsFromCooldown,
  priorityMintsFromPriceRingGreen,
} from './discover.js';
import { evaluateStreamImpulseCandidates } from '../volgreen/stream-impulse.js';
import { closeEmptyAtas } from './close-empty-ata.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import { maybeAlertMildDipDexLoad } from './dex-load.js';
import {
  applyMarkDecisionToPosition,
  decideMarkExit,
  mapPool,
  orderMintsForMark,
  type MarkExitDecision,
} from './exit-engine.js';
import { cooldownMsAfterExit } from './cooldown.js';
import { evaluateCooldownBounce, evaluateMildDipPreBuy } from './gates.js';
import { evaluateAwakeningPreBuy } from '../volgreen/entry-gates.js';
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
import {
  bumpEnrichOverBudget,
  bumpTickError,
} from './runtime-metrics.js';
import { parseLeaderWatchWallets, startLeaderWalletWatch } from './leader-watch.js';
import { mintPriceRefreshStats } from './mint-price-refresh.js';
import { startMildDipHotMintStream, type MildDipStreamHandle } from './stream.js';
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

/** Sample stream prices for mints cooling down or just off cooldown. */
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
): Promise<{ sizeUsd: number; stop: boolean; reason?: string; usdc?: number }> {
  const want = cfg.positionUsd;
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

async function tryEntries(cfg: MildDipConfig, state: MildDipState, nowMs: number): Promise<void> {
  const unlimited = cfg.maxOpenPositions <= 0;
  const slots = unlimited ? Number.POSITIVE_INFINITY : cfg.maxOpenPositions - openCount(state);
  if (!unlimited && slots <= 0) return;

  const tapeMode = cfg.entryMode === 'awakening' || cfg.entryMode === 'green_tape';
  const streamImpulse =
    cfg.entryMode === 'green_tape' && cfg.streamImpulseOnly === true;

  let candidates: Awaited<ReturnType<typeof enrichAndFilterCandidates>>['candidates'];
  let enrichResultSkips: Awaited<ReturnType<typeof enrichAndFilterCandidates>>['skips'] = [];

  if (streamImpulse) {
    // Stream → local 1m impulse → buy. No Dex/Gecko enrich.
    const started = Date.now();
    const buyForce = mildDipHotMints.takeForceEnrichBuyResolved(nowMs, 16);
    const impulse = await evaluateStreamImpulseCandidates(cfg, {
      nowMs,
      evalMax: 24,
      rpcUrl: cfg.rpcUrl,
    });
    candidates = impulse.candidates;
    enrichResultSkips = impulse.skips;
    console.log(
      `[mild-dip] green_tape stream_impulse done buyForce=${buyForce.length} ` +
        `candidates=${candidates.length} skips=${impulse.skips.length} ms=${Date.now() - started}`,
    );
    if (cfg.journalEntrySkips && impulse.skips.length > 0) {
      for (const skip of impulse.skips) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'entry_skip',
          mint: skip.mint,
          entryMode: skip.entryMode,
          reasons: skip.reasons,
          metrics: skip.metrics ?? null,
        });
      }
    }
  } else {
    const priority = priorityMintsFromCooldown(state.cooldownUntilMs, nowMs, {
      postCooldownMs: 120_000,
    });
    const mints = await collectCandidateMints(cfg, { priorityMints: priority, nowMs });
    // Mild-dip parallel-agent scheme adapted for tape:
    // 1) force-enrich ring-green (already looks interesting locally)
    // 2) Dex-probe a wider set, rank by vol5m, full-gate only the top N
    const ringGreen =
      cfg.entryMode === 'green_tape'
        ? priorityMintsFromPriceRingGreen(cfg, mints, nowMs, { max: 60 })
        : [];
    const firstSeenForce =
      tapeMode && cfg.forceEnrichFirstSeenPerMin > 0
        ? mildDipHotMints.takeForceEnrichFirstSeen(nowMs, cfg.forceEnrichFirstSeenPerMin)
        : [];
    const spikeForce = tapeMode
      ? mildDipHotMints.takeForceEnrichHotSpike(nowMs, 8, 12_000, 12_000)
      : [];
    const tripleOnly = tapeMode && cfg.entryMode === 'green_tape' && cfg.greenTape.tripleGreenOnly;
    const buyForce = tapeMode
      ? mildDipHotMints.takeForceEnrichBuyResolved(nowMs, tripleOnly ? 8 : 8)
      : [];
    const forceEnrich = tapeMode
      ? [
          ...new Set([
            ...buyForce,
            ...spikeForce,
            ...firstSeenForce,
            ...ringGreen.slice(0, 12),
            ...priority.slice(0, 8),
          ]),
        ]
      : priority;
    const evalTopN = tapeMode ? cfg.maxEnrichPerScan : 80;
    const probeMax = tripleOnly
      ? Math.min(20, Math.max(cfg.probeEnrichMax, buyForce.length + 6))
      : tapeMode
        ? Math.min(
            24,
            Math.max(
              cfg.probeEnrichMax,
              cfg.probeEnrichMax +
                Math.min(8, firstSeenForce.length + spikeForce.length + buyForce.length),
            ),
          )
        : 80;
    const enrichConcurrency = tripleOnly
      ? Math.min(6, Math.max(3, cfg.enrichConcurrency))
      : tapeMode
        ? Math.min(12, Math.max(6, cfg.enrichConcurrency))
        : cfg.enrichConcurrency;
    const enrichStarted = Date.now();
    const enrichPromise = enrichAndFilterCandidates(cfg, mints, {
      nowMs,
      maxEnrich: evalTopN,
      probeMax,
      enrichConcurrency,
      forceEnrich,
    });
    const enrichBudgetMs = tapeMode ? cfg.enrichBudgetMs : 120_000;
    let enrichResult: Awaited<typeof enrichPromise> | null = null;
    const enrichDone = enrichPromise.then((r) => {
      enrichResult = r;
      return r;
    });
    await Promise.race([enrichDone, sleep(enrichBudgetMs)]);
    if (!enrichResult) {
      bumpEnrichOverBudget();
      console.warn(
        `[mild-dip] enrich still running after ${enrichBudgetMs}ms entryMode=${cfg.entryMode} — awaiting finish`,
      );
      enrichResult = await enrichDone;
    }
    candidates = enrichResult.candidates;
    enrichResultSkips = enrichResult.skips;
    if (tapeMode) {
      console.log(
        `[mild-dip] ${cfg.entryMode} enrich done universe=${mints.length} ringGreen=${ringGreen.length} ` +
          `firstSeen=${firstSeenForce.length} spike=${spikeForce.length} buyForce=${buyForce.length} ` +
          `force=${forceEnrich.length} candidates=${candidates.length} skips=${enrichResult.skips.length} ` +
          `ms=${Date.now() - enrichStarted} probeMax=${probeMax} conc=${enrichConcurrency} evalTopN=${evalTopN}`,
      );
      if (cfg.journalEntrySkips && enrichResultSkips.length > 0) {
        for (const skip of enrichResultSkips) {
          appendMildDipJournal(cfg.journalPath, {
            kind: skip.entryMode === 'awakening' ? 'awaken_skip' : 'entry_skip',
            mint: skip.mint,
            entryMode: skip.entryMode,
            reasons: skip.reasons,
            metrics: skip.metrics ?? null,
          });
        }
      }
    }
  }
  const copyCfg = mildDipToCopyTraderConfig(cfg);

  let filled = 0;
  for (const c of candidates) {
    if (filled >= slots) break;
    if (state.open[c.mint] || buyInFlight.has(c.mint) || sellInFlight.has(c.mint)) continue;
    if (onCooldown(state, c.mint, nowMs)) continue;
    if (cfg.deniedMints.includes(c.mint)) continue;

    // Merge disk state — a twin process / restart may have opened this mint.
    const disk = loadMildDipState(cfg.statePath);
    if (disk.open[c.mint]) {
      state.open[c.mint] = disk.open[c.mint]!;
      continue;
    }
    for (const [m, until] of Object.entries(disk.cooldownUntilMs)) {
      const local = state.cooldownUntilMs[m] ?? 0;
      if (until > local) state.cooldownUntilMs[m] = until;
    }

    // Never rebuy a mint we already hold on-chain (state can lag after restart).
    const onchain = await fetchMintBalanceRaw(copyCfg, c.mint);
    const onchainRaw = onchain && /^\d+$/.test(onchain) ? BigInt(onchain) : 0n;
    if (onchainRaw > HOLDING_DUST_RAW) {
      adoptOnChainHolding({
        cfg,
        state,
        mint: c.mint,
        symbol: c.symbol,
        tokenRaw: onchainRaw.toString(),
        priceUsd: c.priceUsd,
        pc5m: c.metrics.priceChange5mPct,
        nowMs,
      });
      continue;
    }

    const sized = await resolveEntrySizeUsd(cfg, copyCfg, nowMs);
    if (sized.stop || !(sized.sizeUsd > 0)) {
      if (sized.reason && sized.reason !== 'usdc_exhausted') {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_funding_block',
          reason: sized.reason,
          usdc: sized.usdc ?? null,
        });
      }
      break;
    }

    // Re-check right before send — enrich can be tens of seconds stale.
    let entryPriceUsd = c.priceUsd;
    let entryPc5m = c.metrics.priceChange5mPct;
    let freshPx: number | null = c.priceUsd;
    const awakeningEntry = cfg.entryMode === 'awakening';
    const greenTapeEntry = cfg.entryMode === 'green_tape';
    const streamImpulseEntry = greenTapeEntry && cfg.streamImpulseOnly === true;
    if (cfg.preBuyRevalidate) {
      const freshNow = Date.now();
      let freshPc: number | null = null;
      const tripleEntry =
        greenTapeEntry &&
        (c.entryPath === 'green_tape_triple' || c.entryPath === 'green_tape_impulse');

      if (streamImpulseEntry) {
        // No Dex — chase / short-red from stream price ring only.
        const ringLast = mildDipPriceRing.lastPrice(c.mint, freshNow);
        freshPx = ringLast && ringLast.priceUsd > 0 ? ringLast.priceUsd : null;
        freshPc = mildDipPriceRing.changeFromOldestPct(c.mint, 300_000, freshNow);
      } else {
        const fresh = await fetchDexScreenerPairDetails(c.mint, {
          bypassCache: true,
          nowMs: freshNow,
        });
        freshPx = fresh?.priceUsd != null && fresh.priceUsd > 0 ? fresh.priceUsd : null;
        freshPc = fresh?.priceChangeM5Pct ?? null;
        if (freshPx != null) {
          mildDipPriceRing.note(c.mint, freshPx, { tsMs: freshNow, source: 'dex' });
        }
      }
      // triple_green: the huge 1m candle IS the chase (F1Xd 2rgKQQ: matched
      // triple 3/10/63 then prebuy_chase=29%>12 killed the buy ~55s before leader).
      const chaseCap = tripleEntry
        ? Math.max(cfg.maxChasePct, 50)
        : greenTapeEntry && cfg.greenTape.tripleGreenOnly
          ? cfg.maxChasePct
          : greenTapeEntry
            ? Math.min(
                cfg.maxChasePct,
                Math.max(cfg.greenTape.liquidMaxPc5mPct, cfg.greenTape.earlyMaxPc5mPct),
              )
            : cfg.maxChasePct;
      const shortRedMs = cfg.greenTapeShortRedWindowMs;
      const rawShort =
        greenTapeEntry && shortRedMs > 0
          ? mildDipPriceRing.changeFromOldestPct(c.mint, shortRedMs, freshNow)
          : null;
      // Fresh triple: only block violent dumps (≤ -8%). Mild pullback after huge is normal.
      const shortFloor = tripleEntry ? -8 : -1;
      const shortRingPc =
        rawShort != null && Number.isFinite(rawShort) && rawShort <= shortFloor
          ? rawShort
          : null;
      const pre =
        awakeningEntry || greenTapeEntry
          ? evaluateAwakeningPreBuy({
              signalPriceUsd: c.priceUsd,
              freshPriceUsd: freshPx,
              // Stream impulse: ring 5m may be null briefly — don't hard-fail on missing pc5m.
              freshPc5mPct:
                streamImpulseEntry && (freshPc == null || !Number.isFinite(freshPc))
                  ? 0
                  : freshPc,
              maxChasePct: chaseCap,
              minFreshPc5mPct: 0,
              shortRingPc,
            })
          : evaluateMildDipPreBuy({
              signalPriceUsd: c.priceUsd,
              freshPriceUsd: freshPx,
              freshPc5mPct: freshPc,
              entryGates: cfg.entry,
              maxChasePct: cfg.maxChasePct,
            });
      if (!pre.pass) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_prebuy_skip',
          mint: c.mint,
          symbol: c.symbol,
          entryMode: cfg.entryMode,
          entryPath: c.entryPath ?? null,
          signalPriceUsd: c.priceUsd,
          signalPc5m: c.metrics.priceChange5mPct,
          freshPriceUsd: freshPx,
          freshPc5m: freshPc,
          reasons: pre.reasons,
        });
        console.log(
          `[mild-dip] SKIP prebuy ${c.symbol} mint=${c.mint.slice(0, 8)}… ${pre.reasons.join(',')}`,
        );
        // F1Xd: 120s cooldown after chase skip missed the leader window entirely.
        // Triple / stream impulse: no cooldown — keep buyForce and retry next scan.
        if (tripleEntry || streamImpulseEntry) {
          mildDipHotMints.markBuyForce(c.mint, nowMs);
          delete state.cooldownUntilMs[c.mint];
        } else {
          state.cooldownUntilMs[c.mint] = nowMs + Math.min(cfg.mintCooldownMs, 120_000);
        }
        continue;
      }
      if (freshPx != null) entryPriceUsd = freshPx;
      if (freshPc != null) entryPc5m = freshPc;
    }

    // After cooldown: refuse if we already bounced too far off the observed trough.
    // Lookback covers the longer loss-cooldown window so a 10m dump trough is visible.
    // Awakening (green tape) skips trough-bounce — that gate is for dump rebuy only.
    const bounceLookbackMs = Math.max(
      cfg.cooldownBounceLookbackMs,
      cfg.mintCooldownMs,
      cfg.lossCooldownMs,
    );
    const trough = mildDipPriceRing.minPrice(c.mint, bounceLookbackMs, nowMs);
    const bounce = evaluateCooldownBounce({
      freshPriceUsd: freshPx ?? entryPriceUsd,
      troughPriceUsd: trough?.priceUsd ?? null,
      maxBouncePct: awakeningEntry || greenTapeEntry ? 0 : cfg.maxCooldownBouncePct,
      requireTrough: false,
    });
    if (!bounce.pass) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_cooldown_bounce_skip',
        mint: c.mint,
        symbol: c.symbol,
        freshPriceUsd: freshPx ?? entryPriceUsd,
        troughPriceUsd: trough?.priceUsd ?? null,
        troughTsMs: trough?.tsMs ?? null,
        troughSource: trough?.source ?? null,
        sampleCount: mildDipPriceRing.sampleCount(c.mint, bounceLookbackMs, nowMs),
        lookbackMs: bounceLookbackMs,
        dipSource: c.dipSource,
        reasons: bounce.reasons,
      });
      console.log(
        `[mild-dip] SKIP bounce ${c.symbol} mint=${c.mint.slice(0, 8)}… ${bounce.reasons.join(',')}`,
      );
      // Short pause — do not re-hammer the same bounced mark every scan.
      state.cooldownUntilMs[c.mint] = nowMs + Math.min(cfg.mintCooldownMs, 120_000);
      continue;
    }

    // Reserve seat BEFORE Jupiter send so a twin process / overlapping scan
    // cannot open a second $5 clip on the same mint (seen on BorBvx…).
    if (buyInFlight.has(c.mint) || state.open[c.mint]) continue;
    buyInFlight.add(c.mint);
    state.open[c.mint] = {
      mint: c.mint,
      symbol: c.symbol,
      entryPriceUsd,
      sizeUsd: sized.sizeUsd,
      tokenRaw: null,
      openedAtMs: nowMs,
      entryPc5mPct: entryPc5m,
      buySignature: null,
      peakPriceUsd: entryPriceUsd,
      trailArmed: false,
      entryVolume5mUsd: c.metrics.volume5mUsd ?? null,
    };
    saveMildDipState(cfg.statePath, state);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_buy_reserved',
      mint: c.mint,
      symbol: c.symbol,
      sizeUsd: sized.sizeUsd,
      priceUsd: entryPriceUsd,
    });

    const leaderSig = `milddip_${c.mint.slice(0, 8)}_${nowMs}`;
    let buy: Awaited<ReturnType<typeof executeCopyBuy>>;
    try {
      buy = await executeCopyBuy({
        cfg: copyCfg,
        mint: c.mint,
        symbol: c.symbol,
        priceUsd: entryPriceUsd,
        sizeUsd: sized.sizeUsd,
        kind: 'entry',
        evalResult: {
          pass: true,
          reasons:
            awakeningEntry || greenTapeEntry
              ? [
                  `${cfg.entryMode}_${c.entryPath ?? 'signal'}`,
                  `pc5m=${entryPc5m?.toFixed(2) ?? 'n/a'}`,
                  `score=${(c.entryScore ?? 0).toFixed(1)}`,
                ]
              : [`mild_dip_pc5m=${entryPc5m?.toFixed(2) ?? 'n/a'}`],
          score:
            awakeningEntry || greenTapeEntry
              ? Math.max(0, c.entryScore ?? Math.abs(entryPc5m ?? 0))
              : Math.abs(entryPc5m ?? 0),
        },
        leaderSignature: leaderSig,
        // Anchor for Jupiter quote premium guard — abort mid-retry green chase.
        leaderPriceUsd: entryPriceUsd,
        leaderBuyTs: nowMs,
      });
    } catch (err) {
      delete state.open[c.mint];
      buyInFlight.delete(c.mint);
      state.cooldownUntilMs[c.mint] = nowMs + Math.min(cfg.mintCooldownMs, 120_000);
      saveMildDipState(cfg.statePath, state);
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_buy_attempt',
        mint: c.mint,
        symbol: c.symbol,
        sizeUsd: sized.sizeUsd,
        priceUsd: entryPriceUsd,
        signalPriceUsd: c.priceUsd,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        mode: cfg.executionMode,
      });
      resetCopyFundingCache();
      continue;
    }

    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_buy_attempt',
      mint: c.mint,
      symbol: c.symbol,
      sizeUsd: sized.sizeUsd,
      priceUsd: buy.priceUsd || entryPriceUsd,
      signalPriceUsd: c.priceUsd,
      pc5m: entryPc5m,
      signalPc5m: c.metrics.priceChange5mPct,
      ok: buy.ok,
      reason: buy.reason ?? null,
      signature: buy.signature ?? null,
      mode: cfg.executionMode,
      usdcBefore: sized.usdc ?? null,
    });

    if (!buy.ok) {
      delete state.open[c.mint];
      buyInFlight.delete(c.mint);
      state.cooldownUntilMs[c.mint] = nowMs + Math.min(cfg.mintCooldownMs, 120_000);
      saveMildDipState(cfg.statePath, state);
      resetCopyFundingCache();
      continue;
    }

    // Prefer confirmed on-chain raw over quote outAmount.
    const filledRaw = await fetchMintBalanceRaw(copyCfg, c.mint);
    const fillPx = buy.priceUsd || entryPriceUsd;
    state.open[c.mint] = {
      mint: c.mint,
      symbol: c.symbol,
      entryPriceUsd: fillPx,
      sizeUsd: sized.sizeUsd,
      tokenRaw: filledRaw ?? buy.tokenRaw ?? null,
      openedAtMs: nowMs,
      entryPc5mPct: entryPc5m,
      buySignature: buy.signature ?? null,
      peakPriceUsd: fillPx,
      trailArmed: false,
      entryVolume5mUsd: c.metrics.volume5mUsd ?? null,
    };
    buyInFlight.delete(c.mint);
    // Persist immediately — a restart before the tick-end save used to allow a rebuy.
    saveMildDipState(cfg.statePath, state);
    filled += 1;
    resetCopyFundingCache();
    mildDipHotMints.clearBuyForce(c.mint);
    console.log(
      `[mild-dip] BUY ${c.symbol} mint=${c.mint.slice(0, 8)}… $${sized.sizeUsd} pc5m=${entryPc5m?.toFixed(1)} @$${
        (buy.priceUsd || entryPriceUsd).toPrecision(4)
      } mode=${cfg.executionMode}`,
    );
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
  const isPartial =
    fraction < 1 &&
    (decision.reason === 'peak_giveback_partial' ||
      decision.reason === 'mfe_bank_1' ||
      decision.reason === 'mfe_bank_2');

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
    sellFraction: fraction,
    partial: isPartial,
    armed: true,
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
      // Oscar mfeBank / scale-out: leave runner, advance bank stage.
      const live = state.open[mint]!;
      live.exitPartialTaken = true;
      live.scaleOutDone = true;
      live.exitPendingReason = null;
      if (decision.reason === 'mfe_bank_1') live.mfeBankStage = 1;
      else if (decision.reason === 'mfe_bank_2') live.mfeBankStage = 2;
      else if (!(typeof live.mfeBankStage === 'number' && live.mfeBankStage >= 1)) {
        live.mfeBankStage = 1;
      }
      if (decision.reason === 'peak_giveback_partial') {
        live.trailArmed = true;
      }
      live.peakPriceUsd = decision.peakPriceUsd > 0 ? decision.peakPriceUsd : live.peakPriceUsd;
      live.trailArmed = decision.armed || live.trailArmed === true;
      live.sizeUsd = Math.max(0, live.sizeUsd * (1 - fraction));
      live.tokenRaw = null;
      saveMildDipState(cfg.statePath, state);
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_partial_taken',
        mint,
        symbol: pos.symbol,
        exitReason: decision.reason,
        sellFraction: fraction,
        remainSizeUsd: live.sizeUsd,
        resetPeakPx: live.peakPriceUsd,
        mfeBankStage: live.mfeBankStage ?? null,
        pnlPct: +realizedPnl.toFixed(2),
        mfePct: +decision.mfePct.toFixed(2),
        givebackPct: +decision.givebackPct.toFixed(2),
      });
      console.log(
        `[mild-dip] SCALE-OUT ${pos.symbol} reason=${decision.reason} frac=${fraction} ` +
          `pnl=${realizedPnl.toFixed(1)}% remain=$${live.sizeUsd.toFixed(2)} ` +
          `mfe=${decision.mfePct.toFixed(1)}% mode=${cfg.executionMode}`,
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
        `frac=${fraction} cooldown=${Math.round(cd.cooldownMs / 1000)}s(${cd.kind}) mode=${cfg.executionMode}`,
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

  // Illiquid / quote-dead bags: don't sticky-loop forever (47HLk9 spam 19h+).
  const holdMs = nowMs - pos.openedAtMs;
  if (
    (reason === 'jupiter_sell_quote_failed' || reason === 'no_route') &&
    holdMs >= 20 * 60_000
  ) {
    if (state.open[mint]) {
      delete state.open[mint];
      state.cooldownUntilMs[mint] = nowMs + cd.cooldownMs;
      saveMildDipState(cfg.statePath, state);
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_drop_unroutable',
      mint,
      symbol: pos.symbol,
      exitReason: decision.reason,
      sellReason: reason,
      holdSec: Math.floor(holdMs / 1000),
      cooldownMs: cd.cooldownMs,
    });
    console.warn(
      `[mild-dip] DROP unroutable ${pos.symbol} mint=${mint.slice(0, 8)}… ` +
        `hold=${Math.floor(holdMs / 1000)}s sellReason=${reason}`,
    );
    return;
  }

  // Keep `state.open[mint]` — sticky-exit so a bounce cannot clear giveback
  // before the next mark re-queues the sell (AwvwgWt BlockhashNotFound).
  if (state.open[mint]) {
    state.open[mint]!.exitPendingReason = decision.reason;
    saveMildDipState(cfg.statePath, state);
  }
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_sticky_exit',
    mint,
    symbol: pos.symbol,
    exitReason: decision.reason,
    sellReason: reason,
    mfePct: +decision.mfePct.toFixed(2),
    givebackPct: +decision.givebackPct.toFixed(2),
    pnlPct: +decision.pnlPct.toFixed(2),
  });
  console.warn(
    `[mild-dip] sell failed ${mint.slice(0, 8)}…: ${reason} (sticky exit=${decision.reason}, still tracking)`,
  );
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
      let forceReason: 'never_arm_timeout' | 'never_arm_dead' | null = null;
      if (pos.trailArmed !== true) {
        if (maxHold > 0 && heldMs >= maxHold) forceReason = 'never_arm_timeout';
        else if (deadMin > 0 && heldMs >= deadMin) forceReason = 'never_arm_dead';
      }
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
          armed: pos.trailArmed === true,
          justArmed: false,
          shouldExit: true,
          fraction: 1,
          reason: forceReason,
          mfePct: 0,
          givebackPct: 0,
          pnlPct: 0,
          volFadeSamples: pos.volFadeSamples ?? [],
          postEntryTroughPriceUsd: pos.postEntryTroughUsd ?? pos.entryPriceUsd,
          postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
        });
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
      shouldSample: (mint, t) => {
        // green_tape: sample every streamed mint — build local 1m bars to beat leaders.
        if (cfg.entryMode === 'green_tape') return true;
        return shouldSampleStreamPrice(state, mint, t, sampleWatchMs);
      },
    });
  }

  let streamHandle: MildDipStreamHandle | null = null;
  if (cfg.streamEnabled) {
    streamHandle = startMildDipHotMintStream({
      wsUrl: cfg.streamWsUrl || null,
      priceSampler,
      rpcUrl: cfg.rpcUrl,
      buyMintResolveMaxPerMin: cfg.buyMintResolveMaxPerMin,
      buyMintResolveConcurrency: cfg.buyMintResolveConcurrency,
    });
    stats.stream = streamHandle != null;
  }

  // Leader highlight (not blind copy): 7BNaxx/8zkg Buys → force triple eval.
  let leaderWatch: { stop: () => void } | null = null;
  const leaderWallets = parseLeaderWatchWallets();
  if (leaderWallets.length > 0 && (cfg.entryMode === 'green_tape' || cfg.entryMode === 'awakening')) {
    const resolveCap = Number(process.env.MILD_DIP_LEADER_RESOLVE_MAX_PER_MIN ?? 30);
    leaderWatch = startLeaderWalletWatch({
      wallets: leaderWallets,
      rpcUrl: cfg.rpcUrl,
      wsUrl: cfg.streamWsUrl || null,
      resolveMaxPerMin: Number.isFinite(resolveCap) ? Math.max(0, resolveCap) : 30,
      resolveConcurrency: 3,
    });
  }

  const buyImpactCap = process.env.LIVE_BUY_MAX_PRICE_IMPACT_PCT?.trim() || '0';
  const jupPriority = process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL?.trim() || 'n/a';
  const jupFeeCapSol = process.env.LIVE_JUPITER_PRIORITY_MAX_SOL?.trim() || 'n/a';
  console.log(
    `[mild-dip] start mode=${cfg.executionMode} positionUsd=${cfg.positionUsd} quote=USDC ` +
      `entry=(${cfg.entry.minDipPct},${cfg.entry.maxDipPct}] ` +
      `minLiq=$${cfg.entry.minLiquidityUsd} minVol5m=$${cfg.entry.minVolume5mUsd} ` +
      `exit=Oscar arm=${cfg.exit.armPct}% ` +
      `mfeBank=${cfg.exit.mfeBankEnabled ? 1 : 0}/+${cfg.exit.mfeBank1Pct}%×${cfg.exit.mfeBank1Fraction}/+${cfg.exit.mfeBank2Pct}%×${cfg.exit.mfeBank2Fraction}/sleeve=-${cfg.exit.mfeBankSleeveGivebackPct}% ` +
      `cliff=-${cfg.exit.cliffDumpPnlPct}% ` +
      `neverArmBounce=${cfg.exit.neverArmBouncePct > 0 ? 1 : 0}/dump≤-${cfg.exit.neverArmBounceMinDumpPct}%/bounce≥${cfg.exit.neverArmBouncePct}% ` +
      `neverArmTimeRed=${Math.round(cfg.exit.neverArmTimeRedMinMs / 1000)}s/pnl≤-${cfg.exit.neverArmTimeRedPnlPct}% ` +
      `neverArmStale=${Math.round(cfg.exit.neverArmStaleMinMs / 1000)}s ` +
      `neverArmDead=${Math.round(cfg.exit.neverArmDeadMinMs / 1000)}s ` +
      `neverArmVolFade=${Math.round(cfg.exit.neverArmVolFadeMinMs / 1000)}s ` +
      `neverArmMaxHold=${Math.round(cfg.exit.neverArmMaxHoldMs / 1000)}s ` +
      `scan=${cfg.scanIntervalMs}ms mark=${cfg.markIntervalMs}ms cacheTtl=${cfg.markCacheTtlMs}ms ` +
      `markConc=${cfg.markConcurrency} sellConc=${cfg.sellConcurrency} ` +
      `streamImpulseOnly=${cfg.streamImpulseOnly ? 1 : 0} ` +
      `loadAlert=${cfg.loadAlertEnabled ? 1 : 0} ` +
      `stream=${stats.stream} streamPrice=${cfg.streamPriceSampleEnabled ? 1 : 0} ` +
      `streamDipEntry=${cfg.streamDipEntryEnabled ? 1 : 0} ` +
      `prebuy=${cfg.preBuyRevalidate} maxChasePct=${cfg.maxChasePct} ` +
      `slippageBps=${cfg.slippageBps} buyImpactCap=${buyImpactCap}% ` +
      `jupPriority=${jupPriority} jupFeeCapSol=${jupFeeCapSol} ` +
      `maxCooldownBouncePct=${cfg.maxCooldownBouncePct} ` +
      `lookback=${cfg.cooldownBounceLookbackMs}ms ` +
      `mintCooldown=${Math.round(cfg.mintCooldownMs / 1000)}s ` +
      `lossCooldown=${Math.round(cfg.lossCooldownMs / 1000)}s ` +
      `sources=${cfg.discoverSources} open=${openCount(state)} wallet=${cfg.walletPubkeyExpected ?? 'n/a'}`,
  );

  // One-shot: reclaim rent stuck in already-empty ATAs from prior $5 tests.
  if (!opts?.once) {
    await reclaimEmptyAta(cfg, { reason: 'startup_sweep' });
  }

  let lastStreamStatsLog = 0;
  let lastScan = 0;
  let lastMark = 0;

  const tick = async (): Promise<void> => {
    if (opts?.signal?.aborted) return;
    const nowMs = Date.now();

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

    if (streamHandle && nowMs - lastStreamStatsLog >= 30_000) {
      lastStreamStatsLog = nowMs;
      const st = streamHandle.stats();
      const ps = st.priceSampler;
      const rs = st.resolve;
      const rf = mintPriceRefreshStats();
      const rsAny = rs as null | {
        resolved?: number;
        failed?: number;
        failedRpc?: number;
        failedNoEcon?: number;
        droppedStale?: number;
        droppedOverflow?: number;
        queued?: number;
        volumeMarks?: number;
      };
      console.log(
        `[mild-dip] streamPrice sampled=${ps?.sampled ?? 0} skipped=${ps?.skipped ?? 0} ` +
          `queued=${ps?.queued ?? 0} | resolve resolved=${rsAny?.resolved ?? 0} ` +
          `failed=${rsAny?.failed ?? 0} rpc=${rsAny?.failedRpc ?? 0} ` +
          `noEcon=${rsAny?.failedNoEcon ?? 0} volMarks=${rsAny?.volumeMarks ?? 0} ` +
          `droppedStale=${rsAny?.droppedStale ?? 0} ` +
          `droppedOverflow=${rsAny?.droppedOverflow ?? 0} queued=${rsAny?.queued ?? 0} | ` +
          `mintRefresh ok=${rf.ok} fail=${rf.fail} skip=${rf.skip}`,
      );
    }
  };

  // Expose stats for heartbeat via closure property (compat) + module ref.
  (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats = stats;

  const shutdown = (): void => {
    streamHandle?.stop();
    streamHandle = null;
    leaderWatch?.stop();
    leaderWatch = null;
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
        bumpTickError(err);
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
