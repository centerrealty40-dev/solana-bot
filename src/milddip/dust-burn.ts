import {
  Connection,
  Keypair,
} from '@solana/web3.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { jupiterQuoteSellPriceUsd } from '../papertrader/pricing/price-verify.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import type { MildDipConfig } from './config.js';
import {
  burnAndCloseOne,
  listOrphanTokenAccounts,
  type OrphanAtaRow,
} from './orphan-janitor.js';
import { appendMildDipJournal, type MildDipState } from './state.js';

type DustBurnQuote = {
  kind: 'ok' | 'unroutable' | 'unknown';
  quoteUsd: number | null;
};

export type DustBurnResult = {
  candidates: number;
  burned: number;
  failed: number;
  skipped: number;
  reclaimedLamports: number;
};

type DustBurnDeps = {
  list?: typeof listOrphanTokenAccounts;
  quote?: (row: OrphanAtaRow) => Promise<DustBurnQuote>;
  burn?: typeof burnAndCloseOne;
  signer?: (secret: string) => Keypair;
};

function recentEntryAtMs(state: MildDipState, mint: string): number {
  const entries = state.recentEntryMsByMint?.[mint] ?? [];
  return entries.reduce((latest, atMs) => Math.max(latest, Number(atMs)), 0);
}

function mirrorObservationActive(state: MildDipState, mint: string, nowMs: number): boolean {
  return Object.values(state.leaderMirrorWatches ?? {}).some(
    (watch) =>
      watch.hit.mint === mint &&
      watch.expiresAtMs > nowMs &&
      watch.hit.lastSeenAtMs > 0 &&
      watch.hit.lastSeenAtMs <= nowMs,
  );
}

function skip(
  cfg: MildDipConfig,
  row: OrphanAtaRow,
  reason: string,
  nowMs: number,
): void {
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_dust_burn_skip',
    mint: row.mint,
    symbol: row.mint.slice(0, 6),
    reason,
    tokenRaw: row.amountRaw,
    nowMs,
  });
}

async function defaultQuote(row: OrphanAtaRow): Promise<DustBurnQuote> {
  const solUsd = getSolUsd();
  const tokenAmount = Number(row.amountRaw) / Math.pow(10, Math.max(0, row.decimals));
  if (!(solUsd > 0) || !(tokenAmount > 0) || !Number.isFinite(tokenAmount)) {
    return { kind: 'unknown', quoteUsd: null };
  }
  const verdict = await jupiterQuoteSellPriceUsd({
    mint: row.mint,
    tokenDecimals: row.decimals,
    usdNotional: tokenAmount,
    solUsd,
    snapshotPriceUsd: 1,
    slippageBps: 150,
    timeoutMs: 4_000,
  });
  if (verdict.kind === 'blocked' && verdict.reason === 'no-route') {
    return { kind: 'unroutable', quoteUsd: null };
  }
  if (verdict.kind !== 'ok' || !(verdict.jupiterPriceUsd > 0)) {
    return { kind: 'unknown', quoteUsd: null };
  }
  const quoteUsd = verdict.jupiterPriceUsd * tokenAmount;
  return Number.isFinite(quoteUsd)
    ? { kind: 'ok', quoteUsd }
    : { kind: 'unknown', quoteUsd: null };
}

export async function burnDustOrphans(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  nowMs: number;
  maxBurns?: number;
  deps?: DustBurnDeps;
}): Promise<DustBurnResult> {
  const { cfg, state, nowMs } = args;
  const empty: DustBurnResult = {
    candidates: 0,
    burned: 0,
    failed: 0,
    skipped: 0,
    reclaimedLamports: 0,
  };
  if (
    cfg.executionMode !== 'live' ||
    !cfg.dustBurnEnabled ||
    !cfg.walletSecret?.trim() ||
    !cfg.walletPubkeyExpected?.trim()
  ) {
    return empty;
  }

  let signer: Keypair;
  try {
    signer = (args.deps?.signer ?? loadLiveKeypairFromSecretEnv)(cfg.walletSecret);
  } catch {
    return empty;
  }
  if (signer.publicKey.toBase58() !== cfg.walletPubkeyExpected.trim()) return empty;

  const rows = await (args.deps?.list ?? listOrphanTokenAccounts)({
    rpcUrl: cfg.rpcUrl,
    owner: cfg.walletPubkeyExpected.trim(),
    protectMints: Object.keys(state.open ?? {}),
  });
  const maxBurns =
    args.maxBurns != null && args.maxBurns > 0
      ? Math.floor(args.maxBurns)
      : Math.max(0, Math.floor(cfg.dustBurnMaxPerPass));
  const result = { ...empty, candidates: rows.length };
  const settleMs = Math.max(0, cfg.dustBurnSettleMs);
  const minAgeMs = Math.max(0, cfg.dustBurnMinAgeMs);
  const quote = args.deps?.quote ?? defaultQuote;
  const connection = new Connection(cfg.rpcUrl, 'confirmed');

  for (const row of rows) {
    if (result.burned + result.failed >= maxBurns) {
      result.skipped += 1;
      skip(cfg, row, 'max_per_pass', nowMs);
      continue;
    }
    if (state.open[row.mint]) {
      result.skipped += 1;
      skip(cfg, row, 'open_position', nowMs);
      continue;
    }
    if (
      Object.values(state.open ?? {}).some(
        (pos) => pos.mint === row.mint && pos.mirrorLeaderSellIntent,
      )
    ) {
      result.skipped += 1;
      skip(cfg, row, 'leader_sell_intent', nowMs);
      continue;
    }
    const entryAtMs = recentEntryAtMs(state, row.mint);
    if (
      (entryAtMs > 0 && nowMs - entryAtMs < minAgeMs) ||
      mirrorObservationActive(state, row.mint, nowMs)
    ) {
      result.skipped += 1;
      skip(cfg, row, 'fresh_entry_or_observation', nowMs);
      continue;
    }
    const lastExitAtMs = state.lastExitByMint?.[row.mint]?.atMs ?? 0;
    if (lastExitAtMs > 0 && nowMs - lastExitAtMs < settleMs) {
      result.skipped += 1;
      skip(cfg, row, 'recent_exit_settling', nowMs);
      continue;
    }

    let valuation: DustBurnQuote;
    try {
      valuation = await quote(row);
    } catch {
      valuation = { kind: 'unknown', quoteUsd: null };
    }
    if (
      valuation.kind !== 'unroutable' &&
      !(
        valuation.kind === 'ok' &&
        valuation.quoteUsd != null &&
        valuation.quoteUsd < cfg.dustBurnMaxUsd
      )
    ) {
      result.skipped += 1;
      skip(cfg, row, 'value_unknown_or_above_max', nowMs);
      continue;
    }

    // Re-check immediately before signing: the position may have opened mid-pass.
    if (state.open[row.mint]) {
      result.skipped += 1;
      skip(cfg, row, 'open_position_before_send', nowMs);
      continue;
    }
    let one: Awaited<ReturnType<typeof burnAndCloseOne>>;
    try {
      one = await (args.deps?.burn ?? burnAndCloseOne)({
        connection,
        signer,
        row,
      });
    } catch (err) {
      one = {
        reclaimedLamports: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!one.signature) {
      result.failed += 1;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_dust_burn_fail',
        mint: row.mint,
        symbol: row.mint.slice(0, 6),
        error: one.error ?? 'unknown',
      });
      continue;
    }
    result.burned += 1;
    result.reclaimedLamports += Math.max(0, one.reclaimedLamports);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_dust_burned',
      mint: row.mint,
      symbol: row.mint.slice(0, 6),
      tokenRaw: row.amountRaw,
      quoteUsd: valuation.quoteUsd,
      signature: one.signature,
      reclaimedLamports: one.reclaimedLamports,
      reclaimedSol: one.reclaimedLamports / 1e9,
    });
    console.log(
      `[mild-dip] dustBurn burned ${row.mint.slice(0, 8)}… ` +
        `raw=${row.amountRaw} quoteUsd=${valuation.quoteUsd ?? 'n/a'} ` +
        `reclaimedSol=${(one.reclaimedLamports / 1e9).toFixed(6)} ` +
        `sig=${one.signature.slice(0, 12)}`,
    );
  }
  return result;
}
