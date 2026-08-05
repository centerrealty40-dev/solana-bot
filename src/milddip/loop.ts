import { executeCopyBuy, executeCopySell } from '../copytrader/executor.js';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import { collectCandidateMints, enrichAndFilterCandidates } from './discover.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import { evaluateMildDipExit } from './gates.js';
import {
  appendMildDipJournal,
  loadMildDipState,
  saveMildDipState,
  type MildDipState,
} from './state.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

async function tryEntries(cfg: MildDipConfig, state: MildDipState, nowMs: number): Promise<void> {
  const slots = cfg.maxOpenPositions - openCount(state);
  if (slots <= 0) return;

  const mints = await collectCandidateMints(cfg);
  const candidates = await enrichAndFilterCandidates(cfg, mints, { nowMs, maxEnrich: 40 });
  const copyCfg = mildDipToCopyTraderConfig(cfg);

  let filled = 0;
  for (const c of candidates) {
    if (filled >= slots) break;
    if (state.open[c.mint]) continue;
    if (onCooldown(state, c.mint, nowMs)) continue;

    const leaderSig = `milddip_${c.mint.slice(0, 8)}_${nowMs}`;
    const buy = await executeCopyBuy({
      cfg: copyCfg,
      mint: c.mint,
      symbol: c.symbol,
      priceUsd: c.priceUsd,
      sizeUsd: cfg.positionUsd,
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
      sizeUsd: cfg.positionUsd,
      priceUsd: buy.priceUsd || c.priceUsd,
      pc5m: c.metrics.priceChange5mPct,
      ok: buy.ok,
      reason: buy.reason ?? null,
      signature: buy.signature ?? null,
      mode: cfg.executionMode,
    });

    if (!buy.ok) {
      state.cooldownUntilMs[c.mint] = nowMs + Math.min(cfg.mintCooldownMs, 120_000);
      continue;
    }

    state.open[c.mint] = {
      mint: c.mint,
      symbol: c.symbol,
      entryPriceUsd: buy.priceUsd || c.priceUsd,
      sizeUsd: cfg.positionUsd,
      tokenRaw: buy.tokenRaw ?? null,
      openedAtMs: nowMs,
      entryPc5mPct: c.metrics.priceChange5mPct,
      buySignature: buy.signature ?? null,
    };
    filled += 1;
    console.log(
      `[mild-dip] BUY ${c.symbol} mint=${c.mint.slice(0, 8)}… pc5m=${c.metrics.priceChange5mPct?.toFixed(1)} @$${
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
      tokenRawBase: pos.tokenRaw ?? undefined,
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
  };

  console.log(
    `[mild-dip] start mode=${cfg.executionMode} positionUsd=${cfg.positionUsd} quote=USDC ` +
      `entry=(${cfg.entry.minDipPct},${cfg.entry.maxDipPct}] tp=${cfg.exit.tpGainPct}% ` +
      `timeStopMs=${cfg.exit.timeStopMs} wallet=${cfg.walletPubkeyExpected ?? 'n/a'}`,
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
  };

  if (opts?.once) {
    await tick();
    return;
  }

  // Expose stats for heartbeat via closure property.
  (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats = stats;

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
}

export function mildDipLoopStats(): MildDipLoopStats | null {
  return (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats ?? null;
}
