/**
 * Background Jupiter sell-quote → price ring for open bags.
 *
 * Stream swaps and Dex polls can go quiet through a green reclaim (4kZdVs:
 * ring held Dex-only while price ran +16% off trough). A rate-limited sell
 * quote is the executable mark Oscar uses elsewhere (`priceVerifyExit`).
 */
import { getSolUsd } from '../papertrader/pricing.js';
import { jupiterQuoteSellPriceUsd } from '../papertrader/pricing/price-verify.js';
import { mildDipPriceRing } from './price-ring.js';

const lastAttemptMs = new Map<string, number>();
const inFlight = new Set<string>();
let gateSkipped = 0;

export function __resetOpenMarkJupiterRefreshForTests(): void {
  lastAttemptMs.clear();
  inFlight.clear();
  gateSkipped = 0;
}

export function openMarkJupiterRefreshInFlightCount(): number {
  return inFlight.size;
}

export function openMarkJupiterRefreshGateSkippedCount(): number {
  return gateSkipped;
}

/**
 * Fire-and-forget Jupiter sell quote → ring (source=dex — executable mid).
 */
export function requestOpenMarkJupiterRefresh(args: {
  mint: string;
  nowMs: number;
  minGapMs: number;
  maxInFlight: number;
  probeUsd: number;
  slippageBps: number;
  snapshotPriceUsd: number;
  tokenDecimals?: number;
}): boolean {
  const mint = args.mint;
  if (!mint || mint.length < 32) return false;
  const minGap = args.minGapMs > 0 ? args.minGapMs : 2_000;
  const maxInFlight = args.maxInFlight > 0 ? args.maxInFlight : 2;
  if (inFlight.has(mint)) return false;
  if (inFlight.size >= maxInFlight) return false;
  const last = lastAttemptMs.get(mint) ?? 0;
  if (args.nowMs - last < minGap) return false;
  if (!(args.snapshotPriceUsd > 0) || !(args.probeUsd > 0)) return false;

  const solUsd = getSolUsd();
  if (!(solUsd > 0)) return false;

  lastAttemptMs.set(mint, args.nowMs);
  inFlight.add(mint);

  void jupiterQuoteSellPriceUsd({
    mint,
    tokenDecimals: args.tokenDecimals ?? 6,
    usdNotional: args.probeUsd,
    solUsd,
    snapshotPriceUsd: args.snapshotPriceUsd,
    slippageBps: args.slippageBps > 0 ? args.slippageBps : 150,
    timeoutMs: 4_000,
    priority: 'background',
  })
    .then((verdict) => {
      if (verdict.kind === 'skipped' && verdict.reason === 'gate-busy') {
        gateSkipped += 1;
        lastAttemptMs.delete(mint);
        return;
      }
      if (verdict.kind !== 'ok' || !(verdict.jupiterPriceUsd > 0)) return;
      mildDipPriceRing.note(mint, verdict.jupiterPriceUsd, {
        tsMs: Date.now(),
        source: 'dex',
      });
    })
    .catch(() => {
      /* next gap retries */
    })
    .finally(() => {
      inFlight.delete(mint);
    });

  return true;
}

/** True when stream has been quiet long enough to warrant a Jupiter top-up. */
export function openMarkNeedsJupiterTopUp(
  mint: string,
  nowMs: number,
  streamQuietMs: number,
): boolean {
  if (!(streamQuietMs > 0)) return true;
  const stream = mildDipPriceRing.lastPriceBySource(mint, 'stream', nowMs, streamQuietMs);
  return stream == null;
}
