/**
 * W8.0 Phase 5 — §3.3 risk + §3.4 capital gates before Phase 4 adapter (simulate).
 */
import type { OpenTrade } from '../papertrader/types.js';
import { getBtcContext, getSolUsd } from '../papertrader/pricing.js';
import { lamportsFromGetBalanceResult, qnCall } from '../core/rpc/qn-client.js';
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

/**
 * Pick decimals 0…24 that best match `anchorUsdPerToken` (usually `avgEntryMarket` / first-leg fill).
 * Wrong mint decimals (e.g. safety skipped → fallback 6 vs real 9) otherwise shrink MTM ~10^(Δd) and trip false KILLSTOP.
 */
export function tokenUsdFromBuyQuoteFitDecimals(
  quoteResponse: Record<string, unknown>,
  solUsd: number,
  hintDecimals: number,
  anchorUsdPerToken: number,
): { px: number; decimalsUsed: number } | null {
  const dHint = Math.min(24, Math.max(0, Math.floor(hintDecimals)));
  const hintPx = tokenUsdFromBuyQuote(quoteResponse, solUsd, dHint);

  if (!(anchorUsdPerToken > 0) || !Number.isFinite(anchorUsdPerToken)) {
    if (hintPx == null || !(hintPx > 0)) return null;
    return { px: hintPx, decimalsUsed: dHint };
  }

  let bestD = dHint;
  let bestPx = hintPx;
  let bestErr =
    hintPx != null && hintPx > 0
      ? Math.abs(hintPx - anchorUsdPerToken) / anchorUsdPerToken
      : Number.POSITIVE_INFINITY;

  for (let d = 0; d <= 24; d++) {
    const px = tokenUsdFromBuyQuote(quoteResponse, solUsd, d);
    if (px == null || !(px > 0)) continue;
    const err = Math.abs(px - anchorUsdPerToken) / anchorUsdPerToken;
    if (err < bestErr) {
      bestErr = err;
      bestD = d;
      bestPx = px;
    }
  }

  if (bestPx == null || !(bestPx > 0)) return null;

  if (bestErr > 2 && hintPx != null && hintPx > 0) {
    return { px: hintPx, decimalsUsed: dHint };
  }

  return { px: bestPx, decimalsUsed: bestD };
}

async function unrealizedOneUsd(args: {
  ot: OpenTrade;
  liveCfg: LiveOscarConfig;
  solUsd: number;
  probeUsd: number;
}): Promise<number | null> {
  const { ot, liveCfg, solUsd, probeUsd } = args;
  const dec = ot.tokenDecimals ?? 6;
  const anchor =
    ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.avgEntry > 0 ? ot.avgEntry : 0;
  const fetched = await liveFetchBuyQuote({
    cfg: liveCfg,
    outputMint: ot.mint,
    sizeUsd: probeUsd,
    solUsd,
  });
  if (!fetched) return null;
  const fit = tokenUsdFromBuyQuoteFitDecimals(fetched.quoteResponse, solUsd, dec, anchor);
  const px = fit?.px ?? null;
  if (!(px != null && px > 0) || !(ot.avgEntry > 0)) return null;
  const cost = ot.totalInvestedUsd * ot.remainingFraction;
  const value = cost * (px / ot.avgEntry);
  return value - cost;
}

async function rpcWalletSolLamports(cfg: LiveOscarConfig): Promise<bigint | null> {
  const pk = walletPubkey58(cfg);
  if (!pk) return null;
  const res = await qnCall<unknown>('getBalance', [pk, { commitment: 'processed' }], {
    feature: 'sim',
    creditsPerCall: cfg.liveSimCreditsPerCall,
    timeoutMs: cfg.liveSimTimeoutMs,
  });
  if (!res.ok) return null;
  return lamportsFromGetBalanceResult(res.value);
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

  if (liveCfg.executionMode === 'live' && isNewPosition) {
    if (liveCfg.liveBtcGateEnabled) {
      const btc = getBtcContext();
      const staleMs = liveCfg.liveBtcGateMaxStaleMs;
      const ts = btc.updated_ts;
      const fresh = typeof ts === 'number' && ts > 0 && Date.now() - ts <= staleMs;
      if (fresh) {
        const d1 = liveCfg.liveBtcBlockNewBuys1hDrawdownPct;
        const d4 = liveCfg.liveBtcBlockNewBuys4hDrawdownPct;
        if (btc.ret1h_pct != null && btc.ret1h_pct <= -d1) {
          appendLiveJsonlEvent({
            kind: 'risk_block',
            limit: 'btc_dump_1h',
            detail: { ret1h_pct: btc.ret1h_pct, blockAtDrawdownPct: d1 },
          });
          return false;
        }
        if (btc.ret4h_pct != null && btc.ret4h_pct <= -d4) {
          appendLiveJsonlEvent({
            kind: 'risk_block',
            limit: 'btc_dump_4h',
            detail: { ret4h_pct: btc.ret4h_pct, blockAtDrawdownPct: d4 },
          });
          return false;
        }
      }
    }

    const minEq = liveCfg.liveMinWalletSolEquityUsd;
    if (minEq != null && minEq > 0) {
      const lamportsEq = await rpcWalletSolLamports(liveCfg);
      if (lamportsEq === null) {
        appendLiveJsonlEvent({
          kind: 'risk_block',
          limit: 'wallet_balance_rpc',
          detail: { context: 'min_wallet_sol_equity_usd' },
        });
        return false;
      }
      const solBalEq = Number(lamportsEq) / 1e9;
      const equityUsd = solBalEq * solUsd;
      if (equityUsd < minEq) {
        appendLiveJsonlEvent({
          kind: 'risk_block',
          limit: 'min_wallet_sol_equity_usd',
          detail: { equityUsd, minUsd: minEq, solBal: solBalEq },
        });
        return false;
      }
    }
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

  const shortfallAt = (free: number) => Math.max(0, requiredFree - free);

  const openMap = deps.getOpen();
  if (openMap.size === 0) {
    appendLiveJsonlEvent({
      kind: 'capital_skip',
      reason: 'insufficient_free_balance_no_positions',
      freeUsdEstimate: freeUsd,
      requiredFreeUsd: requiredFree,
      shortfallUsd: shortfallAt(freeUsd),
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
        shortfallUsd: shortfallAt(freeUsd),
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
        shortfallUsd: shortfallAt(freeUsd),
      });
      return false;
    }

    const pxForJournal = px > 0 ? px : pick.ot.avgEntry;
    try {
      await deps.finalizeCapitalRotatePaperClose?.(pick.mint, pxForJournal, liveCfg);
    } catch (err) {
      appendLiveJsonlEvent({
        kind: 'risk_note',
        reason: 'capital_rotate_paper_sync_failed',
        detail: {
          mint: pick.mint,
          err: String((err as Error)?.message ?? err).slice(0, 240),
        },
      });
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
        shortfallUsd: shortfallAt(freeUsd),
      });
      return false;
    }
  }
}
