import { getSolUsd } from '../papertrader/pricing.js';
import { jupiterQuoteSellPriceUsd } from '../papertrader/pricing/price-verify.js';
import type { PriceVerifyVerdict } from '../papertrader/types.js';
import { mildDipPriceRing } from './price-ring.js';
import { appendMildDipJournal, saveMildDipState, type MildDipState } from './state.js';
import { writeUsSellFill } from './trade-journal.js';
import { confirmUnroutableRoute } from './unroutable-route.js';
import type { MildDipConfig } from './config.js';

type WriteoffDeps = {
  quote?: (args: {
    mint: string;
    tokenRaw: string;
    tokenDecimals: number;
  }) => Promise<PriceVerifyVerdict>;
  sleep?: (ms: number) => Promise<void>;
};

export type UnroutableWriteoffResult = {
  checked: number;
  markedNoRoute: number;
  wroteOff: number;
  skipped: number;
};

function defaultQuote(args: {
  mint: string;
  tokenRaw: string;
  tokenDecimals: number;
}): Promise<PriceVerifyVerdict> {
  const solUsd = getSolUsd();
  const tokenAmount = Number(args.tokenRaw) / Math.pow(10, Math.max(0, args.tokenDecimals));
  if (!(solUsd > 0) || !(tokenAmount > 0) || !Number.isFinite(tokenAmount)) {
    return Promise.resolve({ kind: 'skipped', reason: 'parse-error', ts: Date.now() });
  }
  return jupiterQuoteSellPriceUsd({
    mint: args.mint,
    tokenDecimals: args.tokenDecimals,
    usdNotional: tokenAmount,
    solUsd,
    snapshotPriceUsd: 1,
    slippageBps: 150,
    timeoutMs: 4_000,
  });
}

export async function writeOffUnroutableBags(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  nowMs: number;
  deps?: WriteoffDeps;
}): Promise<UnroutableWriteoffResult> {
  const empty = { checked: 0, markedNoRoute: 0, wroteOff: 0, skipped: 0 };
  const { cfg, state, nowMs } = args;
  if (!cfg.unroutableWriteoffEnabled) return empty;
  const lastAt = state.lastUnroutableWriteoffAtMs ?? 0;
  if (lastAt > 0 && nowMs - lastAt < cfg.unroutableWriteoffIntervalMs) return empty;
  state.lastUnroutableWriteoffAtMs = nowMs;

  const sleep =
    args.deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const quote = args.deps?.quote ?? defaultQuote;
  const result = { ...empty, checked: Object.keys(state.open ?? {}).length };
  const observations = state.unroutableByMint ?? (state.unroutableByMint = {});
  const maxPerPass = Math.max(0, Math.floor(cfg.unroutableWriteoffMaxPerPass));

  for (const [mint, position] of Object.entries(state.open ?? {})) {
    const tokenRaw = position.tokenRaw;
    if (!tokenRaw || !/^\d+$/.test(tokenRaw) || BigInt(tokenRaw) <= 0n) {
      result.skipped += 1;
      continue;
    }
    const tokenDecimals = mildDipPriceRing.mintDecimals(mint);
    if (tokenDecimals == null) {
      result.skipped += 1;
      continue;
    }
    const worthlessMaxUsd = cfg.worthlessWriteoffMaxUsd;
    const isWorthless =
      worthlessMaxUsd > 0
        ? (value: PriceVerifyVerdict) => {
            if (value.kind !== 'ok') return false;
            const tokenAmount = Number(tokenRaw) / Math.pow(10, tokenDecimals);
            const valueUsd = value.jupiterPriceUsd * tokenAmount;
            return Number.isFinite(valueUsd) && valueUsd <= worthlessMaxUsd;
          }
        : undefined;
    const probe = await confirmUnroutableRoute({
      quote: () =>
        quote({
          mint,
          tokenRaw,
          tokenDecimals,
        }),
      sleep,
      isWorthless,
    });
    if (probe.status === 'routable') {
      delete observations[mint];
      continue;
    }
    if (probe.status !== 'unroutable' && probe.status !== 'worthless') {
      result.skipped += 1;
      continue;
    }
    result.markedNoRoute += 1;
    const previous = observations[mint];
    const observed = previous ?? {
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      checks: 0,
    };
    observed.lastSeenAtMs = nowMs;
    observed.checks += 1;
    observations[mint] = observed;
    const ageMs = Math.max(0, nowMs - observed.firstSeenAtMs);
    if (
      observed.checks < cfg.unroutableWriteoffMinChecks ||
      ageMs < cfg.unroutableWriteoffMinAgeMs ||
      result.wroteOff >= maxPerPass
    ) {
      result.skipped += 1;
      continue;
    }

    const costUsd = Math.max(0, Number(position.sizeUsd) || 0);
    writeUsSellFill({
      tradesPath: cfg.tradesPath,
      wallet: cfg.walletPubkeyExpected ?? 'unknown',
      mint,
      symbol: position.symbol,
      ok: true,
      signature: null,
      sizeUsdIntent: costUsd,
      fraction: 1,
      quoteReceivedUsd: 0,
      fillPriceUsd: null,
      markPnlPct: -100,
      costBasisUsdFallback: costUsd,
      reason: probe.status === 'worthless' ? 'worthless_writeoff' : 'unroutable_writeoff',
      lane: position.lane ?? 'dip',
      nowMs,
    });
    delete state.open[mint];
    if (!state.lastExitByMint) state.lastExitByMint = {};
    state.lastExitByMint[mint] = {
      priceUsd: Math.max(0.000000001, position.entryPriceUsd),
      atMs: nowMs,
      pnlPct: -100,
      preExitTokenRaw: tokenRaw,
    };
    delete observations[mint];
    result.wroteOff += 1;
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_unroutable_writeoff',
      mint,
      symbol: position.symbol,
      tokenRaw,
      costUsd,
      checks: observed.checks,
      ageMs,
      mode: probe.status === 'worthless' ? 'worthless' : 'unroutable',
    });
  }
  saveMildDipState(cfg.statePath, state);
  return result;
}
