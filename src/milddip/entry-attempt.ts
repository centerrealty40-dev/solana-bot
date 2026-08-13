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
import {
  noteStructuralCache,
  requireStreamPriceForDipSource,
  streamDumpExtentPct,
} from './fast-path.js';
import {
  entryStabilizeExemptDipSource,
  evaluateCooldownBounce,
  evaluateEntryStabilizeRequired,
  evaluateMildDipPreBuy,
  evaluateRebuyBelowExit,
  evaluateRebuyLiquidityDrop,
  mildDipMicroSizeGatesForSource,
  resolveMildDipWantedSizeUsd,
} from './gates.js';
import { evaluateKnifeStabilizePreBuy } from './knife-stabilize.js';
import { assessRugRisk } from './rug-risk.js';
import { mildDipPriceRing } from './price-ring.js';

/**
 * How fresh a ring sample must be to serve as the movement baseline. Dex marks
 * on an open bag run at a median 6.1s, so 30s is several marks of slack while
 * still excluding a stale `wait_dip` signal.
 */
const ENTRY_MARK_MAX_AGE_MS = 30_000;
import { maybeTopUpFeeSol } from './fee-sol-topup.js';
import {
  dumpFromSignalPct,
  evaluateWaitDipPreBuy,
  waitDipMaxPriceUsd,
} from './wait-dip.js';
import { evaluateTurnDumpGate } from './turn-dump.js';
import {
  appendMildDipJournal,
  saveMildDipState,
  type MildDipState,
} from './state.js';
import { writeUsBuyFill } from './trade-journal.js';
import { executionWalletPubkey } from '../copytrader/position-reconcile.js';

const HOLDING_DUST_RAW = 1000n;

/**
 * 1.11.827 — probe buys on re-entry blocks.
 *
 * `rebuy_liq_drop` and `rebuy_below_exit` are the two biggest re-entry blockers
 * (1385 and 762 hits in 3h), and we cannot measure what they cost: once a mint
 * is refused we stop marking it, so there is no forward tape to score. A tiny
 * real buy answers it with a real fill and real slippage instead of a guess.
 *
 * Rate-limited per hour and tagged `probe` in the journal so it never mixes
 * into the main book's statistics.
 */
const probeStamps: number[] = [];

function takeProbeSlot(cfg: MildDipConfig, nowMs: number): boolean {
  if (!cfg.probeBlockedEnabled || !(cfg.probeBlockedUsd > 0)) return false;
  const cutoff = nowMs - 3_600_000;
  while (probeStamps.length > 0 && probeStamps[0]! < cutoff) probeStamps.shift();
  if (probeStamps.length >= cfg.probeBlockedMaxPerHour) return false;
  probeStamps.push(nowMs);
  return true;
}

/** Test helper. */
export function __resetProbeBudgetForTests(): void {
  probeStamps.length = 0;
}

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
  /** Set when a re-entry gate was overridden by a probe (tiny research buy). */
  let probeReason: 'rebuy_below_exit' | 'rebuy_liq_drop' | null = null;

  if (buyInFlight.has(c.mint)) return 'skip';
  if (state.open[c.mint]) return 'skip';
  if ((state.cooldownUntilMs[c.mint] ?? 0) > nowMs) return 'skip';
  if (cfg.deniedMints.includes(c.mint)) return 'skip';

  // 1.11.802 — stream ring only for stream-timed sources; Dex/TD may enter on Dex.
  if (cfg.requireStreamPriceEntry && requireStreamPriceForDipSource(c.dipSource)) {
    const maxAge = cfg.requireStreamPriceMaxAgeMs;
    const stream = mildDipPriceRing.lastPriceBySource(c.mint, 'stream', nowMs, maxAge);
    if (!stream || !(stream.priceUsd > 0)) {
      const last = mildDipPriceRing.lastPrice(c.mint, nowMs);
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_no_stream_price_skip',
        mint: c.mint,
        symbol: c.symbol,
        lane: opts.lane,
        dipSource: c.dipSource,
        lastSource: last?.source ?? null,
        lastAgeMs: last ? Math.max(0, nowMs - last.tsMs) : null,
        maxAgeMs: maxAge,
      });
      return 'skip';
    }
  }

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
  let entryVol5m = c.metrics.volume5mUsd;
  let freshPx: number | null = c.priceUsd;
  const isKnife = c.dipSource === 'knife_stabilize';
  const isTurnDumpKnife = c.dipSource === 'turn_dump_knife';
  const isWaitDip = c.dipSource === 'wait_dip';
  const isH1RedShallow = c.dipSource === 'h1_red_shallow';
  const isFlatMicro = c.dipSource === 'flat_micro_dip';
  let sizeMetrics = {
    liquidityUsd: c.metrics.liquidityUsd,
    marketCapUsd: c.metrics.marketCapUsd,
    pairAgeHours: c.metrics.pairAgeHours,
  };
  const softCd = opts.softSkipCooldownMs ?? Math.min(cfg.mintCooldownMs, 120_000);
  const knifeMaxDip =
    cfg.turnDumpKnifeMinDumpPct > 0 ? -cfg.turnDumpKnifeMinDumpPct : -30;
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
      : isTurnDumpKnife
        ? {
            // Allow deep blade that MAIN/SHALLOW reject (pc5m ≤ −knifeMin).
            minDipPct: Math.min(cfg.knifeStabilizeMinDipPct, -90),
            maxDipPct: knifeMaxDip,
          }
        : cfg.entry;

  if (cfg.preBuyRevalidate) {
    const freshNow = Date.now();
    if (opts.freshDexPrebuy !== false) {
      const fresh = await fetchDexScreenerPairDetails(c.mint, {
        bypassCache: false,
        cacheTtlMs: 2_000,
        nowMs: freshNow,
        allowedDexIds: cfg.entry.allowedDexIds,
      });
      freshPx = fresh?.priceUsd != null && fresh.priceUsd > 0 ? fresh.priceUsd : null;
      const freshPc = fresh?.priceChangeM5Pct ?? null;
      const freshVol5m = fresh?.volume5mUsd ?? c.metrics.volume5mUsd;
      if (fresh?.volume5mUsd != null) entryVol5m = fresh.volume5mUsd;
      if (freshPx != null) {
        mildDipPriceRing.note(c.mint, freshPx, { tsMs: freshNow, source: 'dex' });
      } else {
        // 1.11.804/805 — a null Dex refetch must not read as "no price": every
        // prebuy branch then rejects (`*_prebuy_missing_price`) and the parked
        // wait-dip seat loops until it expires. Fall back to the ring, then to
        // the candidate mark the ready check just validated. Drift protection
        // is not lost: the wait-dip ceiling still caps the fill price.
        const ringPx = mildDipPriceRing.lastPrice(c.mint, freshNow);
        if (ringPx && ringPx.priceUsd > 0) freshPx = ringPx.priceUsd;
        else if (c.priceUsd > 0) freshPx = c.priceUsd;
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
          ? (() => {
              const bouncePre = evaluateKnifeStabilizePreBuy({
                signalPriceUsd: c.priceUsd,
                freshPriceUsd: freshPx,
                troughPriceUsd: c.mildStabilizeTroughPriceUsd ?? null,
                maxChasePct: opts.chasePct,
                maxBouncePct: cfg.mildStabilizeMaxBouncePct,
              });
              const reasons = [...bouncePre.reasons];
              if (cfg.mildStabilizeRequireDexDip) {
                const pc = freshPc;
                if (pc == null || !Number.isFinite(pc)) {
                  reasons.push('mild_stabilize_prebuy_missing_dex_pc5m');
                } else if (!(pc <= cfg.mildStabilizeDexMaxDipPct)) {
                  reasons.push(
                    `mild_stabilize_prebuy_dex_pc5m=${pc.toFixed(2)}>max=${cfg.mildStabilizeDexMaxDipPct}`,
                  );
                }
              }
              return { pass: reasons.length === 0, reasons };
            })()
          : isWaitDip
            ? evaluateWaitDipPreBuy({
                signalPriceUsd: c.waitDipSignalPriceUsd ?? c.priceUsd,
                readyMarkPriceUsd: c.priceUsd,
                freshPriceUsd: freshPx,
                waitDipPct: cfg.waitDipPct,
                maxOvershootPct: cfg.waitDipMaxOvershootPct,
                maxChaseFromReadyPct: cfg.waitDipMaxChasePct,
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
          waitDipSignalPriceUsd: c.waitDipSignalPriceUsd ?? null,
          waitDipMaxPriceUsd: isWaitDip
            ? waitDipMaxPriceUsd(
                c.waitDipSignalPriceUsd ?? c.priceUsd,
                cfg.waitDipPct,
                cfg.waitDipMaxOvershootPct,
              )
            : null,
          signalPc5m: c.metrics.priceChange5mPct,
          freshPriceUsd: freshPx,
          freshPc5m: freshPc,
          freshVolume5mUsd: freshVol5m,
          reasons: pre.reasons,
        });
        console.log(
          `[mild-dip] SKIP prebuy ${c.symbol} mint=${c.mint.slice(0, 8)}… ${pre.reasons.join(',')}`,
        );
        // wait_dip: keep watch; short/zero soft-cd so the next tick can retry.
        state.cooldownUntilMs[c.mint] = nowMs + (isWaitDip ? Math.min(softCd, 1_500) : softCd);
        return 'skip';
      }
      if (freshPx != null) entryPriceUsd = freshPx;
      if (!isKnife && !isWaitDip && freshPc != null) entryPc5m = freshPc;
    } else if (isWaitDip) {
      // wait_dip must still enforce signal ceiling even without a Dex refetch.
      const last = mildDipPriceRing.lastPrice(c.mint, freshNow);
      if (last && last.priceUsd > 0) freshPx = last.priceUsd;
      const pre = evaluateWaitDipPreBuy({
        signalPriceUsd: c.waitDipSignalPriceUsd ?? c.priceUsd,
        readyMarkPriceUsd: c.priceUsd,
        freshPriceUsd: freshPx,
        waitDipPct: cfg.waitDipPct,
        maxOvershootPct: cfg.waitDipMaxOvershootPct,
        maxChaseFromReadyPct: cfg.waitDipMaxChasePct,
      });
      if (!pre.pass) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_prebuy_skip',
          mint: c.mint,
          symbol: c.symbol,
          dipSource: c.dipSource,
          lane: opts.lane,
          signalPriceUsd: c.priceUsd,
          waitDipSignalPriceUsd: c.waitDipSignalPriceUsd ?? null,
          waitDipMaxPriceUsd: waitDipMaxPriceUsd(
            c.waitDipSignalPriceUsd ?? c.priceUsd,
            cfg.waitDipPct,
            cfg.waitDipMaxOvershootPct,
          ),
          freshPriceUsd: freshPx,
          reasons: pre.reasons,
        });
        state.cooldownUntilMs[c.mint] = nowMs + Math.min(softCd, 1_500);
        return 'skip';
      }
      if (freshPx != null) entryPriceUsd = freshPx;
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

  // 1.11.773 — final turn→dump choke (fresh vol/liq/pc5m when available).
  // 1.11.803 — keep the verdict for the entry snapshot even when it passes.
  let tdSnapshot: {
    dump: number | null;
    turn: number | null;
    pred: number | null;
    resid: number | null;
    branch: string | null;
  } | null = null;
  if (cfg.turnDumpGateEnabled) {
    const td = evaluateTurnDumpGate({
      enabled: true,
      pc5m: entryPc5m,
      volume5mUsd: entryVol5m,
      liquidityUsd: sizeMetrics.liquidityUsd ?? c.metrics.liquidityUsd,
      alpha: cfg.turnDumpAlpha,
      beta: cfg.turnDumpBeta,
      shallowSlackPct: cfg.turnDumpShallowSlackPct,
      deepSlackPct: cfg.turnDumpDeepSlackPct,
      shallowBranchEnabled: cfg.turnDumpShallowBranchEnabled,
      shallowAlpha: cfg.turnDumpShallowAlpha,
      shallowBeta: cfg.turnDumpShallowBeta,
      shallowBandPct: cfg.turnDumpShallowBandPct,
      knifeBranchEnabled: cfg.turnDumpKnifeBranchEnabled,
      knifeMinDumpPct: cfg.turnDumpKnifeMinDumpPct,
      knifeMinTurn: cfg.turnDumpKnifeMinTurn,
    });
    tdSnapshot = {
      dump: td.dump,
      turn: td.turn,
      pred: td.pred,
      resid: td.resid,
      branch: td.branch,
    };
    if (!td.pass) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_turn_dump_skip',
        mint: c.mint,
        symbol: c.symbol,
        dipSource: c.dipSource,
        lane: opts.lane,
        pc5m: entryPc5m,
        dump: td.dump,
        turn: td.turn,
        pred: td.pred,
        resid: td.resid,
        branch: td.branch,
        reasons: td.reasons,
      });
      console.log(
        `[mild-dip] SKIP turn-dump ${c.symbol} mint=${c.mint.slice(0, 8)}… ${td.reasons.join(',')}`,
      );
      state.cooldownUntilMs[c.mint] = nowMs + softCd;
      return 'skip';
    }
  }

  // Always on (incl. fast-path): do not rebuy near last exit USD price.
  if (cfg.rebuyBelowExitPct > 0) {
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
      /**
       * 1.11.876 — a probe never argues with a loss we just took.
       *
       * PrkyDd was cut at −15.13% on `never_arm_time_red` — held, never armed,
       * tape still dumping — and 140 seconds later this probe bought it back
       * 1.06% lower at pc5m −13.27%: the same bag, the same fall, two more legs
       * of fees. The gate had refused it correctly and the probe walked around
       * its own gate.
       *
       * The probe exists to price what the re-entry blocks cost, and after a
       * losing exit there is nothing left to price: we just held that tape and
       * it answered. Blocks after a profitable or stale exit still get probed.
       */
      const lastExitWasLoss = last?.pnlPct != null && last.pnlPct < 0;
      if (!lastExitWasLoss && takeProbeSlot(cfg, nowMs)) {
        probeReason = 'rebuy_below_exit';
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_probe_override',
          mint: c.mint,
          symbol: c.symbol,
          blockedBy: 'rebuy_below_exit',
          probeUsd: cfg.probeBlockedUsd,
          reasons: rebuy.reasons,
        });
        console.log(
          `[mild-dip] PROBE rebuy-exit ${c.symbol} mint=${c.mint.slice(0, 8)}… $${cfg.probeBlockedUsd}`,
        );
      } else {
        console.log(
          `[mild-dip] SKIP rebuy-exit ${c.symbol} mint=${c.mint.slice(0, 8)}… ${rebuy.reasons.join(',')}`,
        );
        state.cooldownUntilMs[c.mint] = nowMs + softCd;
        return 'skip';
      }
    }
  }

  // 1.11.797 — after loss exit: skip if Dex liq fell vs exit snapshot.
  if (cfg.rebuyLiqDropEnabled) {
    const last = state.lastExitByMint?.[c.mint];
    const curLiq = sizeMetrics.liquidityUsd ?? c.metrics.liquidityUsd;
    const liqDrop = evaluateRebuyLiquidityDrop({
      currentLiquidityUsd: curLiq,
      lastExitLiquidityUsd: last?.liquidityUsd,
      lastExitAtMs: last?.atMs,
      lastExitPnlPct: last?.pnlPct,
      nowMs,
      enabled: cfg.rebuyLiqDropEnabled,
      maxAgeMs: cfg.rebuyLiqDropMaxAgeMs,
      minDropPct: cfg.rebuyLiqDropMinDropPct,
      onlyAfterLoss: cfg.rebuyLiqDropOnlyAfterLoss,
    });
    if (!liqDrop.pass) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_rebuy_liq_drop_skip',
        mint: c.mint,
        symbol: c.symbol,
        lane: opts.lane,
        currentLiquidityUsd: curLiq ?? null,
        lastExitLiquidityUsd: last?.liquidityUsd ?? null,
        lastExitAtMs: last?.atMs ?? null,
        lastExitPnlPct: last?.pnlPct ?? null,
        reasons: liqDrop.reasons,
      });
      // Same rule (1.11.876). With `onlyAfterLoss` on, every liq-drop block is
      // already a losing exit, so the probe overrode the gate every single time.
      const liqLastExitWasLoss = last?.pnlPct != null && last.pnlPct < 0;
      if (!liqLastExitWasLoss && takeProbeSlot(cfg, nowMs)) {
        probeReason = 'rebuy_liq_drop';
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_probe_override',
          mint: c.mint,
          symbol: c.symbol,
          blockedBy: 'rebuy_liq_drop',
          probeUsd: cfg.probeBlockedUsd,
          reasons: liqDrop.reasons,
        });
        console.log(
          `[mild-dip] PROBE rebuy-liq ${c.symbol} mint=${c.mint.slice(0, 8)}… $${cfg.probeBlockedUsd}`,
        );
      } else {
        console.log(
          `[mild-dip] SKIP rebuy-liq ${c.symbol} mint=${c.mint.slice(0, 8)}… ${liqDrop.reasons.join(',')}`,
        );
        state.cooldownUntilMs[c.mint] = nowMs + softCd;
        return 'skip';
      }
    }
  }

  if (cfg.entryRequireStabilize && !entryStabilizeExemptDipSource(c.dipSource)) {
    const stabLookbackMs = Math.max(cfg.cooldownBounceLookbackMs, cfg.mintCooldownMs);
    const pt = mildDipPriceRing.troughAfterPeak(c.mint, stabLookbackMs, nowMs);
    const stabilize = evaluateEntryStabilizeRequired({
      freshPriceUsd: freshPx ?? entryPriceUsd,
      troughPriceUsd: pt?.trough.priceUsd ?? null,
      troughAtMs: pt?.trough.tsMs ?? null,
      nowMs,
      gates: {
        enabled: true,
        minBouncePct: cfg.knifeStabilizeMinBouncePct,
        quietMs: cfg.knifeStabilizeQuietMs,
        stabilizeBandPct: cfg.knifeStabilizeBandPct,
      },
    });
    if (!stabilize.pass) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_entry_stabilize_skip',
        mint: c.mint,
        symbol: c.symbol,
        lane: opts.lane,
        dipSource: c.dipSource,
        freshPriceUsd: freshPx ?? entryPriceUsd,
        troughPriceUsd: pt?.trough.priceUsd ?? null,
        reasons: stabilize.reasons,
      });
      console.log(
        `[mild-dip] SKIP stabilize ${c.symbol} mint=${c.mint.slice(0, 8)}… ${stabilize.reasons.join(',')}`,
      );
      state.cooldownUntilMs[c.mint] = nowMs + Math.min(softCd, 1_500);
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
      // 1.11.781 — do NOT blind 60s. Bounce can clear in seconds as price
      // dumps back to trough; a long softCd made us miss and only wake on
      // the next leader buy (~24s late on 5EAUpz). Gate is the bounce check.
      state.cooldownUntilMs[c.mint] = nowMs + Math.min(softCd, 1_500);
      return 'skip';
    }
  }

  /**
   * Rug risk is a sizing input. Our gates cannot see a rug coming (liq / mcap /
   * liq-mcap are identical between the 41 collapses and the other 733 trades),
   * but deep dump + hot turnover mark the class — and that is exactly what the
   * leaders we shadow take at a $1–4 clip while we were flat-sizing it.
   */
  const rugRisk = assessRugRisk({
    pc5mPct: entryPc5m,
    volume5mUsd: entryVol5m,
    liquidityUsd: sizeMetrics.liquidityUsd,
    gates: {
      knifeDumpPct: cfg.rugKnifeDumpPct,
      knifeTurn: cfg.rugKnifeTurn,
      blockDumpPct: cfg.rugBlockDumpPct,
    },
  });
  if (rugRisk.tier === 'blocked') {
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_rug_block_skip',
      mint: c.mint,
      symbol: c.symbol,
      lane: opts.lane,
      pc5m: entryPc5m ?? null,
      turn: rugRisk.turn,
      reasons: rugRisk.reasons,
    });
    console.log(
      `[mild-dip] SKIP rug ${c.symbol} mint=${c.mint.slice(0, 8)}… ${rugRisk.reasons.join(',')}`,
    );
    state.cooldownUntilMs[c.mint] = nowMs + softCd;
    return 'skip';
  }

  const wanted = resolveMildDipWantedSizeUsd({
    basePositionUsd: cfg.positionUsd,
    thick: {
      positionUsd: cfg.thickPositionUsd,
      minMarketCapUsd: cfg.thickMinMarketCapUsd,
      minLiquidityUsd: cfg.thickMinLiquidityUsd,
      minPairAgeHours: cfg.thickMinPairAgeHours,
    },
    // 1.11.746 — micro $15k–$50k @ $5 only on knife_stabilize (post-knife bounce).
    micro: mildDipMicroSizeGatesForSource(
      {
        positionUsd: cfg.microPositionUsd,
        minMarketCapUsd: cfg.microMinMarketCapUsd,
        maxMarketCapUsd: cfg.microMaxMarketCapUsd,
      },
      c.dipSource,
    ),
    metrics: sizeMetrics,
  });
  const knifeCapped =
    rugRisk.tier === 'knife' && cfg.rugKnifeClipUsd > 0
      ? Math.min(cfg.rugKnifeClipUsd, wanted.sizeUsd)
      : wanted.sizeUsd;
  /**
   * The green lane sizes itself. It is an unproven trade with a −6% stop and a
   * ten-minute ceiling, so it runs at its own small clip rather than the dip
   * lane's, and the rug-risk and probe caps still apply on top.
   */
  const isGreen = c.dipSource === 'green_momentum';
  /**
   * Movement baseline for the exit engine: the Dex mark standing next to the
   * fill, not the price that first qualified the candidate.
   *
   * 1.11.848 used `c.priceUsd`, which is the signal price. For a `wait_dip`
   * entry that signal is up to twenty minutes old and sits ~15% above the fill
   * by construction — the whole point of the seat is to buy below it. The bag
   * then opened with MFE already at −11%, so it could neither arm the trail nor
   * reach a ladder rung until the price climbed all the way back, and it simply
   * sat there (AENK1YJ9, Ggec8Zysy).
   *
   * A ring sample within this window is concurrent with the fill and is the
   * comparison the basis was meant to make. Anything older is dropped, which
   * leaves the fill price as the basis — the pre-1.11.848 behaviour.
   */
  const entryMarkSample = mildDipPriceRing.lastPrice(c.mint, nowMs);
  const entryMarkPriceUsd =
    entryMarkSample &&
    entryMarkSample.priceUsd > 0 &&
    nowMs - entryMarkSample.tsMs <= ENTRY_MARK_MAX_AGE_MS
      ? entryMarkSample.priceUsd
      : undefined;
  const laneCapped =
    isGreen && cfg.green.positionUsd > 0
      ? Math.min(cfg.green.positionUsd, knifeCapped)
      : knifeCapped;
  /**
   * 1.11.898 — the first position on a coin is sized down.
   *
   * Ordered by how many times we have traded a mint, our own closed positions:
   *
   *   trade #     n     USD/pos    median   win
   *   1st       565    -0.2050    -2.95%   44%
   *   2nd       318    -0.0486    +0.18%   50%
   *   3rd       205    -0.0418    +1.87%   52%
   *   4th-6th   375    -0.0219    +1.02%   53%
   *   7th+      595    -0.0266    +2.36%   54%
   *
   * The first touch carries -115.82 USD of a -164 total: five to ten times the
   * loss per position of any repeat, and it holds in every window (-0.134/pos
   * over 24h, -0.120 over 12h, while repeats run -0.019 to +0.047).
   *
   * The leaders are the mirror image - their first trip on a mint is their best
   * (median +20.56%, 65% win) and they then grind the name dozens of times, with
   * their top five mints carrying a third of all their round trips. We cannot
   * pick an unknown coin the way they can, so the first trade is priced as what
   * it is: the cost of finding out. It is not skipped, because without it there
   * are no repeats.
   */
  const firstTouch =
    cfg.firstTouchPositionUsd > 0 && !state.lastExitByMint?.[c.mint];
  const familiarityCapped = firstTouch
    ? Math.min(cfg.firstTouchPositionUsd, laneCapped)
    : laneCapped;
  const wantUsd = probeReason
    ? Math.min(cfg.probeBlockedUsd, familiarityCapped)
    : familiarityCapped;
  const sized = await args.resolveEntrySizeUsd(cfg, copyCfg, nowMs, wantUsd);
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
  if (state.open[c.mint]) return 'skip';
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
    // The peak lives in the mark series, like MFE; seeding it with the fill
    // would book the entry overpay as a gain already given back.
    peakPriceUsd: entryMarkPriceUsd ?? entryPriceUsd,
    entryMarkPriceUsd,
    lane: isGreen ? 'green' : 'dip',
    trailArmed: false,
    entryVolume5mUsd: c.metrics.volume5mUsd ?? null,
    entryLiquidityUsd: sizeMetrics.liquidityUsd ?? c.metrics.liquidityUsd ?? null,
    entryMarketCapUsd: c.metrics.marketCapUsd ?? null,
    entryPairAgeHours: c.metrics.pairAgeHours ?? null,
  };
  if (state.knifeWatch?.[c.mint]) delete state.knifeWatch[c.mint];
  // Keep waitDipWatch until fill succeeds — quote-premium reject must retry.
  saveMildDipState(cfg.statePath, state);
  const waitDipCeilingPx = isWaitDip
    ? waitDipMaxPriceUsd(
        c.waitDipSignalPriceUsd ?? c.priceUsd,
        cfg.waitDipPct,
        cfg.waitDipMaxOvershootPct,
      )
    : null;
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_buy_reserved',
    mint: c.mint,
    symbol: c.symbol,
    sizeUsd: sized.sizeUsd,
    priceUsd: entryPriceUsd,
    dipSource: c.dipSource,
    lane: opts.lane,
    waitDipSignalPriceUsd: c.waitDipSignalPriceUsd ?? null,
    waitDipMaxPriceUsd: waitDipCeilingPx,
    mildStabilizeBouncePct: c.mildStabilizeBouncePct ?? null,
    mildStabilizeDumpPct: c.mildStabilizeDumpPct ?? null,
  });

  const leaderSig = `milddip_${opts.lane}_${c.mint.slice(0, 8)}_${nowMs}`;
  const buyCopyCfg: CopyTraderConfig = isWaitDip
    ? {
        ...copyCfg,
        buyPriceMaxPremiumPct: cfg.waitDipQuotePremiumPct,
        quotePremiumGuardPct: cfg.waitDipQuotePremiumPct,
        quotePremiumFirstShotPct: 0,
        quotePremiumGraceMs: 0,
      }
    : copyCfg;
  // Jupiter guard anchors to signal ceiling (not ready mark).
  const buyLeaderPriceUsd =
    isWaitDip && waitDipCeilingPx != null && waitDipCeilingPx > 0
      ? waitDipCeilingPx
      : entryPriceUsd;
  let buy: Awaited<ReturnType<typeof executeCopyBuy>>;
  try {
    buy = await executeCopyBuy({
      cfg: buyCopyCfg,
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
            : isWaitDip
              ? `wait_dip_ceiling=${waitDipCeilingPx ?? 'n/a'}`
              : `mild_dip_pc5m=${entryPc5m?.toFixed(2) ?? 'n/a'}`,
        ],
        score: Math.abs(entryPc5m ?? c.mildStabilizeBouncePct ?? 0),
      },
      leaderSignature: leaderSig,
      leaderPriceUsd: buyLeaderPriceUsd,
      leaderBuyTs: nowMs,
    });
  } catch (err) {
    buyInFlight.delete(c.mint);
    // Buy threw — only drop reserved seat if chain is still empty (landed tx race).
    const rawAfterThrow = await fetchMintBalanceRaw(copyCfg, c.mint);
    const onchainAfterThrow =
      rawAfterThrow && /^\d+$/.test(rawAfterThrow) ? BigInt(rawAfterThrow) : 0n;
    if (onchainAfterThrow > HOLDING_DUST_RAW) {
      args.adoptOnChainHolding({
        cfg,
        state,
        mint: c.mint,
        symbol: c.symbol,
        tokenRaw: onchainAfterThrow.toString(),
        priceUsd: entryPriceUsd,
        pc5m: entryPc5m,
        nowMs,
      });
    } else {
      delete state.open[c.mint];
      state.cooldownUntilMs[c.mint] = nowMs + (isWaitDip ? Math.min(softCd, 1_500) : softCd);
      saveMildDipState(cfg.statePath, state);
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_buy_attempt',
      mint: c.mint,
      symbol: c.symbol,
      sizeUsd: sized.sizeUsd,
      priceUsd: entryPriceUsd,
      pc5m: entryPc5m,
      dipSource: c.dipSource,
      lane: opts.lane,
      waitDipSignalPriceUsd: c.waitDipSignalPriceUsd ?? null,
      waitDipMaxPriceUsd: waitDipCeilingPx,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      mode: cfg.executionMode,
      onchainRawAfterFail: onchainAfterThrow.toString(),
    });
    resetCopyFundingCache();
    return 'skip';
  }

  const fillPxJournal = buy.priceUsd || entryPriceUsd;
  const waitDipMarkDump =
    isWaitDip && c.waitDipSignalPriceUsd
      ? dumpFromSignalPct(c.priceUsd, c.waitDipSignalPriceUsd)
      : null;
  const waitDipFillDump =
    isWaitDip && c.waitDipSignalPriceUsd
      ? dumpFromSignalPct(fillPxJournal, c.waitDipSignalPriceUsd)
      : null;
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_buy_attempt',
    mint: c.mint,
    symbol: c.symbol,
    sizeUsd: sized.sizeUsd,
    priceUsd: fillPxJournal,
    signalPriceUsd: c.priceUsd,
    pc5m: entryPc5m,
    signalPc5m: c.metrics.priceChange5mPct,
    volume5mUsd: c.metrics.volume5mUsd,
    liquidityUsd: sizeMetrics.liquidityUsd,
    marketCapUsd: sizeMetrics.marketCapUsd,
    dipSource: c.dipSource,
    waitDipSignalPriceUsd: c.waitDipSignalPriceUsd ?? null,
    waitDipOriginalSource: c.waitDipOriginalSource ?? null,
    waitDipDumpFromSignalPct: c.waitDipDumpFromSignalPct ?? null,
    waitDipMarkDumpFromSignalPct: waitDipMarkDump,
    waitDipFillDumpFromSignalPct: waitDipFillDump,
    waitDipMaxPriceUsd: waitDipCeilingPx,
    lane: opts.lane,
    probe: probeReason,
    mildStabilizeBouncePct: c.mildStabilizeBouncePct ?? null,
    mildStabilizeDumpPct: c.mildStabilizeDumpPct ?? null,
    // 1.11.803 — full decision snapshot; without it post-hoc entry analysis
    // cannot separate a good dip from a bad one.
    entrySnapshot: {
      pc5m: entryPc5m,
      pc1h: c.metrics.priceChange1hPct ?? null,
      vol5m: entryVol5m,
      vol1h: c.metrics.volume1hUsd ?? null,
      liq: sizeMetrics.liquidityUsd ?? null,
      mcap: sizeMetrics.marketCapUsd ?? null,
      ageHours: sizeMetrics.pairAgeHours ?? null,
      dexId: c.metrics.dexId ?? null,
      buys5m: c.metrics.buys5m ?? null,
      sells5m: c.metrics.sells5m ?? null,
      dipSource: c.dipSource,
      turn: tdSnapshot?.turn ?? null,
      dump: tdSnapshot?.dump ?? null,
      tdBranch: tdSnapshot?.branch ?? null,
      tdResid: tdSnapshot?.resid ?? null,
      rugTier: rugRisk.tier,
      rugReasons: rugRisk.reasons,
      rugTurn: rugRisk.turn,
      streamDumpPct: streamDumpExtentPct(c.mint, cfg.cooldownBounceLookbackMs, nowMs),
      bounceFromTroughPct: mildDipPriceRing.bounceFromPostPeakTroughPct(
        c.mint,
        freshPx ?? entryPriceUsd,
        cfg.cooldownBounceLookbackMs,
        nowMs,
      ),
    },
    ok: buy.ok,
    reason: buy.reason ?? null,
    signature: buy.signature ?? null,
    mode: cfg.executionMode,
    usdcBefore: buy.usdcBefore ?? sized.usdc ?? null,
    usdcAfter: buy.usdcAfter ?? null,
    quoteSpentUsd: buy.quoteSpentUsd ?? null,
    feeSolBefore: buy.feeSolBefore ?? null,
    feeSolAfter: buy.feeSolAfter ?? null,
  });
  // Cash-accurate trades.jsonl — CF / PnL source of truth (not mark%).
  try {
    const wallet =
      cfg.walletPubkeyExpected?.trim() ||
      executionWalletPubkey(buyCopyCfg) ||
      'unknown';
    writeUsBuyFill({
      tradesPath: cfg.tradesPath,
      wallet,
      mint: c.mint,
      symbol: c.symbol,
      ok: buy.ok,
      signature: buy.signature ?? null,
      sizeUsdIntent: sized.sizeUsd,
      usdcBefore: buy.usdcBefore ?? sized.usdc ?? null,
      usdcAfter: buy.usdcAfter ?? null,
      feeSolBefore: buy.feeSolBefore ?? null,
      feeSolAfter: buy.feeSolAfter ?? null,
      quoteSpentUsd: buy.quoteSpentUsd ?? null,
      fillPriceUsd: fillPxJournal,
      reason: buy.reason ?? null,
      dipSource: c.dipSource,
      nowMs,
    });
  } catch {
    /* never block entry on journal IO */
  }

  if (!buy.ok) {
    buyInFlight.delete(c.mint);
    // Soft-fail buy must not orphan a landed fill (RPC/quote said no, chain yes).
    const rawAfterFail = await fetchMintBalanceRaw(copyCfg, c.mint);
    const onchainAfterFail =
      rawAfterFail && /^\d+$/.test(rawAfterFail) ? BigInt(rawAfterFail) : 0n;
    if (onchainAfterFail > HOLDING_DUST_RAW) {
      args.adoptOnChainHolding({
        cfg,
        state,
        mint: c.mint,
        symbol: c.symbol,
        tokenRaw: onchainAfterFail.toString(),
        priceUsd: buy.priceUsd || entryPriceUsd,
        pc5m: entryPc5m,
        nowMs,
      });
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_buy_fail_adopt',
        mint: c.mint,
        symbol: c.symbol,
        reason: buy.reason ?? null,
        tokenRaw: onchainAfterFail.toString(),
      });
    } else {
      delete state.open[c.mint];
      state.cooldownUntilMs[c.mint] = nowMs + (isWaitDip ? Math.min(softCd, 1_500) : softCd);
      saveMildDipState(cfg.statePath, state);
    }
    resetCopyFundingCache();
    return 'skip';
  }

  if (state.waitDipWatch?.[c.mint]) delete state.waitDipWatch[c.mint];

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
    peakPriceUsd: entryMarkPriceUsd ?? fillPx,
    entryMarkPriceUsd,
    lane: isGreen ? 'green' : 'dip',
    trailArmed: false,
    entryVolume5mUsd: c.metrics.volume5mUsd ?? null,
    entryLiquidityUsd: sizeMetrics.liquidityUsd ?? c.metrics.liquidityUsd ?? null,
    entryMarketCapUsd: c.metrics.marketCapUsd ?? null,
    entryPairAgeHours: c.metrics.pairAgeHours ?? null,
  };
  // Seed exit mark ring so stream-only marks have a print before first swap decode.
  mildDipPriceRing.note(c.mint, fillPx, { tsMs: nowMs, source: 'dex' });
  buyInFlight.delete(c.mint);
  saveMildDipState(cfg.statePath, state);
  resetCopyFundingCache();
  const tierTag =
    wanted.tier === 'thick' ? ' thick' : wanted.tier === 'micro' ? ' micro' : '';
  console.log(
    `[mild-dip] BUY ${c.symbol} mint=${c.mint.slice(0, 8)}… $${sized.sizeUsd}` +
      `${tierTag} ` +
      (isMildStabilize
        ? `bounce=${c.mildStabilizeBouncePct?.toFixed(1)}% dump=${c.mildStabilizeDumpPct?.toFixed(1)}%`
        : `pc5m=${entryPc5m?.toFixed(1)}`) +
      ` @$${fillPx.toPrecision(4)} lane=${opts.lane} mode=${cfg.executionMode}`,
  );
  return 'filled';
}
