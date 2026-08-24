/** Startup / periodic recovery of valuable token balances left after exits. */
import { executeCopySell, type SellExecutionResult } from '../copytrader/executor.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { jupiterQuoteSellPriceUsd } from '../papertrader/pricing/price-verify.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import type { MildDipConfig } from './config.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import { closeEmptyAtas, type CloseEmptyAtaResult } from './close-empty-ata.js';
import { listOrphanTokenAccounts, type OrphanAtaRow } from './orphan-janitor.js';
import { appendMildDipJournal, type MildDipState } from './state.js';
import { writeUsSellFill } from './trade-journal.js';
import { HOLDING_DUST_RAW } from './sell-empty-guard.js';

export type OrphanSweepResult = { candidates: number; sold: number; failed: number; skipped: number };
type Quote = { ok: boolean; usd: number };
type SweepDeps = {
  list?: typeof listOrphanTokenAccounts;
  quote?: (row: OrphanAtaRow) => Promise<Quote>;
  sell?: typeof executeCopySell;
  close?: typeof closeEmptyAtas;
  signer?: typeof loadLiveKeypairFromSecretEnv;
};

function recentEntry(state: MildDipState, mint: string): number {
  return (state.recentEntryMsByMint?.[mint] ?? []).reduce((a, b) => Math.max(a, Number(b)), 0);
}

function activeObservation(state: MildDipState, mint: string, nowMs: number): boolean {
  return Object.values(state.leaderMirrorWatches ?? {}).some(
    (watch) => watch.hit.mint === mint && watch.expiresAtMs > nowMs &&
      watch.hit.lastSeenAtMs > 0 && watch.hit.lastSeenAtMs <= nowMs,
  );
}

async function defaultQuote(row: OrphanAtaRow): Promise<Quote> {
  const solUsd = getSolUsd();
  const tokenAmount = Number(row.amountRaw) / Math.pow(10, Math.max(0, row.decimals));
  if (!(solUsd > 0) || !(tokenAmount > 0) || !Number.isFinite(tokenAmount)) return { ok: false, usd: 0 };
  const verdict = await jupiterQuoteSellPriceUsd({
    mint: row.mint, tokenDecimals: row.decimals, usdNotional: tokenAmount,
    solUsd, snapshotPriceUsd: 1, slippageBps: 150, timeoutMs: 4_000,
  });
  if (verdict.kind !== 'ok' || !(verdict.jupiterPriceUsd > 0)) return { ok: false, usd: 0 };
  const usd = verdict.jupiterPriceUsd * tokenAmount;
  return Number.isFinite(usd) ? { ok: true, usd } : { ok: false, usd: 0 };
}

export async function sweepUnmanagedPumpOrphans(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  maxSells?: number;
  nowMs?: number;
  deps?: SweepDeps;
}): Promise<OrphanSweepResult> {
  const { cfg, state } = args;
  const nowMs = args.nowMs ?? Date.now();
  const empty = { candidates: 0, sold: 0, failed: 0, skipped: 0 };
  const owner = cfg.walletPubkeyExpected?.trim();
  if (cfg.executionMode !== 'live' || !cfg.orphanSweepEnabled ||
      !cfg.walletSecret?.trim() || !owner) return empty;
  try {
    const signer = (args.deps?.signer ?? loadLiveKeypairFromSecretEnv)(cfg.walletSecret);
    if (signer.publicKey.toBase58() !== owner) return empty;
  } catch { return empty; }
  const rows = (await (args.deps?.list ?? listOrphanTokenAccounts)({
    rpcUrl: cfg.rpcUrl, owner, protectMints: Object.keys(state.open ?? {}),
  })).filter((row) => /^\d+$/.test(row.amountRaw) && BigInt(row.amountRaw) > HOLDING_DUST_RAW);
  const maxSells = args.maxSells && args.maxSells > 0 ? Math.floor(args.maxSells) : cfg.orphanSweepMaxSells;
  const result = { ...empty, candidates: rows.length };
  const copyCfg = mildDipToCopyTraderConfig(cfg);
  for (const [index, row] of rows.entries()) {
    const skip = (reason: string): void => {
      result.skipped += 1;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_orphan_sweep_skip', mint: row.mint, tokenRaw: row.amountRaw, reason,
      });
    };
    if (result.sold + result.failed >= maxSells) {
      result.skipped += rows.length - index;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_orphan_sweep_skip', reason: 'max_per_pass',
        skipped: rows.length - index, maxSells,
      });
      break;
    }
    if (state.open[row.mint]) { skip('open_position'); continue; }
    const entryAt = recentEntry(state, row.mint);
    if ((entryAt > 0 && nowMs - entryAt < cfg.dustBurnMinAgeMs) ||
        activeObservation(state, row.mint, nowMs)) {
      skip('fresh_entry_or_observation'); continue;
    }
    const exitAt = state.lastExitByMint?.[row.mint]?.atMs ?? 0;
    if (exitAt > 0 && nowMs - exitAt < cfg.dustBurnSettleMs) {
      skip('recent_exit_settling'); continue;
    }
    let valuation: Quote;
    try { valuation = await (args.deps?.quote ?? defaultQuote)(row); }
    catch { valuation = { ok: false, usd: 0 }; }
    if (!valuation.ok || valuation.usd < cfg.orphanSellMinUsd) {
      skip(valuation.ok ? 'below_min_usd' : 'quote_unknown'); continue;
    }
    if (state.open[row.mint]) { skip('open_position_before_send'); continue; }
    const symbol = row.mint.slice(0, 6);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_orphan_sweep_attempt', mint: row.mint, symbol,
      tokenRaw: row.amountRaw, quoteUsd: valuation.usd,
    });
    let res: SellExecutionResult;
    try {
      res = await (args.deps?.sell ?? executeCopySell)({
        cfg: copyCfg, mint: row.mint, symbol, entryPriceUsd: 0, exitPriceUsd: 0,
        sizeUsd: valuation.usd, fraction: 1,
        leaderSignature: `milddip_orphan_sweep_${nowMs}`, sellDelayMs: 0,
        tokenRawBase: row.amountRaw,
      });
    } catch (err) {
      res = { ok: false, priceUsd: 0, reason: String(err) };
    }
    if (!res.ok) {
      result.failed += 1;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_orphan_sweep_result', mint: row.mint, symbol, ok: false,
        reason: res.reason ?? 'sell_failed', signature: null,
      });
      continue;
    }
    let close: CloseEmptyAtaResult = { closed: 0, reclaimedLamports: 0, signatures: [], errors: [] };
    try {
      close = await (args.deps?.close ?? closeEmptyAtas)({
        rpcUrl: cfg.rpcUrl, walletSecret: cfg.walletSecret, mint: row.mint,
      });
    } catch { /* residual balance or close failure does not undo the sale */ }
    writeUsSellFill({
      tradesPath: cfg.tradesPath, wallet: owner, mint: row.mint, symbol, ok: true,
      signature: res.signature ?? null, sizeUsdIntent: valuation.usd, fraction: 1,
      usdcBefore: res.usdcBefore, usdcAfter: res.usdcAfter,
      feeSolBefore: res.feeSolBefore, feeSolAfter: res.feeSolAfter,
      quoteReceivedUsd: res.quoteReceivedUsd ?? valuation.usd, fillPriceUsd: res.priceUsd,
      reason: 'mild_dip_orphan_sweep', nowMs,
    });
    result.sold += 1;
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_orphan_sweep_result', mint: row.mint, symbol, ok: true,
      reason: null, signature: res.signature ?? null, quoteUsd: valuation.usd,
      receivedUsd: res.quoteReceivedUsd ?? valuation.usd,
      reclaimedLamports: close.reclaimedLamports,
    });
  }
  return result;
}
