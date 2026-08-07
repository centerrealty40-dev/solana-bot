/**
 * Shared buy attempt used by slow enrich lane and stream/leader fast-path.
 */
import { executeCopyBuy } from '../copytrader/executor.js';
import { resetCopyFundingCache } from '../copytrader/funding-gate.js';
import { fetchMintBalanceRaw } from '../copytrader/live-exec.js';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { CopyTraderConfig } from '../copytrader/config.js';
import type { MildDipConfig } from './config.js';
import type { MildDipCandidate } from './discover.js';
import { noteStructuralCache } from './fast-path.js';
import {
  evaluateCooldownBounce,
  evaluateMildDipPreBuy,
  evaluateRebuyBelowExit,
  resolveMildDipWantedSizeUsd,
} from './gates.js';
import { evaluateKnifeStabilizePreBuy } from './knife-stabilize.js';
import { mildStabilizeScaleInOk } from './mild-stabilize.js';
import { mildDipPriceRing } from './price-ring.js';
import { maybeTopUpFeeSol } from './fee-sol-topup.js';
import {
  appendMildDipJournal,
  saveMildDipState,
  type MildDipOpenPosition,
  type MildDipState,
} from './state.js';

const HOLDING_DUST_RAW = 1000n;

export type EntryAttemptOpts = {
  chasePct: number;
  skipBounce?: boolean;
  skipOnchainAdopt?: boolean;
  /** When false, skip second Dex round-trip — use candidate mark as fresh. */
  freshDexPrebuy?: boolean;
  /** Short cooldown after soft skip (prebuy/bounce). */
  softSkipCooldownMs?: number;
  lane: 'fast' | 'slow';
};

export type EntryAttemptResult = 'filled' | 'skip' | 'stop';

export async function attemptMildDipEntry(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  candidate: MildDipCandidate;
  copyCfg: CopyTraderConfig;
  nowMs: number;
  buyInFlight: Set<string>;
  resolveEntrySizeUsd: (
    cfg: MildDipConfig,
    copyCfg: CopyTraderConfig,
    nowMs: number,
    wantUsd: number,
  ) => Promise<{ sizeUsd: number; usdc?: number | null; stop: boolean; reason?: string }>;
  adoptOnChainHolding: (args: {
    cfg: MildDipConfig;
    state: MildDipState;
    mint: string;
    symbol: string;
    tokenRaw: string;
    priceUsd: number;
    pc5m: number | null;
    nowMs: number;
  }) => void;
  opts: EntryAttemptOpts;
}): Promise<EntryAttemptResult> {
  const { cfg, state, copyCfg, nowMs, buyInFlight, opts } = args;
  const c = args.candidate;
  const isMildStabilize = c.dipSource === 'mild_stabilize';
  const existing = state.open[c.mint];
  const isScaleIn = Boolean(isMildStabilize && existing && !existing.bounceClipDone);

  if (buyInFlight.has(c.mint)) return 'skip';
  if (existing && !isScaleIn) return 'skip';
  if (!isScaleIn && (state.cooldownUntilMs[c.mint] ?? 0) > nowMs) return 'skip';
  if (cfg.deniedMints.includes(c.mint)) return 'skip';

  const scaleInTroughSample = () =>
    mildDipPriceRing.minPrice(c.mint, cfg.cooldownBounceLookbackMs, nowMs);
  const scaleInGuard = (markPriceUsd: number | null) => {
    if (!isScaleIn || !existing) return { pass: true as const };
    const troughSample = scaleInTroughSample();
    const troughPx = c.mildStabilizeTroughPriceUsd ?? troughSample?.priceUsd ?? null;
    const troughAtMs = c.mildStabilizeTroughAtMs ?? troughSample?.tsMs ?? null;
    return mildStabilizeScaleInOk({
      entryPriceUsd: existing.entryPriceUsd,
      troughPriceUsd: troughPx,
      troughAtMs,
      openedAtMs: existing.openedAtMs,
      markPriceUsd,
      minDumpBelowEntryPct: cfg.mildStabilizeScaleInMinDumpBelowEntryPct,
    });
  };

  {
    const ok = scaleInGuard(c.priceUsd);
    if (!ok.pass) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_scale_in_skip',
        mint: c.mint,
        symbol: c.symbol,
        dipSource: c.dipSource,
        lane: opts.lane,
        entryPriceUsd: existing?.entryPriceUsd ?? null,
        troughPriceUsd: c.mildStabilizeTroughPriceUsd ?? null,
        troughAtMs: c.mildStabilizeTroughAtMs ?? null,
        openedAtMs: existing?.openedAtMs ?? null,
        markPriceUsd: c.priceUsd,
        reasons: [ok.reason ?? 'mild_stabilize_scale_in_reject'],
      });
      return 'skip';
    }
  }

  if (!opts.skipOnchainAdopt && !isScaleIn) {
    const onchain = await fetchMintBalanceRaw(copyCfg, c.mint);
    const onchainRaw = onchain && /^\d+$/.test(onchain) ? BigInt(onchain) : 0n;
    if (onchainRaw > HOLDING_DUST_RAW) {
      args.adoptOnChainHolding({
        cfg,
        state,
        mint: c.mint,
        symbol: c.symbol,
        tokenRaw: onchainRaw.toString(),
        priceUsd: c.priceUsd,
        pc5m: c.metrics.priceChange5mPct,
        nowMs,
      });
      return 'skip';
    }
  }

  let entryPriceUsd = c.priceUsd;
  let entryPc5m = c.metrics.priceChange5mPct;
  let freshPx: number | null = c.priceUsd;
  const isKnife = c.dipSource === 'knife_stabilize';
  const isH1RedShallow = c.dipSource === 'h1_red_shallow';
  const isFlatMicro = c.dipSource === 'flat_micro_dip';
  let sizeMetrics = {
    liquidityUsd: c.metrics.liquidityUsd,
    marketCapUsd: c.metrics.marketCapUsd,
    pairAgeHours: c.metrics.pairAgeHours,
  };
  const softCd = opts.softSkipCooldownMs ?? Math.min(cfg.mintCooldownMs, 120_000);
  const branchEntryGates = isH1RedShallow
    ? {
        minDipPct: cfg.h1RedShallowMinDipPct,
        maxDipPct: cfg.h1RedShallowMaxDipPct,
      }
    : isFlatMicro
      ? {
          minDipPct: cfg.flatMicroMinDipPct,
          maxDipPct: cfg.flatMicroMaxDipPct,
        }
      : cfg.entry;

  if (cfg.preBuyRevalidate) {
    const freshNow = Date.now();
    if (opts.freshDexPrebuy !== false) {
      const fresh = await fetchDexScreenerPairDetails(c.mint, {
        bypassCache: false,
        cacheTtlMs: 2_000,
        nowMs: freshNow,
      });
      freshPx = fresh?.priceUsd != null && fresh.priceUsd > 0 ? fresh.priceUsd : null;
      const freshPc = fresh?.priceChangeM5Pct ?? null;
      const freshVol5m = fresh?.volume5mUsd ?? c.metrics.volume5mUsd;
      if (freshPx != null) {
        mildDipPriceRing.note(c.mint, freshPx, { tsMs: freshNow, source: 'dex' });
      }
      if (fresh && freshPx != null) {
        const pairAgeHours =
          fresh.pairCreatedAtMs != null && fresh.pairCreatedAtMs > 0
            ? Math.max(0, (freshNow - fresh.pairCreatedAtMs) / 3_600_000)
            : null;
        noteStructuralCache(
          c.mint,
          freshPx,
          {
            priceChange5mPct: fresh.priceChangeM5Pct,
            volume5mUsd: fresh.volume5mUsd,
            liquidityUsd: fresh.liquidityUsd,
            marketCapUsd: fresh.marketCapUsd,
            pairAgeHours,
            dexId: fresh.dexId,
            buys5m: fresh.buys5m,
            sells5m: fresh.sells5m,
            volume1hUsd: fresh.volume1hUsd,
            priceChange1hPct: fresh.priceChangeH1Pct,
          },
          freshNow,
        );
        sizeMetrics = {
          liquidityUsd: fresh.liquidityUsd ?? sizeMetrics.liquidityUsd,
          marketCapUsd: fresh.marketCapUsd ?? sizeMetrics.marketCapUsd,
          pairAgeHours: pairAgeHours ?? sizeMetrics.pairAgeHours,
        };
      }
      const pre = isKnife
        ? evaluateKnifeStabilizePreBuy({
            signalPriceUsd: c.priceUsd,
            freshPriceUsd: freshPx,
            troughPriceUsd: c.knifeWatch?.troughPriceUsd ?? null,
            maxChasePct: opts.chasePct,
            maxBouncePct: cfg.knifeStabilizeMaxBouncePct,
          })
        : isMildStabilize
          ? evaluateKnifeStabilizePreBuy({
              signalPriceUsd: c.priceUsd,
              freshPriceUsd: freshPx,
              troughPriceUsd: c.mildStabilizeTroughPriceUsd ?? null,
              maxChasePct: opts.chasePct,
              maxBouncePct: cfg.mildStabilizeMaxBouncePct,
            })
          : evaluateMildDipPreBuy({
              signalPriceUsd: c.priceUsd,
              freshPriceUsd: freshPx,
              freshPc5mPct: freshPc,
              entryGates: branchEntryGates,
              maxChasePct: opts.chasePct,
            });
      if (!pre.pass) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_prebuy_skip',
          mint: c.mint,
          symbol: c.symbol,
          dipSource: c.dipSource,
          lane: opts.lane,
          signalPriceUsd: c.priceUsd,
          signalPc5m: c.metrics.priceChange5mPct,
          freshPriceUsd: freshPx,
          freshPc5m: freshPc,
          freshVolume5mUsd: freshVol5m,
          reasons: pre.reasons,
        });
        console.log(
          `[mild-dip] SKIP prebuy ${c.symbol} mint=${c.mint.slice(0, 8)}… ${pre.reasons.join(',')}`,
        );
        state.cooldownUntilMs[c.mint] = nowMs + softCd;
        return 'skip';
      }
      if (freshPx != null) entryPriceUsd = freshPx;
      if (!isKnife && freshPc != null) entryPc5m = freshPc;
    } else {
      // Fast lane: trust candidate mark (already stream/Dex at evaluate time).
      const last = mildDipPriceRing.lastPrice(c.mint, freshNow);
      if (last && last.priceUsd > 0) {
        freshPx = last.priceUsd;
        const chase =
          opts.chasePct > 0 && c.priceUsd > 0
            ? ((freshPx - c.priceUsd) / c.priceUsd) * 100
            : 0;
        if (chase > opts.chasePct) {
          appendMildDipJournal(cfg.journalPath, {
            kind: 'mild_dip_prebuy_skip',
            mint: c.mint,
            symbol: c.symbol,
            dipSource: c.dipSource,
            lane: opts.lane,
            signalPriceUsd: c.priceUsd,
            freshPriceUsd: freshPx,
            reasons: [`prebuy_chase=${chase.toFixed(2)}%>max=${opts.chasePct}`],
          });
          state.cooldownUntilMs[c.mint] = nowMs + softCd;
          return 'skip';
        }
        entryPriceUsd = freshPx;
      }
    }
  }

  // Scale-in: re-check avg-down on fresh mark (prebuy / chase can reclaim to entry).
  if (isScaleIn && existing) {
    const markPx = freshPx ?? entryPriceUsd;
    const ok = scaleInGuard(markPx);
    if (!ok.pass) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_scale_in_skip',
        mint: c.mint,
        symbol: c.symbol,
        dipSource: c.dipSource,
        lane: opts.lane,
        entryPriceUsd: existing.entryPriceUsd,
        troughPriceUsd: c.mildStabilizeTroughPriceUsd ?? null,
        troughAtMs: c.mildStabilizeTroughAtMs ?? null,
        openedAtMs: existing.openedAtMs,
        markPriceUsd: markPx,
        reasons: [ok.reason ?? 'mild_stabilize_scale_in_reject'],
      });
      console.log(
        `[mild-dip] SKIP scale-in ${c.symbol} mint=${c.mint.slice(0, 8)}… ${ok.reason ?? 'reject'}`,
      );
      return 'skip';
    }
  }

  // Always on (incl. fast-path): do not rebuy near last exit USD price.
  // Scale-in into an open bag is exempt (has its own below-entry guards).
  if (!isScaleIn && cfg.rebuyBelowExitPct > 0) {
    const last = state.lastExitByMint?.[c.mint];
    const markPx = freshPx ?? entryPriceUsd;
    const rebuy = evaluateRebuyBelowExit({
      freshPriceUsd: markPx,
      lastExitPriceUsd: last?.priceUsd,
      lastExitAtMs: last?.atMs,
      nowMs,
      minBelowExitPct: cfg.rebuyBelowExitPct,
      maxAgeMs: cfg.rebuyBelowExitMaxAgeMs,
    });
    if (!rebuy.pass) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_rebuy_below_exit_skip',
        mint: c.mint,
        symbol: c.symbol,
        lane: opts.lane,
        freshPriceUsd: markPx,
        lastExitPriceUsd: last?.priceUsd ?? null,
        lastExitAtMs: last?.atMs ?? null,
        reasons: rebuy.reasons,
      });
      console.log(
        `[mild-dip] SKIP rebuy-exit ${c.symbol} mint=${c.mint.slice(0, 8)}… ${rebuy.reasons.join(',')}`,
      );
      state.cooldownUntilMs[c.mint] = nowMs + softCd;
      return 'skip';
    }
  }

  if (!opts.skipBounce) {
    const bounceLookbackMs = Math.max(
      cfg.cooldownBounceLookbackMs,
      cfg.mintCooldownMs,
      cfg.lossCooldownMs,
    );
    const trough = isKnife
      ? c.knifeWatch
        ? {
            priceUsd: c.knifeWatch.troughPriceUsd,
            tsMs: c.knifeWatch.troughAtMs,
            source: 'dex' as const,
          }
        : mildDipPriceRing.minPrice(c.mint, bounceLookbackMs, nowMs)
      : mildDipPriceRing.minPrice(c.mint, bounceLookbackMs, nowMs);
    const bounce = evaluateCooldownBounce({
      freshPriceUsd: freshPx ?? entryPriceUsd,
      troughPriceUsd: trough?.priceUsd ?? null,
      maxBouncePct: isKnife ? cfg.knifeStabilizeMaxBouncePct : cfg.maxCooldownBouncePct,
      requireTrough: false,
    });
    if (!bounce.pass) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_cooldown_bounce_skip',
        mint: c.mint,
        symbol: c.symbol,
        lane: opts.lane,
        freshPriceUsd: freshPx ?? entryPriceUsd,
        troughPriceUsd: trough?.priceUsd ?? null,
        reasons: bounce.reasons,
      });
      console.log(
        `[mild-dip] SKIP bounce ${c.symbol} mint=${c.mint.slice(0, 8)}… ${bounce.reasons.join(',')}`,
      );
      state.cooldownUntilMs[c.mint] = nowMs + softCd;
      return 'skip';
    }
  }

  const wanted = resolveMildDipWantedSizeUsd({
    basePositionUsd: cfg.positionUsd,
    thick: {
      positionUsd: cfg.thickPositionUsd,
      minMarketCapUsd: cfg.thickMinMarketCapUsd,
      minLiquidityUsd: cfg.thickMinLiquidityUsd,
      minPairAgeHours: cfg.thickMinPairAgeHours,
    },
    metrics: sizeMetrics,
  });
  const sized = await args.resolveEntrySizeUsd(cfg, copyCfg, nowMs, wanted.sizeUsd);
  if (sized.stop || !(sized.sizeUsd > 0)) {
    if (sized.reason && sized.reason !== 'usdc_exhausted') {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_funding_block',
        mint: c.mint,
        symbol: c.symbol,
        reason: sized.reason,
        usdc: sized.usdc ?? null,
        wantUsd: wanted.sizeUsd,
        sizeTier: wanted.tier,
        lane: opts.lane,
      });
    }
    // Fee SOL drained — do not wait for the next healthy-path topup tick.
    if (sized.reason?.startsWith('insufficient_fee_sol')) {
      void maybeTopUpFeeSol(cfg, Date.now(), { forceUrgent: true }).catch((err) => {
        console.warn('[mild-dip] urgent fee-sol topup failed', err);
      });
      // Skip this mint; keep scanning others (stop would abort the whole slow lane).
      return 'skip';
    }
    return 'stop';
  }

  if (buyInFlight.has(c.mint)) return 'skip';
  if (state.open[c.mint] && !isScaleIn) return 'skip';
  buyInFlight.add(c.mint);
  const prior: MildDipOpenPosition | undefined = isScaleIn ? existing : undefined;
  if (!isScaleIn) {
    state.open[c.mint] = {
      mint: c.mint,
      symbol: c.symbol,
      entryPriceUsd,
      sizeUsd: sized.sizeUsd,
      tokenRaw: null,
      openedAtMs: nowMs,
      entryPc5mPct: entryPc5m,
      buySignature: null,
      peakPriceUsd: entryPriceUsd,
      trailArmed: false,
      entryVolume5mUsd: c.metrics.volume5mUsd ?? null,
    };
  }
  if (state.knifeWatch?.[c.mint]) delete state.knifeWatch[c.mint];
  saveMildDipState(cfg.statePath, state);
  appendMildDipJournal(cfg.journalPath, {
    kind: isScaleIn ? 'mild_dip_scale_in_reserved' : 'mild_dip_buy_reserved',
    mint: c.mint,
    symbol: c.symbol,
    sizeUsd: sized.sizeUsd,
    priceUsd: entryPriceUsd,
    dipSource: c.dipSource,
    lane: opts.lane,
    mildStabilizeBouncePct: c.mildStabilizeBouncePct ?? null,
    mildStabilizeDumpPct: c.mildStabilizeDumpPct ?? null,
  });

  const leaderSig = `milddip_${opts.lane}_${isScaleIn ? 'scalein_' : ''}${c.mint.slice(0, 8)}_${nowMs}`;
  let buy: Awaited<ReturnType<typeof executeCopyBuy>>;
  try {
    buy = await executeCopyBuy({
      cfg: copyCfg,
      mint: c.mint,
      symbol: c.symbol,
      priceUsd: entryPriceUsd,
      sizeUsd: sized.sizeUsd,
      kind: 'entry',
      evalResult: {
        pass: true,
        reasons: [
          isMildStabilize
            ? `mild_stabilize_bounce=${c.mildStabilizeBouncePct?.toFixed(2) ?? 'n/a'}`
            : `mild_dip_pc5m=${entryPc5m?.toFixed(2) ?? 'n/a'}`,
        ],
        score: Math.abs(entryPc5m ?? c.mildStabilizeBouncePct ?? 0),
      },
      leaderSignature: leaderSig,
      leaderPriceUsd: entryPriceUsd,
      leaderBuyTs: nowMs,
    });
  } catch (err) {
    if (!isScaleIn) delete state.open[c.mint];
    buyInFlight.delete(c.mint);
    if (!isScaleIn) state.cooldownUntilMs[c.mint] = nowMs + softCd;
    saveMildDipState(cfg.statePath, state);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_buy_attempt',
      mint: c.mint,
      symbol: c.symbol,
      sizeUsd: sized.sizeUsd,
      priceUsd: entryPriceUsd,
      pc5m: entryPc5m,
      dipSource: c.dipSource,
      lane: opts.lane,
      scaleIn: isScaleIn,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      mode: cfg.executionMode,
    });
    resetCopyFundingCache();
    return 'skip';
  }

  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_buy_attempt',
    mint: c.mint,
    symbol: c.symbol,
    sizeUsd: sized.sizeUsd,
    priceUsd: buy.priceUsd || entryPriceUsd,
    signalPriceUsd: c.priceUsd,
    pc5m: entryPc5m,
    signalPc5m: c.metrics.priceChange5mPct,
    volume5mUsd: c.metrics.volume5mUsd,
    liquidityUsd: sizeMetrics.liquidityUsd,
    marketCapUsd: sizeMetrics.marketCapUsd,
    dipSource: c.dipSource,
    lane: opts.lane,
    scaleIn: isScaleIn,
    mildStabilizeBouncePct: c.mildStabilizeBouncePct ?? null,
    mildStabilizeDumpPct: c.mildStabilizeDumpPct ?? null,
    ok: buy.ok,
    reason: buy.reason ?? null,
    signature: buy.signature ?? null,
    mode: cfg.executionMode,
    usdcBefore: sized.usdc ?? null,
  });

  if (!buy.ok) {
    if (!isScaleIn) delete state.open[c.mint];
    buyInFlight.delete(c.mint);
    if (!isScaleIn) state.cooldownUntilMs[c.mint] = nowMs + softCd;
    saveMildDipState(cfg.statePath, state);
    resetCopyFundingCache();
    return 'skip';
  }

  const filledRaw = await fetchMintBalanceRaw(copyCfg, c.mint);
  const fillPx = buy.priceUsd || entryPriceUsd;
  if (isScaleIn && prior) {
    const prevSize = prior.sizeUsd > 0 ? prior.sizeUsd : sized.sizeUsd;
    const newSize = prevSize + sized.sizeUsd;
    const avgPx =
      newSize > 0
        ? (prior.entryPriceUsd * prevSize + fillPx * sized.sizeUsd) / newSize
        : fillPx;
    state.open[c.mint] = {
      ...prior,
      entryPriceUsd: avgPx,
      sizeUsd: newSize,
      tokenRaw: filledRaw ?? prior.tokenRaw,
      peakPriceUsd: Math.max(prior.peakPriceUsd ?? avgPx, fillPx, avgPx),
      bounceClipDone: true,
      buySignature: buy.signature ?? prior.buySignature,
    };
  } else {
    state.open[c.mint] = {
      mint: c.mint,
      symbol: c.symbol,
      entryPriceUsd: fillPx,
      sizeUsd: sized.sizeUsd,
      tokenRaw: filledRaw ?? buy.tokenRaw ?? null,
      openedAtMs: nowMs,
      entryPc5mPct: entryPc5m,
      buySignature: buy.signature ?? null,
      peakPriceUsd: fillPx,
      trailArmed: false,
      entryVolume5mUsd: c.metrics.volume5mUsd ?? null,
      bounceClipDone: isMildStabilize ? true : undefined,
    };
  }
  buyInFlight.delete(c.mint);
  saveMildDipState(cfg.statePath, state);
  resetCopyFundingCache();
  console.log(
    `[mild-dip] ${isScaleIn ? 'SCALE-IN' : 'BUY'} ${c.symbol} mint=${c.mint.slice(0, 8)}… $${sized.sizeUsd}` +
      `${wanted.tier === 'thick' ? ' thick' : ''} ` +
      (isMildStabilize
        ? `bounce=${c.mildStabilizeBouncePct?.toFixed(1)}% dump=${c.mildStabilizeDumpPct?.toFixed(1)}%`
        : `pc5m=${entryPc5m?.toFixed(1)}`) +
      ` @$${fillPx.toPrecision(4)} lane=${opts.lane} mode=${cfg.executionMode}`,
  );
  return 'filled';
}
