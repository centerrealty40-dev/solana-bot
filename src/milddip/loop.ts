import { executeCopyBuy, executeCopySell } from '../copytrader/executor.js';
import {
  checkCopyFundingGate,
  resetCopyFundingCache,
} from '../copytrader/funding-gate.js';
import { fetchMintBalanceRaw } from '../copytrader/live-exec.js';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import { collectCandidateMints, enrichAndFilterCandidates } from './discover.js';
import { closeEmptyAtas } from './close-empty-ata.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import {
  applyMarkDecisionToPosition,
  decideMarkExit,
  mapPool,
  orderMintsForMark,
  type MarkExitDecision,
} from './exit-engine.js';
import { evaluateMildDipPreBuy } from './gates.js';
import { mildDipHotMints } from './hot-mints.js';
import {
  appendMildDipJournal,
  loadMildDipState,
  saveMildDipState,
  type MildDipOpenPosition,
  type MildDipState,
} from './state.js';
import { startMildDipHotMintStream } from './stream.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Floor for a last partial clip when draining the wallet. */
const MIN_CLIP_USD = 1;
/** Raw units below this are dust — ignore for rebuy/adopt. */
const HOLDING_DUST_RAW = 1000n;

/**
 * In-flight sells — mint stays in `state.open` until sell settles so a restart
 * or concurrent mark pass cannot orphan / double-buy the bag.
 */
const sellInFlight = new Set<string>();

function openCount(state: MildDipState): number {
  return Object.keys(state.open).length;
}

function onCooldown(state: MildDipState, mint: string, nowMs: number): boolean {
  const until = state.cooldownUntilMs[mint] ?? 0;
  return until > nowMs;
}

async function markPriceUsd(mint: string, nowMs: number): Promise<number | null> {
  const details = await fetchDexScreenerPairDetails(mint, { bypassCache: true, nowMs });
  const px = details?.priceUsd;
  return px != null && px > 0 ? px : null;
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

  const mints = await collectCandidateMints(cfg);
  const candidates = await enrichAndFilterCandidates(cfg, mints, { nowMs, maxEnrich: 80 });
  const copyCfg = mildDipToCopyTraderConfig(cfg);

  let filled = 0;
  for (const c of candidates) {
    if (filled >= slots) break;
    if (state.open[c.mint]) continue;
    if (onCooldown(state, c.mint, nowMs)) continue;
    if (cfg.deniedMints.includes(c.mint)) continue;

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
    if (cfg.preBuyRevalidate) {
      const freshNow = Date.now();
      const fresh = await fetchDexScreenerPairDetails(c.mint, {
        bypassCache: true,
        nowMs: freshNow,
      });
      const freshPx = fresh?.priceUsd != null && fresh.priceUsd > 0 ? fresh.priceUsd : null;
      const freshPc = fresh?.priceChangeM5Pct ?? null;
      const pre = evaluateMildDipPreBuy({
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
          signalPriceUsd: c.priceUsd,
          signalPc5m: c.metrics.priceChange5mPct,
          freshPriceUsd: freshPx,
          freshPc5m: freshPc,
          reasons: pre.reasons,
        });
        console.log(
          `[mild-dip] SKIP prebuy ${c.symbol} mint=${c.mint.slice(0, 8)}… ${pre.reasons.join(',')}`,
        );
        state.cooldownUntilMs[c.mint] = nowMs + Math.min(cfg.mintCooldownMs, 120_000);
        continue;
      }
      if (freshPx != null) entryPriceUsd = freshPx;
      if (freshPc != null) entryPc5m = freshPc;
    }

    const leaderSig = `milddip_${c.mint.slice(0, 8)}_${nowMs}`;
    const buy = await executeCopyBuy({
      cfg: copyCfg,
      mint: c.mint,
      symbol: c.symbol,
      priceUsd: entryPriceUsd,
      sizeUsd: sized.sizeUsd,
      kind: 'entry',
      evalResult: {
        pass: true,
        reasons: [
          `mild_dip_pc5m=${entryPc5m?.toFixed(2) ?? 'n/a'}`,
        ],
        score: Math.abs(entryPc5m ?? 0),
      },
      leaderSignature: leaderSig,
      // Anchor for Jupiter quote premium guard — abort mid-retry green chase.
      leaderPriceUsd: entryPriceUsd,
      leaderBuyTs: nowMs,
    });

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
      state.cooldownUntilMs[c.mint] = nowMs + Math.min(cfg.mintCooldownMs, 120_000);
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
    };
    // Persist immediately — a restart before the tick-end save used to allow a rebuy.
    saveMildDipState(cfg.statePath, state);
    filled += 1;
    resetCopyFundingCache();
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

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  // Dedicated wallet: sell on-chain balance (omit stale quote tokenRaw → 6024).
  const sell = await executeCopySell({
    cfg: copyCfg,
    mint,
    symbol: pos.symbol,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd: decision.markPriceUsd,
    sizeUsd: pos.sizeUsd,
    fraction: 1,
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
    armed: true,
    holdSec: Math.floor((nowMs - pos.openedAtMs) / 1000),
    ok: sell.ok,
    sellReason: sell.reason ?? null,
    signature: sell.signature ?? null,
    mode: cfg.executionMode,
  });

  if (sell.ok) {
    // Re-read — another path must not have already cleared it.
    if (state.open[mint]) {
      delete state.open[mint];
      state.cooldownUntilMs[mint] = nowMs + cfg.mintCooldownMs;
      saveMildDipState(cfg.statePath, state);
    }
    console.log(
      `[mild-dip] SELL ${pos.symbol} reason=${decision.reason} pnl=${(sell.pnlPct ?? decision.pnlPct).toFixed(1)}% ` +
        `mfe=${decision.mfePct.toFixed(1)}% giveback=${decision.givebackPct.toFixed(1)}% mode=${cfg.executionMode}`,
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
      state.cooldownUntilMs[mint] = nowMs + cfg.mintCooldownMs;
      saveMildDipState(cfg.statePath, state);
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_drop_empty',
      mint,
      symbol: pos.symbol,
      exitReason: decision.reason,
      pnlPct: +(sell.pnlPct ?? decision.pnlPct).toFixed(2),
    });
    console.warn(`[mild-dip] DROP empty bag ${pos.symbol} mint=${mint.slice(0, 8)}…`);
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

  const markRows = await mapPool(ordered, cfg.markConcurrency, async (mint) => {
    const px = await markPriceUsd(mint, nowMs);
    return { mint, px };
  });

  const toSell: MarkExitDecision[] = [];
  for (const { mint, px } of markRows) {
    if (px == null) continue;
    const pos = state.open[mint];
    if (!pos || sellInFlight.has(mint)) continue;
    const decision = decideMarkExit({
      mint,
      pos,
      markPriceUsd: px,
      gates: cfg.exit,
    });
    if (!decision) continue;

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

export type MildDipLoopStats = {
  open: number;
  lastScanAtMs: number | null;
  lastMarkAtMs: number | null;
  mode: string;
  hotMints: number;
  stream: boolean;
};

export async function runMildDipLoop(
  cfg: MildDipConfig,
  opts?: { once?: boolean; signal?: AbortSignal },
): Promise<void> {
  const state = loadMildDipState(cfg.statePath);
  const stats: MildDipLoopStats = {
    open: openCount(state),
    lastScanAtMs: null,
    lastMarkAtMs: null,
    mode: cfg.executionMode,
    hotMints: 0,
    stream: false,
  };

  let streamHandle: { stop: () => void } | null = null;
  if (cfg.streamEnabled) {
    streamHandle = startMildDipHotMintStream({
      wsUrl: cfg.streamWsUrl || null,
    });
    stats.stream = streamHandle != null;
  }

  console.log(
    `[mild-dip] start mode=${cfg.executionMode} positionUsd=${cfg.positionUsd} quote=USDC ` +
      `entry=(${cfg.entry.minDipPct},${cfg.entry.maxDipPct}] ` +
      `exit=W9.1 arm=${cfg.exit.armPct}% giveback=${cfg.exit.givebackPct}% ` +
      `markConc=${cfg.markConcurrency} sellConc=${cfg.sellConcurrency} ` +
      `stream=${stats.stream} prebuy=${cfg.preBuyRevalidate} maxChasePct=${cfg.maxChasePct} ` +
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

    if (nowMs - lastMark >= cfg.markIntervalMs || openCount(state) > 0) {
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
    }

    stats.open = openCount(state);
    stats.hotMints = mildDipHotMints.size(nowMs);
  };

  if (opts?.once) {
    await tick();
    streamHandle?.stop();
    return;
  }

  // Expose stats for heartbeat via closure property.
  (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats = stats;

  const onAbort = (): void => {
    streamHandle?.stop();
    streamHandle = null;
  };
  opts?.signal?.addEventListener('abort', onAbort, { once: true });

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
  streamHandle?.stop();
}

export function mildDipLoopStats(): MildDipLoopStats | null {
  return (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats ?? null;
}
