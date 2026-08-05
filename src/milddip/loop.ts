import { executeCopyBuy, executeCopySell } from '../copytrader/executor.js';
import {
  checkCopyFundingGate,
  resetCopyFundingCache,
} from '../copytrader/funding-gate.js';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import { collectCandidateMints, enrichAndFilterCandidates } from './discover.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import { evaluateMildDipExit } from './gates.js';
import { mildDipHotMints } from './hot-mints.js';
import {
  appendMildDipJournal,
  loadMildDipState,
  saveMildDipState,
  type MildDipState,
} from './state.js';
import { startMildDipHotMintStream } from './stream.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Floor for a last partial clip when draining the wallet. */
const MIN_CLIP_USD = 1;

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

    const leaderSig = `milddip_${c.mint.slice(0, 8)}_${nowMs}`;
    const buy = await executeCopyBuy({
      cfg: copyCfg,
      mint: c.mint,
      symbol: c.symbol,
      priceUsd: c.priceUsd,
      sizeUsd: sized.sizeUsd,
      kind: 'entry',
      evalResult: {
        pass: true,
        reasons: [
          `mild_dip_pc5m=${c.metrics.priceChange5mPct?.toFixed(2) ?? 'n/a'}`,
        ],
        score: Math.abs(c.metrics.priceChange5mPct ?? 0),
      },
      leaderSignature: leaderSig,
      leaderPriceUsd: 0,
      leaderBuyTs: nowMs,
    });

    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_buy_attempt',
      mint: c.mint,
      symbol: c.symbol,
      sizeUsd: sized.sizeUsd,
      priceUsd: buy.priceUsd || c.priceUsd,
      pc5m: c.metrics.priceChange5mPct,
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

    state.open[c.mint] = {
      mint: c.mint,
      symbol: c.symbol,
      entryPriceUsd: buy.priceUsd || c.priceUsd,
      sizeUsd: sized.sizeUsd,
      tokenRaw: buy.tokenRaw ?? null,
      openedAtMs: nowMs,
      entryPc5mPct: c.metrics.priceChange5mPct,
      buySignature: buy.signature ?? null,
    };
    filled += 1;
    resetCopyFundingCache();
    console.log(
      `[mild-dip] BUY ${c.symbol} mint=${c.mint.slice(0, 8)}… $${sized.sizeUsd} pc5m=${c.metrics.priceChange5mPct?.toFixed(1)} @$${
        (buy.priceUsd || c.priceUsd).toPrecision(4)
      } mode=${cfg.executionMode}`,
    );
  }
}

async function tryExits(cfg: MildDipConfig, state: MildDipState, nowMs: number): Promise<void> {
  const copyCfg = mildDipToCopyTraderConfig(cfg);
  const mints = Object.keys(state.open);
  for (const mint of mints) {
    const pos = state.open[mint];
    if (!pos) continue;
    const mark = await markPriceUsd(mint, nowMs);
    if (mark == null) continue;

    const verdict = evaluateMildDipExit({
      entryPriceUsd: pos.entryPriceUsd,
      markPriceUsd: mark,
      openedAtMs: pos.openedAtMs,
      nowMs,
      gates: cfg.exit,
    });
    if (!verdict.shouldExit || !verdict.reason) continue;

    // Dedicated wallet: sell on-chain balance (omit stale quote tokenRaw → 6024).
    const sell = await executeCopySell({
      cfg: copyCfg,
      mint,
      symbol: pos.symbol,
      entryPriceUsd: pos.entryPriceUsd,
      exitPriceUsd: mark,
      sizeUsd: pos.sizeUsd,
      fraction: 1,
      leaderSignature: `milddip_exit_${verdict.reason}_${nowMs}`,
      sellDelayMs: 0,
    });

    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_sell',
      mint,
      symbol: pos.symbol,
      reason: verdict.reason,
      entryPriceUsd: pos.entryPriceUsd,
      exitPriceUsd: sell.priceUsd || mark,
      pnlPct: +(sell.pnlPct ?? verdict.pnlPct).toFixed(2),
      ok: sell.ok,
      sellReason: sell.reason ?? null,
      signature: sell.signature ?? null,
      holdMs: nowMs - pos.openedAtMs,
      mode: cfg.executionMode,
    });

    if (sell.ok) {
      delete state.open[mint];
      state.cooldownUntilMs[mint] = nowMs + cfg.mintCooldownMs;
      console.log(
        `[mild-dip] SELL ${pos.symbol} reason=${verdict.reason} pnl=${(sell.pnlPct ?? verdict.pnlPct).toFixed(1)}% mode=${cfg.executionMode}`,
      );
    } else {
      console.warn(`[mild-dip] sell failed ${mint.slice(0, 8)}…: ${sell.reason ?? 'unknown'}`);
    }
  }
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
      `entry=(${cfg.entry.minDipPct},${cfg.entry.maxDipPct}] tp=${cfg.exit.tpGainPct}% ` +
      `timeStopMs=${cfg.exit.timeStopMs} stream=${stats.stream} ` +
      `sources=${cfg.discoverSources} wallet=${cfg.walletPubkeyExpected ?? 'n/a'}`,
  );

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
