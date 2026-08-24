import { getSolUsd } from '../papertrader/pricing.js';
import { jupiterQuoteSellPriceUsd } from '../papertrader/pricing/price-verify.js';
import { executeCopySell } from '../copytrader/executor.js';
import { closeEmptyAtas } from './close-empty-ata.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import { listOrphanTokenAccounts, type OrphanAtaRow } from './orphan-janitor.js';
import { appendMildDipJournal, type MildDipState } from './state.js';
import { appendTradeJournal } from './trade-journal.js';
import type { MildDipConfig } from './config.js';

type Quote = { ok: boolean; usd: number };
type Deps = {
  list?: typeof listOrphanTokenAccounts;
  quote?: (row: OrphanAtaRow) => Promise<Quote>;
  sell?: typeof executeCopySell;
  close?: typeof closeEmptyAtas;
};

function recentEntry(state: MildDipState, mint: string): number {
  return (state.recentEntryMsByMint?.[mint] ?? []).reduce(
    (latest, value) => Math.max(latest, Number(value)),
    0,
  );
}

function watched(state: MildDipState, mint: string, nowMs: number): boolean {
  return Object.values(state.leaderMirrorWatches ?? {}).some(
    (watch) => watch.hit.mint === mint && watch.expiresAtMs > nowMs,
  );
}

async function quote(row: OrphanAtaRow): Promise<Quote> {
  const solUsd = getSolUsd();
  const amount = Number(row.amountRaw) / 10 ** Math.max(0, row.decimals);
  if (!(solUsd > 0) || !(amount > 0) || !Number.isFinite(amount)) return { ok: false, usd: 0 };
  const verdict = await jupiterQuoteSellPriceUsd({
    mint: row.mint,
    tokenDecimals: row.decimals,
    usdNotional: amount,
    solUsd,
    snapshotPriceUsd: 1,
    slippageBps: 150,
    timeoutMs: 4_000,
  });
  if (verdict.kind !== 'ok' || !(verdict.jupiterPriceUsd > 0)) return { ok: false, usd: 0 };
  const usd = verdict.jupiterPriceUsd * amount;
  return Number.isFinite(usd) ? { ok: true, usd } : { ok: false, usd: 0 };
}

export type OrphanSellResult = {
  candidates: number;
  sold: number;
  failed: number;
  skipped: number;
};

export async function sellOrphanBalances(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  nowMs: number;
  maxSells?: number;
  deps?: Deps;
}): Promise<OrphanSellResult> {
  const { cfg, state, nowMs } = args;
  const empty = { candidates: 0, sold: 0, failed: 0, skipped: 0 };
  if (
    cfg.executionMode !== 'live' ||
    !cfg.orphanSellEnabled ||
    !cfg.walletSecret?.trim() ||
    !cfg.walletPubkeyExpected?.trim()
  ) return empty;
  const rows = await (args.deps?.list ?? listOrphanTokenAccounts)({
    rpcUrl: cfg.rpcUrl,
    owner: cfg.walletPubkeyExpected,
    protectMints: Object.keys(state.open ?? {}),
  });
  const result = { ...empty, candidates: rows.length };
  const max = args.maxSells ?? cfg.orphanSellMaxPerPass;
  for (const row of rows) {
    if (result.sold + result.failed >= max) {
      result.skipped += 1;
      continue;
    }
    const skip = (reason: string): void => {
      result.skipped += 1;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_orphan_sell_skip',
        mint: row.mint,
        tokenRaw: row.amountRaw,
        reason,
      });
    };
    if (state.open[row.mint]) {
      skip('open_position');
      continue;
    }
    if (
      recentEntry(state, row.mint) > 0 &&
      nowMs - recentEntry(state, row.mint) < cfg.dustBurnMinAgeMs
    ) {
      skip('fresh_entry');
      continue;
    }
    if (watched(state, row.mint, nowMs)) {
      skip('active_mirror_observation');
      continue;
    }
    const exit = state.lastExitByMint?.[row.mint]?.atMs ?? 0;
    if (exit > 0 && nowMs - exit < cfg.dustBurnSettleMs) {
      skip('recent_exit');
      continue;
    }
    let value: Quote;
    try {
      value = await (args.deps?.quote ?? quote)(row);
    } catch {
      skip('quote_unknown');
      continue;
    }
    if (!value.ok || value.usd < cfg.orphanSellMinUsd) {
      skip(value.ok ? 'below_min_usd' : 'quote_unknown');
      continue;
    }
    if (state.open[row.mint]) {
      skip('opened_during_scan');
      continue;
    }
    const symbol = row.mint.slice(0, 6);
    const sell = await (args.deps?.sell ?? executeCopySell)({
      cfg: mildDipToCopyTraderConfig(cfg),
      mint: row.mint,
      symbol,
      entryPriceUsd: 0,
      exitPriceUsd: 0,
      sizeUsd: value.usd,
      fraction: 1,
      leaderSignature: `milddip_orphan_sell_${nowMs}`,
      sellDelayMs: 0,
      tokenRawBase: row.amountRaw,
    });
    if (!sell.ok) {
      result.failed += 1;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_orphan_sell_fail',
        mint: row.mint,
        tokenRaw: row.amountRaw,
        quoteUsd: value.usd,
        error: sell.reason ?? 'sell_failed',
      });
      continue;
    }
    const close = await (args.deps?.close ?? closeEmptyAtas)({
      rpcUrl: cfg.rpcUrl,
      walletSecret: cfg.walletSecret,
      mint: row.mint,
    });
    result.sold += 1;
    appendTradeJournal(cfg.tradesPath, {
      kind: 'trade_fill',
      side: 'sell',
      mint: row.mint,
      symbol,
      tokenRaw: row.amountRaw,
      quoteReceivedUsd: sell.quoteReceivedUsd ?? value.usd,
      signature: sell.signature ?? null,
      source: 'milddip_orphan_sell',
    });
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_orphan_sold',
      mint: row.mint,
      tokenRaw: row.amountRaw,
      quoteUsd: value.usd,
      receivedUsd: sell.quoteReceivedUsd ?? value.usd,
      signature: sell.signature ?? null,
      reclaimedLamports: close.reclaimedLamports,
      reclaimedSol: close.reclaimedLamports / 1e9,
    });
  }
  return result;
}
