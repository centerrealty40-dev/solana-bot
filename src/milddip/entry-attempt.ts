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
  resolveMildDipWantedSizeUsd,
} from './gates.js';
import { evaluateKnifeStabilizePreBuy } from './knife-stabilize.js';
import { mildDipPriceRing } from './price-ring.js';
import { maybeTopUpFeeSol } from './fee-sol-topup.js';
import {
  appendMildDipJournal,
  saveMildDipState,
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

  if (state.open[c.mint] || buyInFlight.has(c.mint)) return 'skip';
  if ((state.cooldownUntilMs[c.mint] ?? 0) > nowMs) return 'skip';
  if (cfg.deniedMints.includes(c.mint)) return 'skip';

  if (!opts.skipOnchainAdopt) {
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

  if (buyInFlight.has(c.mint) || state.open[c.mint]) return 'skip';
  buyInFlight.add(c.mint);
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
  if (state.knifeWatch?.[c.mint]) delete state.knifeWatch[c.mint];
  saveMildDipState(cfg.statePath, state);
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_buy_reserved',
    mint: c.mint,
    symbol: c.symbol,
    sizeUsd: sized.sizeUsd,
    priceUsd: entryPriceUsd,
    dipSource: c.dipSource,
    lane: opts.lane,
  });

  const leaderSig = `milddip_${opts.lane}_${c.mint.slice(0, 8)}_${nowMs}`;
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
        reasons: [`mild_dip_pc5m=${entryPc5m?.toFixed(2) ?? 'n/a'}`],
        score: Math.abs(entryPc5m ?? 0),
      },
      leaderSignature: leaderSig,
      leaderPriceUsd: entryPriceUsd,
      leaderBuyTs: nowMs,
    });
  } catch (err) {
    delete state.open[c.mint];
    buyInFlight.delete(c.mint);
    state.cooldownUntilMs[c.mint] = nowMs + softCd;
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
    ok: buy.ok,
    reason: buy.reason ?? null,
    signature: buy.signature ?? null,
    mode: cfg.executionMode,
    usdcBefore: sized.usdc ?? null,
  });

  if (!buy.ok) {
    delete state.open[c.mint];
    buyInFlight.delete(c.mint);
    state.cooldownUntilMs[c.mint] = nowMs + softCd;
    saveMildDipState(cfg.statePath, state);
    resetCopyFundingCache();
    return 'skip';
  }

  const filledRaw = await fetchMintBalanceRaw(copyCfg, c.mint);
  const fillPx = buy.priceUsd || entryPriceUsd;
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
  };
  buyInFlight.delete(c.mint);
  saveMildDipState(cfg.statePath, state);
  resetCopyFundingCache();
  console.log(
    `[mild-dip] BUY ${c.symbol} mint=${c.mint.slice(0, 8)}… $${sized.sizeUsd}` +
      `${wanted.tier === 'thick' ? ' thick' : ''} pc5m=${entryPc5m?.toFixed(1)} @$${
        fillPx.toPrecision(4)
      } lane=${opts.lane} mode=${cfg.executionMode}`,
  );
  return 'filled';
}
