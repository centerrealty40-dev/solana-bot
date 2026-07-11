/**
 * Knife-catcher trusted price feed.
 *
 * Contract: position logic, buffer, entries, exits, and PnL use **trusted** prices only.
 * - Jupiter buy-quote (leg notional) is the primary trusted source.
 * - Stream swap_decode may adopt a tick only when fresh Jupiter agrees within crossSourceMaxPct
 *   and the move vs last trusted tick is within maxTickMovePct.
 * - Raw stream prices never reach the trading buffer or sellChunk.
 */
import { child } from '../core/logger.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { jupiterQuoteBuyPriceUsd } from '../papertrader/pricing/price-verify.js';

const log = child('knife-price-feed');

export const KNIFE_JUPITER_MAX_AGE_MS = 25_000;

export type KnifePriceSource = 'jupiter' | 'swap_validated';

export type KnifeTrustedTick = {
  priceUsd: number;
  tsMs: number;
  source: KnifePriceSource;
};

export type KnifePriceRejectReason =
  | 'invalid_number'
  | 'no_jupiter_anchor'
  | 'jupiter_stale'
  | 'cross_source_divergence'
  | 'tick_jump';

type MintPriceState = {
  lastJupiter?: KnifeTrustedTick;
  lastTrusted?: KnifeTrustedTick;
};

const mintState = new Map<string, MintPriceState>();

export function crossSourceDivPct(a: number, b: number): number {
  if (!(b > 0)) return Infinity;
  return (Math.abs(a - b) / b) * 100;
}

export function priceMovePct(prev: number, next: number): number {
  if (!(prev > 0)) return Infinity;
  return (Math.abs(next - prev) / prev) * 100;
}

function freshJupiter(state: MintPriceState | undefined, nowMs: number): KnifeTrustedTick | null {
  const j = state?.lastJupiter;
  if (!j || nowMs - j.tsMs > KNIFE_JUPITER_MAX_AGE_MS) return null;
  return j;
}

export function adoptKnifeJupiterPrice(mint: string, priceUsd: number, tsMs: number): boolean {
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return false;
  const s = mintState.get(mint) ?? {};
  const tick: KnifeTrustedTick = { priceUsd, tsMs, source: 'jupiter' };
  s.lastJupiter = tick;
  s.lastTrusted = tick;
  mintState.set(mint, s);
  return true;
}

export function tryAdoptKnifeSwapPrice(
  mint: string,
  priceUsd: number,
  tsMs: number,
  crossSourceMaxPct: number,
  maxTickMovePct: number,
): { ok: true; tick: KnifeTrustedTick } | { ok: false; reason: KnifePriceRejectReason } {
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) {
    return { ok: false, reason: 'invalid_number' };
  }

  const s = mintState.get(mint) ?? {};
  const jup = freshJupiter(s, tsMs);
  if (!jup) return { ok: false, reason: 'no_jupiter_anchor' };

  if (crossSourceDivPct(priceUsd, jup.priceUsd) > crossSourceMaxPct) {
    return { ok: false, reason: 'cross_source_divergence' };
  }

  const prev = s.lastTrusted;
  if (prev && priceMovePct(prev.priceUsd, priceUsd) > maxTickMovePct) {
    return { ok: false, reason: 'tick_jump' };
  }

  const tick: KnifeTrustedTick = { priceUsd, tsMs, source: 'swap_validated' };
  s.lastTrusted = tick;
  mintState.set(mint, s);
  return { ok: true, tick };
}

/** Latest trusted tick for trading (Jupiter or swap validated against Jupiter). */
export function getKnifeTrustedPrice(mint: string, nowMs = Date.now()): KnifeTrustedTick | null {
  const s = mintState.get(mint);
  const trusted = s?.lastTrusted;
  if (!trusted) return null;
  if (trusted.source === 'jupiter') {
    return nowMs - trusted.tsMs <= KNIFE_JUPITER_MAX_AGE_MS ? trusted : null;
  }
  const jup = freshJupiter(s, nowMs);
  if (!jup) return null;
  if (crossSourceDivPct(trusted.priceUsd, jup.priceUsd) > 50) return null;
  return trusted;
}

export function getKnifeFreshJupiterPrice(mint: string, nowMs = Date.now()): KnifeTrustedTick | null {
  return freshJupiter(mintState.get(mint), nowMs);
}

export function isKnifeExitPriceSane(price: number, avgEntry: number, maxExitMovePct: number): boolean {
  if (!(price > 0) || !(avgEntry > 0)) return false;
  return priceMovePct(avgEntry, price) <= maxExitMovePct;
}

/** TP/trail: reject single-tick spike vs last in-position Jupiter mark. */
export function isKnifeTpTickSane(price: number, lastMarkPrice: number, maxTpTickMovePct: number): boolean {
  if (!(lastMarkPrice > 0)) return true;
  return priceMovePct(lastMarkPrice, price) <= maxTpTickMovePct;
}

export interface KnifeJupiterPollConfig {
  legUsd: number;
  pollIntervalMs: number;
  slippageBps: number;
  timeoutMs: number;
  maxMintsPerTick: number;
}

export function startKnifeJupiterPoll(
  cfg: KnifeJupiterPollConfig,
  getWatchedMints: () => string[],
  onTrustedTick: (mint: string, priceUsd: number, tsMs: number) => void,
): { stop: () => void } {
  let stopped = false;
  let roundRobin = 0;
  /**
   * Only one poll cycle in flight at a time. Without this, `setInterval` fires a new cycle every
   * `pollIntervalMs` even while the previous is still awaiting Jupiter quotes. When quotes are slow
   * (e.g. the shared cross-process Jupiter rate-gate is contended), cycles overlap and each reserves
   * up to `maxMintsPerTick` future gate slots — the gate's `nextAllowedMs` then runs minutes/hours
   * into the future (starving *all* Jupiter callers, incl. live-oscar), while thousands of pending
   * awaiters pile up in this process → multi-GB RSS → kernel OOM. The guard caps knife to at most one
   * sequential quote chain, so it can never reserve slots faster than the gate grants them.
   */
  let inFlight = false;

  const pollOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;
    const solUsd = getSolUsd();
    if (!(solUsd > 0)) return;
    inFlight = true;
    try {
      await pollCycle(solUsd);
    } finally {
      inFlight = false;
    }
  };

  const pollCycle = async (solUsd: number): Promise<void> => {
    const mints = getWatchedMints();
    if (mints.length === 0) return;

    const startIdx = roundRobin % mints.length;
    roundRobin += 1;
    const limit = Math.max(1, Math.min(mints.length, cfg.maxMintsPerTick));
    let polled = 0;

    for (let i = 0; i < mints.length && polled < limit; i += 1) {
      const mint = mints[(startIdx + i) % mints.length]!;
      polled += 1;
      try {
        const anchor = getKnifeTrustedPrice(mint) ?? getKnifeFreshJupiterPrice(mint);
        const snapshotPx = anchor?.priceUsd ?? 0;
        const q = await jupiterQuoteBuyPriceUsd({
          mint,
          outMintDecimals: 6,
          sizeUsd: cfg.legUsd,
          solUsd,
          snapshotPriceUsd: snapshotPx > 0 ? snapshotPx : 1,
          slippageBps: cfg.slippageBps,
          timeoutMs: cfg.timeoutMs,
        });
        if (q.kind !== 'ok' || q.jupiterPriceUsd == null || !(q.jupiterPriceUsd > 0)) continue;

        const now = Date.now();
        if (!adoptKnifeJupiterPrice(mint, q.jupiterPriceUsd, now)) continue;
        onTrustedTick(mint, q.jupiterPriceUsd, now);
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
