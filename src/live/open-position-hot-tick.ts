/**
 * 1.11.458 — hot tick for open positions: executable sell price + killstop pre-arm (Phase 1).
 */
import type { PaperTraderConfig } from '../papertrader/config.js';
import type { OpenTrade } from '../papertrader/types.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { cfgEffectiveForOpen } from '../papertrader/cfg-effective-for-open.js';
import { dcaKillstopEffective } from '../papertrader/executor/tp-grid-effective.js';
import {
  isRunnerProbeExitPolicy,
  runnerProbeKillEligible,
  runnerProbeTpEligible,
} from '../papertrader/executor/exit-policy-runner-probe.js';
import { mintFromOpenMapKey, runnerProbeOpenMapKey } from '../papertrader/live-oscar-runner-probe.js';
import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { liveSellQuoteAndPrepareSnapshot } from './jupiter.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';
import { tokenAmountRawFromUsd } from './phase4-execution.js';
import {
  sellUsdPerTokenFromQuote,
  setOpenPositionExecSellUsd,
  clearOpenPositionExecSellUsd,
  wsolOutLamportsFromJupiterSellQuote,
  listOpenPositionExecPriceMints,
} from './open-position-exec-price.js';
import { setArmedSellQuote } from './sell-quote-prearm.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';
import {
  journalRemainingUsd,
  oscarChainUsdFromRaw,
  planFullExitUsdNotional,
  resyncRemainingFractionFromChain,
  liveWalletBalanceReconcileMinUsd,
  shouldForceCloseJournalZeroChainTail,
  WALLET_RECONCILE_REMAINING_EPS,
} from './wallet-balance-exit-reconcile.js';

const log = child('open-position-hot-tick');

export interface LiveOpenPositionHotTickContext {
  liveCfg: LiveOscarConfig;
  paperCfg: PaperTraderConfig;
  getOpen: () => Map<string, OpenTrade>;
  isTrackerBusy: () => boolean;
  runTrackerTick: () => Promise<void>;
}

export type LiveOpenPositionHotTickPaperContext = Omit<LiveOpenPositionHotTickContext, 'liveCfg'>;

function signerPk(liveCfg: LiveOscarConfig): string {
  const s = liveCfg.walletSecret?.trim();
  if (!s) throw new Error('LIVE_WALLET_SECRET missing for hot tick');
  return loadLiveKeypairFromSecretEnv(s).publicKey.toBase58();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeExecutableSellUsd(args: {
  liveCfg: LiveOscarConfig;
  ot: OpenTrade;
  mint: string;
  solUsd: number;
  userPublicKey: string;
}): Promise<{ sellUsd: number; tokenRaw: string; quoteAgeMs: number; wsolLamports: bigint } | null> {
  const { liveCfg, ot, mint, solUsd, userPublicKey } = args;
  const dec = ot.tokenDecimals ?? 6;
  let chainOscarUsd = 0;
  if (liveCfg.executionMode === 'live') {
    const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
    const chainAmt = chainMap?.get(mint) ?? 0n;
    if (chainAmt > 0n) {
      const px = ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.avgEntry;
      chainOscarUsd = oscarChainUsdFromRaw({
        raw: chainAmt,
        decimals: dec,
        priceUsd: px > 0 ? px : ot.avgEntry,
        mint,
      }).oscarUsd;
      resyncRemainingFractionFromChain({
        ot,
        chainOscarUsd,
        minUsd: liveWalletBalanceReconcileMinUsd(liveCfg),
      });
    }
  }
  const remUsd = Math.max(
    liveCfg.liveOpenHotProbeMinUsd,
    planFullExitUsdNotional({ ot, chainOscarUsd }),
  );
  const probeUsd = Math.max(
    liveCfg.liveOpenHotProbeMinUsd,
    Math.min(liveCfg.liveOpenHotProbeMaxUsd, remUsd * liveCfg.liveOpenHotProbeFraction),
  );
  let tokenRaw = tokenAmountRawFromUsd(probeUsd, ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.avgEntry, dec);
  if (!tokenRaw) return null;

  if (liveCfg.executionMode === 'live') {
    const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
    if (!chainMap) return null;
    const chainAmt = chainMap.get(mint) ?? 0n;
    if (chainAmt === 0n) return null;
    const computed = BigInt(tokenRaw);
    const capped = computed < chainAmt ? computed : chainAmt;
    tokenRaw = capped.toString();
  }

  const t0 = Date.now();
  const prep = await liveSellQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    inputMint: mint,
    tokenAmountRaw: tokenRaw,
    solUsd,
    userPublicKey,
  });
  const quoteAgeMs = Date.now() - t0;
  if (!prep?.quoteResponse) return null;
  const wsolLamports = wsolOutLamportsFromJupiterSellQuote(prep.quoteResponse);
  if (wsolLamports == null) return null;
  const sellUsd = sellUsdPerTokenFromQuote({
    wsolOutLamports: wsolLamports,
    tokenAmountRaw: BigInt(tokenRaw),
    solUsd,
    decimals: dec,
  });
  if (sellUsd == null) return null;
  return { sellUsd, tokenRaw, quoteAgeMs, wsolLamports };
}

async function maybePrearmKillstopSell(args: {
  liveCfg: LiveOscarConfig;
  paperCfg: PaperTraderConfig;
  ot: OpenTrade;
  mint: string;
  sellUsd: number;
  solUsd: number;
  userPublicKey: string;
}): Promise<void> {
  const { liveCfg, paperCfg, ot, mint, sellUsd, solUsd, userPublicKey } = args;
  if (!(ot.avgEntry > 0) || liveCfg.liveKillstopPrearmBufferPct <= 0) return;
  const effCfg = cfgEffectiveForOpen(paperCfg, ot);
  const killEff = dcaKillstopEffective(ot, effCfg);
  if (!(killEff < 0)) return;
  const pnlFrac = sellUsd / ot.avgEntry - 1;
  const prearmFrac = killEff + liveCfg.liveKillstopPrearmBufferPct / 100;
  if (pnlFrac > prearmFrac) return;

  const dec = ot.tokenDecimals ?? 6;
  let fullRaw: string | null = null;
  if (liveCfg.executionMode === 'live') {
    const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
    const chainAmt = chainMap?.get(mint);
    if (!chainAmt || chainAmt === 0n) return;
    fullRaw = chainAmt.toString();
  } else {
    const remUsd = ot.totalInvestedUsd * Math.max(0.05, ot.remainingFraction);
    fullRaw = tokenAmountRawFromUsd(remUsd, sellUsd, dec);
  }
  if (!fullRaw) return;

  const prep = await liveSellQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    inputMint: mint,
    tokenAmountRaw: fullRaw,
    solUsd,
    userPublicKey,
  });
  if (!prep?.swapBuild.ok) return;
  const ttlMs = liveCfg.liveKillstopPrearmTtlMs;
  const now = Date.now();
  setArmedSellQuote(mint, {
    armedAtMs: now,
    expiresAtMs: now + ttlMs,
    quoteResponse: prep.quoteResponse,
    quoteSnapshot: { ...prep.quoteSnapshot, killstopPrearm: true },
    swapBuildB64: prep.swapBuild.b64,
    intentKind: 'sell_full',
    tokenAmountRaw: fullRaw,
  });
  appendLiveJsonlEvent({
    kind: 'live_killstop_prearm',
    mint,
    pnlFracVsAvg: +((pnlFrac * 100).toFixed(2)),
    killEffPct: +(killEff * 100).toFixed(2),
    sellUsdPerToken: sellUsd,
    ttlMs,
  });
}

export function startLiveOpenPositionHotTick(ctx: LiveOpenPositionHotTickContext): NodeJS.Timeout | null {
  const { liveCfg, paperCfg } = ctx;
  if (!liveCfg.liveOpenHotTickEnabled) return null;
  if (liveCfg.executionMode !== 'live' || !liveCfg.strategyEnabled) return null;
  const intervalMs = liveCfg.liveOpenHotTickIntervalMs;
  if (!(intervalMs > 0)) return null;

  let running = false;
  let pk: string | null = null;

  async function runTick(): Promise<void> {
    if (running || ctx.isTrackerBusy()) return;
    running = true;
    let killTrigger = false;
    let tpTrigger = false;
    let stuckSmallTailTrigger = false;
    try {
      const open = ctx.getOpen();
      if (open.size === 0) return;
      for (const cachedMint of listOpenPositionExecPriceMints()) {
        if (!open.has(cachedMint) && !open.has(runnerProbeOpenMapKey(cachedMint))) {
          clearOpenPositionExecSellUsd(cachedMint);
        }
      }
      if (!pk) pk = signerPk(liveCfg);
      const solUsd = getSolUsd() ?? 0;
      if (!(solUsd > 0)) return;

      for (const [openKey, ot] of open) {
        if (!ot) continue;
        const mint = mintFromOpenMapKey(openKey);
        if (
          liveCfg.executionMode === 'live' &&
          ot.remainingFraction <= WALLET_RECONCILE_REMAINING_EPS
        ) {
          const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
          const raw = chainMap?.get(mint) ?? 0n;
          const hintPx =
            ot.lastObservedPriceUsd ??
            (ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.avgEntry);
          if (raw > 0n && hintPx > 0) {
            const oscarUsd = oscarChainUsdFromRaw({
              raw,
              decimals: ot.tokenDecimals ?? 6,
              priceUsd: hintPx,
              mint,
            }).oscarUsd;
            resyncRemainingFractionFromChain({
              ot,
              chainOscarUsd: oscarUsd,
              minUsd: liveWalletBalanceReconcileMinUsd(liveCfg),
            });
          }
        }
        if (
          liveCfg.executionMode === 'live' &&
          ot.partialSells.length > 0 &&
          !stuckSmallTailTrigger
        ) {
          const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
          const raw = chainMap?.get(mint) ?? 0n;
          const hintPx =
            ot.lastObservedPriceUsd ??
            (ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.avgEntry);
          if (raw > 0n && hintPx > 0) {
            const oscarUsd = oscarChainUsdFromRaw({
              raw,
              decimals: ot.tokenDecimals ?? 6,
              priceUsd: hintPx,
              mint,
            }).oscarUsd;
            if (
              shouldForceCloseJournalZeroChainTail({
                remainingFraction: ot.remainingFraction,
                chainOscarUsd: oscarUsd,
                journalRemainingUsd: journalRemainingUsd(ot),
                minUsd: liveWalletBalanceReconcileMinUsd(liveCfg),
                tailFlushThresholdUsd: liveCfg.liveTailFlushThresholdUsd,
                partialSellCount: ot.partialSells.length,
              })
            ) {
              stuckSmallTailTrigger = true;
            }
          }
        }
        if (ot.remainingFraction <= WALLET_RECONCILE_REMAINING_EPS) continue;
        try {
          const probe = await probeExecutableSellUsd({
            liveCfg,
            ot,
            mint,
            solUsd,
            userPublicKey: pk,
          });
          if (!probe) continue;
          setOpenPositionExecSellUsd(mint, {
            mint,
            sellUsdPerToken: probe.sellUsd,
            quoteAgeMs: probe.quoteAgeMs,
            updatedAtMs: Date.now(),
            probeTokenRaw: probe.tokenRaw,
            wsolOutLamports: probe.wsolLamports.toString(),
          });

          if (ot.avgEntry > 0) {
            const effCfg = cfgEffectiveForOpen(paperCfg, ot);
            const killEff = dcaKillstopEffective(ot, effCfg);
            const pnlPct = (probe.sellUsd / ot.avgEntry - 1) * 100;
            if (isRunnerProbeExitPolicy(ot)) {
              if (runnerProbeKillEligible(ot, probe.sellUsd, ot.lastObservedPriceUsd ?? 0, paperCfg)) {
                killTrigger = true;
              } else if (runnerProbeTpEligible(ot, probe.sellUsd, ot.lastObservedPriceUsd ?? 0, paperCfg)) {
                tpTrigger = true;
              }
            } else if (killEff < 0 && pnlPct / 100 <= killEff) {
              killTrigger = true;
            }
          }

          void maybePrearmKillstopSell({
            liveCfg,
            paperCfg,
            ot,
            mint,
            sellUsd: probe.sellUsd,
            solUsd,
            userPublicKey: pk,
          }).catch((e) =>
            log.warn({ mint: mint.slice(0, 8), err: String(e) }, 'killstop prearm failed'),
          );
        } catch (e) {
          log.warn({ mint: mint.slice(0, 8), err: String(e) }, 'hot tick sell probe failed');
        }
        if (liveCfg.liveOpenHotInterMintDelayMs > 0) {
          await sleep(liveCfg.liveOpenHotInterMintDelayMs);
        }
      }

      if ((killTrigger || tpTrigger || stuckSmallTailTrigger) && !ctx.isTrackerBusy()) {
        await ctx.runTrackerTick();
      }
    } finally {
      running = false;
    }
  }

  void runTick();
  return setInterval(() => {
    void runTick();
  }, intervalMs);
}
