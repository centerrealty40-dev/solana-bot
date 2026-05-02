/**
 * W8.0 Phase 5 — §3.3 risk + §3.4 capital gates before Phase 4 adapter (simulate).
 */
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { qnCall } from '../core/rpc/qn-client.js';
import { liveFetchBuyQuote } from './jupiter.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { LiveOscarConfig } from './config.js';
import type { LiveOscarStrategyDeps } from './phase4-types.js';
import { executeLiveTokenToSolPipeline } from './phase4-execution.js';
import { liveConsecSimFailCount } from './phase5-state.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';
import { liveReconcileBlocksNewExposure } from './live-reconcile-state.js';

export function capitalNotionalXUsd(liveCfg: LiveOscarConfig, paperPositionUsd: number): number {
  return liveCfg.liveEntryNotionalUsd ?? liveCfg.liveMaxPositionUsd ?? paperPositionUsd;
}

export function capitalRequiredFreeUsd(liveCfg: LiveOscarConfig, paperPositionUsd: number): number {
  return liveCfg.liveEntryMinFreeMult * capitalNotionalXUsd(liveCfg, paperPositionUsd);
}

function walletPubkey58(cfg: LiveOscarConfig): string | null {
  const s = cfg.walletSecret?.trim();
  if (!s) return null;
  try {
    return loadLiveKeypairFromSecretEnv(s).publicKey.toBase58();
  } catch {
    return null;
  }
}

/** Jupiter SOL→token quote → implied USD/token (§5 MTM). */
export function tokenUsdFromBuyQuote(
  quoteResponse: Record<string, unknown>,
  solUsd: number,
  decimals: number,
): number | null {
  const inAmt = quoteResponse.inAmount;
  const outAmt = quoteResponse.outAmount;
  if (typeof inAmt !== 'string' || typeof outAmt !== 'string') return null;
  if (!/^\d+$/.test(inAmt) || !/^\d+$/.test(outAmt)) return null;
  const lamports = BigInt(inAmt);
  const outRaw = BigInt(outAmt);
  if (outRaw === 0n) return null;
  const solSpent = Number(lamports) / 1e9;
  const tokensOut = Number(outRaw) / 10 ** decimals;
  if (!(tokensOut > 0) || !(solSpent > 0)) return null;
  return (solSpent * solUsd) / tokensOut;
}

function realizedNetSumUsd(closed: ClosedTrade[]): number {
  let s = 0;
  for (const c of closed) {
    if (Number.isFinite(c.netPnlUsd)) s += c.netPnlUsd;
  }
  return s;
}

async function unrealizedOneUsd(args: {
  ot: OpenTrade;
  liveCfg: LiveOscarConfig;
  solUsd: number;
  probeUsd: number;
}): Promise<number | null> {
  const { ot, liveCfg, solUsd, probeUsd } = args;
  const dec = ot.tokenDecimals ?? 6;
  const fetched = await liveFetchBuyQuote({
    cfg: liveCfg,
    outputMint: ot.mint,
    sizeUsd: probeUsd,
    solUsd,
  });
  if (!fetched) return null;
  const px = tokenUsdFromBuyQuote(fetched.quoteResponse, solUsd, dec);
  if (!(px != null && px > 0) || !(ot.avgEntry > 0)) return null;
  const cost = ot.totalInvestedUsd * ot.remainingFraction;
  const value = cost * (px / ot.avgEntry);
  return value - cost;
}

async function aggregateStrategyPnlUsd(args: {
  deps: LiveOscarStrategyDeps;
  liveCfg: LiveOscarConfig;
  solUsd: number;
  probeUsd: number;
}): Promise<{ total: number; mtmOk: boolean }> {
  const realized = realizedNetSumUsd(args.deps.getClosed());
  let unrealized = 0;
  for (const ot of args.deps.getOpen().values()) {
    const u = await unrealizedOneUsd({
      ot,
      liveCfg: args.liveCfg,
      solUsd: args.solUsd,
      probeUsd: args.probeUsd,
    });
    if (u === null) return { total: realized, mtmOk: false };
    unrealized += u;
  }
  return { total: realized + unrealized, mtmOk: true };
}

async function rpcWalletSolLamports(cfg: LiveOscarConfig): Promise<bigint | null> {
  const pk = walletPubkey58(cfg);
  if (!pk) return null;
  const res = await qnCall<number>('getBalance', [pk, { commitment: 'processed' }], {
    feature: 'sim',
    creditsPerCall: cfg.liveSimCreditsPerCall,
    timeoutMs: cfg.liveSimTimeoutMs,
  });
  if (!res.ok) return null;
  const v = res.value;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? BigInt(Math.floor(n)) : null;
}

async function freeUsdSolOnly(args: {
  cfg: LiveOscarConfig;
  solUsd: number;
  /** Simulated rotation proceeds still on-wallet until Phase 6 — bump effective SOL from quote.outAmount. */
  virtualExtraLamports: bigint;
}): Promise<number | null> {
  const lamports = await rpcWalletSolLamports(args.cfg);
  if (lamports === null) return null;
  const buf = BigInt(Math.max(0, args.cfg.liveFreeSolBufferLamports));
  const raw = lamports + args.virtualExtraLamports;
  const avail = raw > buf ? raw - buf : 0n;
  const sol = Number(avail) / 1e9;
  return sol * args.solUsd;
}

type RankRow = {
  mint: string;
  ot: OpenTrade;
  unrealized: number;
  pctOfCost: number;
  entryTs: number;
};

async function rankProfitableOpens(args: {
  liveCfg: LiveOscarConfig;
  open: Map<string, OpenTrade>;
  solUsd: number;
  probeUsd: number;
  excludeMints: Set<string>;
}): Promise<RankRow[]> {
  const rows: RankRow[] = [];
  for (const ot of args.open.values()) {
    if (args.excludeMints.has(ot.mint)) continue;
    const u = await unrealizedOneUsd({
      ot,
      liveCfg: args.liveCfg,
      solUsd: args.solUsd,
      probeUsd: args.probeUsd,
    });
    if (u === null || !(u > 0)) continue;
    const cost = ot.totalInvestedUsd * ot.remainingFraction;
    rows.push({
      mint: ot.mint,
      ot,
      unrealized: u,
      pctOfCost: u / Math.max(cost, 1e-9),
      entryTs: ot.entryTs,
    });
  }
  rows.sort((a, b) => {
    if (b.unrealized !== a.unrealized) return b.unrealized - a.unrealized;
    if (b.pctOfCost !== a.pctOfCost) return b.pctOfCost - a.pctOfCost;
    return a.entryTs - b.entryTs;
  });
  return rows;
}

async function haltSimCloseAllOpens(liveCfg: LiveOscarConfig, deps: LiveOscarStrategyDeps): Promise<void> {
  const opens = [...deps.getOpen().values()];
  for (const ot of opens) {
    const invested = ot.totalInvestedUsd * ot.remainingFraction;
    const px =
      ot.lastObservedPriceUsd != null && ot.lastObservedPriceUsd > 0
        ? ot.lastObservedPriceUsd
        : ot.avgEntry;
    await executeLiveTokenToSolPipeline(liveCfg, {
      mint: ot.mint,
      symbol: ot.symbol,
      usdNotional: Math.max(invested, 1e-6),
      priceUsdPerToken: px > 0 ? px : ot.avgEntry,
      decimals: ot.tokenDecimals ?? 6,
      intentKind: 'sell_full',
    });
  }
}

/**
 * Returns false when this increase must not reach Phase 4 (risk_block / capital_skip already logged).
 */
export async function phase5AllowIncreaseExposure(args: {
  liveCfg: LiveOscarConfig;
  deps: LiveOscarStrategyDeps;
  paperPositionUsd: number;
  intendedUsd: number;
  isNewPosition: boolean;
}): Promise<boolean> {
  const { liveCfg, deps, paperPositionUsd, intendedUsd, isNewPosition } = args;

  if (!liveCfg.strategyEnabled || liveCfg.executionMode === 'dry_run') return true;
  if (liveCfg.executionMode !== 'simulate' && liveCfg.executionMode !== 'live') return true;

  if (liveReconcileBlocksNewExposure()) return false;

  const solUsd = getSolUsd() ?? 0;
  if (!(solUsd > 0)) {
    appendLiveJsonlEvent({
      kind: 'risk_block',
      limit: 'stale_sol_price',
      detail: { solUsd },
    });
    return false;
  }

  const probeUsd = Math.max(5, Math.min(50, capitalNotionalXUsd(liveCfg, paperPositionUsd)));

  const consecLimit = liveCfg.liveKillAfterConsecFail;
  if (consecLimit > 0 && liveConsecSimFailCount() >= consecLimit) {
    appendLiveJsonlEvent({
      kind: 'risk_block',
      limit: 'consec_sim_fail',
      detail: { count: liveConsecSimFailCount(), limit: consecLimit },
    });
    return false;
  }

  const maxOpen = liveCfg.liveMaxOpenPositions;
  if (isNewPosition && maxOpen != null && deps.getOpen().size >= maxOpen) {
    appendLiveJsonlEvent({
      kind: 'risk_block',
      limit: 'max_open_positions',
      detail: { open: deps.getOpen().size, max: maxOpen },
    });
    return false;
  }

  const maxLoss = liveCfg.liveMaxStrategyLossUsd;
  if (maxLoss != null) {
    const pnl = await aggregateStrategyPnlUsd({
      deps,
      liveCfg,
      solUsd,
      probeUsd,
    });
    if (!pnl.mtmOk) {
      appendLiveJsonlEvent({
        kind: 'risk_block',
        limit: 'mtm_unavailable',
        detail: {},
      });
      return false;
    }
    if (pnl.total <= -maxLoss) {
      appendLiveJsonlEvent({
        kind: 'risk_block',
        limit: 'max_strategy_loss',
        detail: { strategyPnlUsd: pnl.total, limitUsd: -maxLoss },
      });
      if (liveCfg.liveHaltCloseAllOnMaxLoss) {
        await haltSimCloseAllOpens(liveCfg, deps);
      }
      return false;
    }
  }

  const maxPosUsd = liveCfg.liveMaxPositionUsd;
  if (maxPosUsd != null && intendedUsd > maxPosUsd) {
    appendLiveJsonlEvent({
      kind: 'risk_block',
      limit: 'max_position_usd',
      detail: { intendedUsd, maxUsd: maxPosUsd },
    });
    return false;
  }

  const minSol = liveCfg.liveMinWalletSol;
  if (minSol != null) {
    const lamports = await rpcWalletSolLamports(liveCfg);
    if (lamports === null) {
      appendLiveJsonlEvent({
        kind: 'risk_block',
        limit: 'wallet_balance_rpc',
        detail: {},
      });
      return false;
    }
    const solBal = Number(lamports) / 1e9;
    if (solBal < minSol) {
      appendLiveJsonlEvent({
        kind: 'risk_block',
        limit: 'min_wallet_sol',
        detail: { solBal, minSol },
      });
      return false;
    }
  }

  const requiredFree = capitalRequiredFreeUsd(liveCfg, paperPositionUsd);
  let virtualExtraLamports = 0n;

  const measureFree = () =>
    freeUsdSolOnly({ cfg: liveCfg, solUsd, virtualExtraLamports: virtualExtraLamports });

  let freeUsd = await measureFree();
  if (freeUsd === null) {
    appendLiveJsonlEvent({
      kind: 'risk_block',
      limit: 'free_balance_rpc',
      detail: {},
    });
    return false;
  }

  if (freeUsd >= requiredFree) return true;

  const openMap = deps.getOpen();
  if (openMap.size === 0) {
    appendLiveJsonlEvent({
      kind: 'capital_skip',
      reason: 'insufficient_free_balance_no_positions',
      freeUsdEstimate: freeUsd,
      requiredFreeUsd: requiredFree,
    });
    return false;
  }

  const cascade = liveCfg.liveCapitalRotateCascade;
  const rotatedThisTick = new Set<string>();
  for (;;) {
    const ranked = await rankProfitableOpens({
      liveCfg,
      open: openMap,
      solUsd,
      probeUsd,
      excludeMints: rotatedThisTick,
    });
    if (ranked.length === 0) {
      appendLiveJsonlEvent({
        kind: 'capital_skip',
        reason: 'no_profitable_position_to_close',
        freeUsdEstimate: freeUsd,
        requiredFreeUsd: requiredFree,
      });
      return false;
    }

    const pick = ranked[0]!;
    appendLiveJsonlEvent({
      kind: 'capital_rotate_close',
      mint: pick.mint,
      unrealizedPnlUsd: pick.unrealized,
      txSignature: null,
    });

    const invested = pick.ot.totalInvestedUsd * pick.ot.remainingFraction;
    const px =
      pick.ot.lastObservedPriceUsd != null && pick.ot.lastObservedPriceUsd > 0
        ? pick.ot.lastObservedPriceUsd
        : pick.ot.avgEntry;

    const sellRes = await executeLiveTokenToSolPipeline(liveCfg, {
      mint: pick.ot.mint,
      symbol: pick.ot.symbol,
      usdNotional: Math.max(invested, 1e-6),
      priceUsdPerToken: px > 0 ? px : pick.ot.avgEntry,
      decimals: pick.ot.tokenDecimals ?? 6,
      intentKind: 'sell_full',
    });

    if (!sellRes.ok) {
      appendLiveJsonlEvent({
        kind: 'capital_skip',
        reason: 'rotation_sim_failed',
        freeUsdEstimate: freeUsd,
        requiredFreeUsd: requiredFree,
      });
      return false;
    }

    rotatedThisTick.add(pick.mint);

    if (liveCfg.executionMode === 'simulate' && sellRes.wsolOutLamports != null) {
      virtualExtraLamports += sellRes.wsolOutLamports;
    }

    freeUsd = await measureFree();
    if (freeUsd === null) {
      appendLiveJsonlEvent({
        kind: 'risk_block',
        limit: 'free_balance_rpc',
        detail: { phase: 'post_rotation' },
      });
      return false;
    }

    if (freeUsd >= requiredFree) return true;

    if (!cascade) {
      appendLiveJsonlEvent({
        kind: 'capital_skip',
        reason: 'insufficient_free_after_rotation',
        freeUsdEstimate: freeUsd,
        requiredFreeUsd: requiredFree,
      });
      return false;
    }
  }
}
