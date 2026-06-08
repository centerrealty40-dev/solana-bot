import type { PumpswapDipConfig } from './config.js';
import { executePumpswapDipBuy, executePumpswapDipSell } from './executor.js';
import { appendPumpswapDipEvent } from './journal.js';
import { isDumpInBand, RollingHighTracker } from './rolling.js';
import {
  canBuyMint,
  findPosition,
  openPositionCount,
  readPumpswapDipState,
  recordBuyAttempt,
  writePumpswapDipState,
  type PumpswapDipState,
} from './state.js';
import type { WatchlistRow } from './types.js';
import { fetchMintSpotPrice, fetchPumpswapWatchlist } from './watchlist.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function evaluateEntries(
  cfg: PumpswapDipConfig,
  state: PumpswapDipState,
  watchlist: WatchlistRow[],
  rolling: RollingHighTracker,
  nowMs: number,
): Promise<void> {
  if (openPositionCount(state) >= cfg.maxOpenPositions) return;

  for (const row of watchlist) {
    if (openPositionCount(state) >= cfg.maxOpenPositions) break;
    rolling.push(row.mint, row.snapshotTs, row.priceUsd);
    const dumpPct = rolling.dumpPct(row.mint, row.priceUsd);
    if (dumpPct == null) continue;
    if (!isDumpInBand(dumpPct, cfg.dumpMinPct, cfg.dumpMaxPct)) continue;
    if (!canBuyMint(state, cfg, row.mint, nowMs)) continue;

    const res = await executePumpswapDipBuy({
      cfg,
      mint: row.mint,
      symbol: row.symbol,
      priceUsd: row.priceUsd,
      sizeUsd: cfg.positionUsd,
      dumpPct,
    });
    if (!res.ok) {
      appendPumpswapDipEvent(cfg, {
        kind: 'signal_skip',
        mint: row.mint,
        symbol: row.symbol,
        reason: res.reason ?? 'buy_failed',
        dumpPct,
      });
      continue;
    }

    state.positions.push({
      mint: row.mint,
      symbol: row.symbol,
      entryTs: nowMs,
      entryPriceUsd: res.priceUsd,
      sizeUsd: cfg.positionUsd,
      tokenRaw: res.tokenRaw,
      txSignature: res.signature,
      dumpPctAtEntry: dumpPct,
    });
    recordBuyAttempt(state, row.mint, nowMs);
    writePumpswapDipState(cfg, state);
  }
}

async function evaluateExits(cfg: PumpswapDipConfig, state: PumpswapDipState): Promise<void> {
  const remaining: typeof state.positions = [];

  for (const pos of state.positions) {
    const px = (await fetchMintSpotPrice(pos.mint)) ?? pos.entryPriceUsd;
    const pnlPct = pos.entryPriceUsd > 0 ? ((px / pos.entryPriceUsd - 1) * 100) : 0;
    const hitTp = pnlPct >= cfg.takeProfitPct;
    const hitSl = cfg.stopLossPct > 0 && pnlPct <= -cfg.stopLossPct;

    if (!hitTp && !hitSl) {
      remaining.push(pos);
      continue;
    }

    const exitReason = hitTp ? 'take_profit' : 'stop_loss';
    const res = await executePumpswapDipSell({
      cfg,
      mint: pos.mint,
      symbol: pos.symbol,
      entryPriceUsd: pos.entryPriceUsd,
      exitPriceUsd: px,
      sizeUsd: pos.sizeUsd,
      exitReason,
      tokenRaw: pos.tokenRaw,
    });
    if (!res.ok) {
      remaining.push(pos);
      appendPumpswapDipEvent(cfg, {
        kind: 'exit_deferred',
        mint: pos.mint,
        symbol: pos.symbol,
        reason: res.reason ?? 'sell_failed',
        pnlPct,
      });
      continue;
    }
  }

  state.positions = remaining;
  writePumpswapDipState(cfg, state);
}

export async function runPumpswapDipLoop(cfg: PumpswapDipConfig): Promise<void> {
  const rolling = new RollingHighTracker(cfg.rollingHighWindowMs);
  let lastHeartbeat = 0;

  appendPumpswapDipEvent(cfg, {
    kind: 'boot',
    executionMode: cfg.executionMode,
    watchlistMax: cfg.watchlistMax,
    dumpBand: `${cfg.dumpMinPct}-${cfg.dumpMaxPct}%`,
    tpPct: cfg.takeProfitPct,
    slPct: cfg.stopLossPct,
  });

  console.log(
    `[pumpswap-dip] start mode=${cfg.executionMode} watchlist=${cfg.watchlistMax} poll=${cfg.pollIntervalMs}ms`,
  );

  for (;;) {
    const nowMs = Date.now();
    let state = readPumpswapDipState(cfg);

    try {
      const watchlist = await fetchPumpswapWatchlist(cfg);
      rolling.prune(new Set(watchlist.map((w) => w.mint)));
      for (const row of watchlist) {
        rolling.push(row.mint, row.snapshotTs, row.priceUsd);
      }

      await evaluateExits(cfg, state);
      state = readPumpswapDipState(cfg);
      await evaluateEntries(cfg, state, watchlist, rolling, nowMs);

      if (nowMs - lastHeartbeat >= cfg.heartbeatIntervalMs) {
        lastHeartbeat = nowMs;
        state = readPumpswapDipState(cfg);
        appendPumpswapDipEvent(cfg, {
          kind: 'heartbeat',
          openCount: openPositionCount(state),
          watchlistSize: watchlist.length,
          executionMode: cfg.executionMode,
        });
        console.log(
          `[pumpswap-dip] heartbeat open=${openPositionCount(state)} watchlist=${watchlist.length}`,
        );
      }
    } catch (err) {
      console.warn('[pumpswap-dip] tick error', (err as Error).message);
      appendPumpswapDipEvent(cfg, {
        kind: 'tick_error',
        error: (err as Error).message,
      });
    }

    await sleep(cfg.pollIntervalMs);
  }
}

export { findPosition };
