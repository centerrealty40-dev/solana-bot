import type { TxJsonParsed } from '../parser/rpc-http.js';
import { decodeAllowlistedDexSwapForWallet } from '../parser/allowlisted-dex-swap.js';
import { decodePumpfunSwap, PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import type { SwapInsert } from '../parser/pumpfun.js';
import type { CopyTraderConfig } from './config.js';
import { fetchDexInfo } from './dex-info.js';
import { evaluateCopyEntry } from './evaluate.js';
import { appendCopyEvent, executeCopyBuy, executeCopySell } from './executor.js';
import { fetchParsedTransaction, fetchWalletSignatures, type SignatureRow } from './rpc.js';
import {
  canScheduleAdd,
  gcSeenSignatures,
  hasPendingBuyForMint,
  hasPendingSellForMint,
  newId,
  openPositionsCount,
  readCopyTraderState,
  writeCopyTraderState,
  type CopyTraderState,
  type PendingBuy,
  type PendingSell,
} from './state.js';
import { fmtCopyAlert, notifyCopyTraderTelegram } from './telegram.js';
import { fetchJupiterTokenUsdPrice, getSolUsd, refreshSolPrice } from '../papertrader/pricing.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function randomSellDelayMs(cfg: CopyTraderConfig): number {
  const span = cfg.sellDelayMaxMs - cfg.sellDelayMinMs;
  if (span <= 0) return cfg.sellDelayMinMs;
  return cfg.sellDelayMinMs + Math.floor(Math.random() * (span + 1));
}

function decodeSwapForWallet(tx: TxJsonParsed, wallet: string, solUsd: number): SwapInsert | null {
  const pf = decodePumpfunSwap(tx, PUMP_FUN_PROGRAM_ID, solUsd).find((s) => s.wallet === wallet);
  if (pf) return pf;
  return decodeAllowlistedDexSwapForWallet(tx, wallet, solUsd);
}

async function resolveCurrentPrice(mint: string, dexPrice: number): Promise<number> {
  if (dexPrice > 0) return dexPrice;
  const jup = await fetchJupiterTokenUsdPrice(mint);
  return jup ?? 0;
}

export async function pollLeaderWallet(cfg: CopyTraderConfig, state: CopyTraderState): Promise<void> {
  const rows = await fetchWalletSignatures(cfg.rpcUrl, cfg.targetWallet, cfg.signatureLimit);
  if (rows.length === 0) return;

  const latest = rows[0]!.signature;
  const prev = state.lastSignature;
  if (!prev) {
    state.lastSignature = latest;
    for (const row of rows) state.seenSignatures[row.signature] = Date.now();
    return;
  }

  const newRows: SignatureRow[] = [];
  for (const row of rows) {
    if (row.signature === prev) break;
    if (state.seenSignatures[row.signature]) continue;
    newRows.push(row);
  }
  state.lastSignature = latest;
  newRows.reverse();

  for (const row of newRows) {
    state.seenSignatures[row.signature] = Date.now();
    const raw = await fetchParsedTransaction(cfg.rpcUrl, row.signature);
    if (!raw) continue;
    const tx = raw as TxJsonParsed;
    const swap = decodeSwapForWallet(tx, cfg.targetWallet, getSolUsd());
    if (!swap || swap.priceUsd <= 0) continue;

    const dex = await fetchDexInfo(swap.baseMint, getSolUsd());
    const symbol = dex?.symbol ?? swap.baseMint.slice(0, 6);

    if (swap.side === 'buy') {
      await onLeaderBuy(cfg, state, swap, symbol, row);
    } else {
      await onLeaderSell(cfg, state, swap, symbol, row);
    }
    await sleep(120);
  }
}

async function onLeaderBuy(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  swap: SwapInsert,
  symbol: string,
  row: SignatureRow,
): Promise<void> {
  const mint = swap.baseMint;
  const existing = state.positions[mint];

  if (existing) {
    if (hasPendingBuyForMint(state, mint)) return;
    if (!canScheduleAdd(cfg, existing)) {
      appendCopyEvent(cfg, {
        kind: 'leader_add_ignored',
        reason: 'max_position_or_adds',
        mint,
        leaderSignature: row.signature,
        positionUsd: existing.sizeUsd,
      });
      return;
    }
    await schedulePendingBuy(cfg, state, {
      mint,
      symbol,
      kind: 'add',
      sizeUsd: cfg.addPositionUsd,
      swap,
      row,
    });
    return;
  }

  if (hasPendingBuyForMint(state, mint)) return;
  if (openPositionsCount(state) >= cfg.maxOpenPositions) {
    appendCopyEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'max_open_positions',
      mint,
      leaderSignature: row.signature,
    });
    return;
  }

  await schedulePendingBuy(cfg, state, {
    mint,
    symbol,
    kind: 'entry',
    sizeUsd: cfg.positionUsd,
    swap,
    row,
  });
}

async function schedulePendingBuy(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  args: {
    mint: string;
    symbol: string;
    kind: 'entry' | 'add';
    sizeUsd: number;
    swap: SwapInsert;
    row: SignatureRow;
  },
): Promise<void> {
  const { mint, symbol, kind, sizeUsd, swap, row } = args;
  const dueTs = Date.now() + cfg.buyDelayMs;
  const pending: PendingBuy = {
    id: newId('pb'),
    mint,
    symbol,
    kind,
    sizeUsd,
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderBuyUsd: swap.amountUsd,
    leaderBuyTs: (row.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
    dueTs,
  };
  state.pendingBuys.push(pending);

  appendCopyEvent(cfg, {
    kind: kind === 'add' ? 'leader_add_scheduled' : 'leader_buy_scheduled',
    mint,
    symbol,
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderBuyUsd: swap.amountUsd,
    buyDueTs: dueTs,
    buyDelayMs: cfg.buyDelayMs,
    sizeUsd,
  });

  await notifyCopyTraderTelegram(
    cfg,
    fmtCopyAlert({
      action: 'leader_buy',
      mint,
      symbol,
      wallet: cfg.targetWallet,
      priceUsd: swap.priceUsd,
      detail:
        kind === 'add'
          ? `Add $${sizeUsd} queued in ${Math.round(cfg.buyDelayMs / 60_000)} min if price holds`
          : `Buy $${sizeUsd} queued in ${Math.round(cfg.buyDelayMs / 60_000)} min if price holds`,
    }),
  );
}

async function onLeaderSell(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  swap: SwapInsert,
  symbol: string,
  row: SignatureRow,
): Promise<void> {
  const mint = swap.baseMint;
  if (!state.positions[mint] || hasPendingSellForMint(state, mint)) return;

  const delayMs = randomSellDelayMs(cfg);
  const pending: PendingSell = {
    id: newId('ps'),
    mint,
    symbol,
    leaderSignature: row.signature,
    leaderSellTs: (row.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
    dueTs: Date.now() + delayMs,
    fraction: 1,
  };
  state.pendingSells.push(pending);

  appendCopyEvent(cfg, {
    kind: 'leader_sell_scheduled',
    mint,
    symbol,
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    sellDueTs: pending.dueTs,
    sellDelayMs: delayMs,
  });

  await notifyCopyTraderTelegram(
    cfg,
    fmtCopyAlert({
      action: 'leader_sell',
      mint,
      symbol,
      wallet: cfg.targetWallet,
      priceUsd: swap.priceUsd,
      detail: `Our sell in ~${Math.round(delayMs / 1000)}s (stealth delay)`,
    }),
  );
}

export async function processPendingBuys(cfg: CopyTraderConfig, state: CopyTraderState): Promise<void> {
  const now = Date.now();
  const due = state.pendingBuys.filter((p) => p.dueTs <= now);
  if (due.length === 0) return;

  for (const pending of due) {
    state.pendingBuys = state.pendingBuys.filter((p) => p.id !== pending.id);
    const existing = state.positions[pending.mint];

    if (pending.kind === 'entry') {
      if (existing) continue;
      if (openPositionsCount(state) >= cfg.maxOpenPositions) {
        appendCopyEvent(cfg, { kind: 'buy_skipped', reason: 'max_open_positions', mint: pending.mint });
        continue;
      }
    } else if (!existing) {
      appendCopyEvent(cfg, { kind: 'buy_skipped', reason: 'no_open_position_for_add', mint: pending.mint });
      continue;
    } else if (!canScheduleAdd(cfg, existing)) {
      appendCopyEvent(cfg, { kind: 'buy_skipped', reason: 'max_position_or_adds', mint: pending.mint });
      continue;
    }

    const dex = await fetchDexInfo(pending.mint, getSolUsd());
    const currentPrice = await resolveCurrentPrice(pending.mint, dex?.priceUsd ?? 0);
    const evalResult = evaluateCopyEntry(cfg, {
      mint: pending.mint,
      leaderPriceUsd: pending.leaderPriceUsd,
      leaderBuyUsd: pending.leaderBuyUsd,
      currentPriceUsd: currentPrice,
      dex,
      nowMs: now,
    });

    if (!evalResult.pass) {
      appendCopyEvent(cfg, {
        kind: pending.kind === 'add' ? 'add_skipped' : 'buy_skipped',
        mint: pending.mint,
        symbol: pending.symbol,
        leaderSignature: pending.leaderSignature,
        leaderPriceUsd: pending.leaderPriceUsd,
        currentPriceUsd: currentPrice,
        eval: evalResult,
      });
      await notifyCopyTraderTelegram(
        cfg,
        fmtCopyAlert({
          action: 'skip',
          mint: pending.mint,
          symbol: pending.symbol,
          wallet: cfg.targetWallet,
          priceUsd: currentPrice,
          detail: evalResult.reasons.join(', '),
        }),
      );
      continue;
    }

    const exec = await executeCopyBuy({
      cfg,
      mint: pending.mint,
      symbol: pending.symbol,
      priceUsd: currentPrice,
      sizeUsd: pending.sizeUsd,
      kind: pending.kind,
      evalResult,
      leaderSignature: pending.leaderSignature,
    });
    if (!exec.ok) continue;

    if (pending.kind === 'entry' || !existing) {
      state.positions[pending.mint] = {
        mint: pending.mint,
        symbol: pending.symbol,
        entryTs: Date.now(),
        entryPriceUsd: currentPrice,
        sizeUsd: pending.sizeUsd,
        addCount: 0,
        leaderWallet: cfg.targetWallet,
        leaderEntrySig: pending.leaderSignature,
        ourEntrySig: exec.signature,
      };
    } else {
      const prev = existing;
      const newSize = prev.sizeUsd + pending.sizeUsd;
      const newAvg =
        newSize > 0
          ? (prev.entryPriceUsd * prev.sizeUsd + currentPrice * pending.sizeUsd) / newSize
          : currentPrice;
      state.positions[pending.mint] = {
        ...prev,
        entryPriceUsd: newAvg,
        sizeUsd: newSize,
        addCount: prev.addCount + 1,
      };
    }

    await notifyCopyTraderTelegram(
      cfg,
      fmtCopyAlert({
        action: 'our_buy',
        mint: pending.mint,
        symbol: pending.symbol,
        wallet: cfg.targetWallet,
        priceUsd: currentPrice,
        detail: `${pending.kind === 'add' ? 'Add' : 'Entry'} $${pending.sizeUsd} · score ${evalResult.score}`,
      }),
    );
    await sleep(150);
  }
}

export async function processPendingSells(cfg: CopyTraderConfig, state: CopyTraderState): Promise<void> {
  const now = Date.now();
  const due = state.pendingSells.filter((p) => p.dueTs <= now);
  if (due.length === 0) return;

  for (const pending of due) {
    state.pendingSells = state.pendingSells.filter((p) => p.id !== pending.id);
    const pos = state.positions[pending.mint];
    if (!pos) continue;

    const dex = await fetchDexInfo(pending.mint, getSolUsd());
    const exitPrice = await resolveCurrentPrice(pending.mint, dex?.priceUsd ?? 0);
    const sellDelayMs = Math.max(0, pending.dueTs - pending.leaderSellTs);

    const exec = await executeCopySell({
      cfg,
      mint: pending.mint,
      symbol: pending.symbol,
      entryPriceUsd: pos.entryPriceUsd,
      exitPriceUsd: exitPrice,
      sizeUsd: pos.sizeUsd,
      leaderSignature: pending.leaderSignature,
      sellDelayMs,
    });

    delete state.positions[pending.mint];

    if (exec.ok) {
      await notifyCopyTraderTelegram(
        cfg,
        fmtCopyAlert({
          action: 'our_sell',
          mint: pending.mint,
          symbol: pending.symbol,
          wallet: cfg.targetWallet,
          priceUsd: exitPrice,
          detail: `PnL ${exec.pnlPct != null ? `${exec.pnlPct >= 0 ? '+' : ''}${exec.pnlPct.toFixed(1)}%` : 'n/a'} · delay ${Math.round(sellDelayMs / 1000)}s`,
        }),
      );
    }
    await sleep(150);
  }
}

export async function runCopyTraderLoop(cfg: CopyTraderConfig): Promise<void> {
  const state = readCopyTraderState(cfg.statePath);
  let lastPoll = 0;
  let lastSolRefresh = 0;

  console.log('[copy-trader] started', {
    target: cfg.targetWallet,
    mode: cfg.executionMode,
    entryUsd: cfg.positionUsd,
    addUsd: cfg.addPositionUsd,
    maxPositionUsd: cfg.maxPositionUsd,
    buyDelayMin: Math.round(cfg.buyDelayMs / 60_000),
    sellDelaySec: `${Math.round(cfg.sellDelayMinMs / 1000)}-${Math.round(cfg.sellDelayMaxMs / 1000)}`,
    isolated: true,
  });

  for (;;) {
    const now = Date.now();
    if (now - lastSolRefresh > 120_000) {
      await refreshSolPrice();
      lastSolRefresh = now;
    }

    if (now - lastPoll >= cfg.pollIntervalMs) {
      try {
        await pollLeaderWallet(cfg, state);
        gcSeenSignatures(state, 48 * 3600_000);
        writeCopyTraderState(cfg.statePath, state);
      } catch (err) {
        console.warn('[copy-trader] poll error', (err as Error).message);
      }
      lastPoll = now;
    }

    try {
      await processPendingBuys(cfg, state);
      await processPendingSells(cfg, state);
      writeCopyTraderState(cfg.statePath, state);
    } catch (err) {
      console.warn('[copy-trader] tick error', (err as Error).message);
    }

    await sleep(cfg.tickIntervalMs);
  }
}
