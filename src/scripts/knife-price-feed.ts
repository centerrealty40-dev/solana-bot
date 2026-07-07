/**
 * Knife-catcher price feed — swap-decode ticks + Jupiter buy-quote poll with cross-source sanity.
 */
import { child } from '../core/logger.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { jupiterQuoteBuyPriceUsd } from '../papertrader/pricing/price-verify.js';
import type { ShyftObservationMeta } from '../papertrader/stream/shyft-shadow-consumer.js';

const log = child('knife-price-feed');

/** Swap tick considered "fresh" for Jupiter cross-source comparison. */
const SWAP_FRESH_MS = 120_000;

export type KnifePriceTick = {
  priceUsd: number;
  tsMs: number;
  source: 'swap' | 'jupiter';
  meta?: ShyftObservationMeta;
};

interface MintPriceState {
  lastSwap?: KnifePriceTick;
  lastJupiter?: KnifePriceTick;
}

const mintState = new Map<string, MintPriceState>();

export function recordKnifePrice(
  mint: string,
  priceUsd: number,
  tsMs: number,
  meta?: ShyftObservationMeta,
): void {
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
  const s = mintState.get(mint) ?? {};
  s.lastSwap = { priceUsd, tsMs, source: 'swap', meta };
  mintState.set(mint, s);
}

function recordKnifeJupiterPrice(mint: string, priceUsd: number, tsMs: number): void {
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
  const s = mintState.get(mint) ?? {};
  s.lastJupiter = { priceUsd, tsMs, source: 'jupiter' };
  mintState.set(mint, s);
}

function freshSwap(state: MintPriceState | undefined, nowMs: number): KnifePriceTick | null {
  const swap = state?.lastSwap;
  if (!swap || nowMs - swap.tsMs > SWAP_FRESH_MS) return null;
  return swap;
}

function crossSourceDivPct(a: number, b: number): number {
  if (!(b > 0)) return Infinity;
  return (Math.abs(a - b) / b) * 100;
}

/**
 * Best price tick for knife logic. Prefers fresh swap; rejects Jupiter when > crossSourceMaxPct off fresh swap.
 */
export function getKnifeCrossSourceTick(
  mint: string,
  crossSourceMaxPct = 30,
  nowMs = Date.now(),
): KnifePriceTick | null {
  const state = mintState.get(mint);
  if (!state) return null;

  const swapNow = freshSwap(state, nowMs);
  const jup = state.lastJupiter;

  if (swapNow && jup) {
    if (crossSourceDivPct(jup.priceUsd, swapNow.priceUsd) > crossSourceMaxPct) {
      return swapNow;
    }
    return swapNow;
  }
  if (swapNow) return swapNow;

  if (jup && state.lastSwap) {
    if (crossSourceDivPct(jup.priceUsd, state.lastSwap.priceUsd) > crossSourceMaxPct) {
      return state.lastSwap;
    }
    return jup;
  }

  return jup ?? state.lastSwap ?? null;
}

export interface KnifeJupiterPollConfig {
  legUsd: number;
  pollIntervalMs: number;
  slippageBps: number;
  timeoutMs: number;
  crossSourceMaxPct: number;
  maxMintsPerTick: number;
}

export function startKnifeJupiterPoll(
  cfg: KnifeJupiterPollConfig,
  getWatchedMints: () => string[],
  onTick?: (mint: string, priceUsd: number, tsMs: number) => void,
): { stop: () => void } {
  let stopped = false;
  let roundRobin = 0;

  const pollOnce = async (): Promise<void> => {
    if (stopped) return;
    const solUsd = getSolUsd();
    if (!(solUsd > 0)) return;

    const mints = getWatchedMints();
    if (mints.length === 0) return;

    const startIdx = roundRobin % mints.length;
    roundRobin += 1;
    let polled = 0;

    for (let i = 0; i < mints.length && polled < cfg.maxMintsPerTick; i += 1) {
      const mint = mints[(startIdx + i) % mints.length]!;
      polled += 1;
      try {
        const swapRef = getKnifeCrossSourceTick(mint, cfg.crossSourceMaxPct);
        const snapshotPx = swapRef?.priceUsd ?? 1;
        const q = await jupiterQuoteBuyPriceUsd({
          mint,
          outMintDecimals: 6,
          sizeUsd: cfg.legUsd,
          solUsd,
          snapshotPriceUsd: snapshotPx,
          slippageBps: cfg.slippageBps,
          timeoutMs: cfg.timeoutMs,
        });
        if (q.kind !== 'ok' || q.jupiterPriceUsd == null || !(q.jupiterPriceUsd > 0)) continue;

        const now = Date.now();
        const fresh = freshSwap(mintState.get(mint), now);
        if (fresh && crossSourceDivPct(q.jupiterPriceUsd, fresh.priceUsd) > cfg.crossSourceMaxPct) {
          log.debug(
            { mint, jupiter: q.jupiterPriceUsd, swap: fresh.priceUsd },
            'knife jupiter rejected — cross-source divergence',
          );
          continue;
        }

        recordKnifeJupiterPrice(mint, q.jupiterPriceUsd, now);
        const tick = getKnifeCrossSourceTick(mint, cfg.crossSourceMaxPct, now);
        if (tick) onTick?.(mint, tick.priceUsd, now);
      } catch (e) {
        log.debug({ mint, err: (e as Error).message }, 'knife jupiter poll failed');
      }
    }
  };

  const timer = setInterval(() => {
    void pollOnce();
  }, cfg.pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  void pollOnce();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Vitest / isolated runs. */
export function __resetKnifePriceFeedForTests(): void {
  mintState.clear();
}
