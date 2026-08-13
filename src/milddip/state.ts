import fs from 'node:fs';
import path from 'node:path';
import type { KnifeWatchEntry } from './knife-stabilize.js';
import type { WaitDipWatchEntry } from './wait-dip.js';
import type { MildDipCandidateMetrics } from './gates.js';

export type MildDipOpenPosition = {
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  sizeUsd: number;
  tokenRaw: string | null;
  openedAtMs: number;
  entryPc5mPct: number | null;
  buySignature: string | null;
  /** Running high-water mark from entry (W9.1). */
  peakPriceUsd?: number;
  /**
   * 1.11.848 — the Dex price the entry decision was made on.
   *
   * Marks and fills do not share a scale: a stale or different-pool snapshot can
   * sit well above what Jupiter gave us, and measuring the gap as gain reads a
   * motionless price as instant profit. MFE / arm / giveback measure from this
   * so that only movement inside the mark series counts. `entryPriceUsd` keeps
   * serving P&L, where the money actually is.
   */
  entryMarkPriceUsd?: number;
  /**
   * 1.11.849 — rungs of the unbounded TP ladder already filled. Unlike
   * `mfeBankStage` this is not capped: rung 9 is +72% MFE at an 8% step.
   */
  tpRungsDone?: number;
  /**
   * 1.11.860 — which lane opened this bag. `green` is a momentum entry and is
   * managed by `decideGreenExit`, not by the dip ladder: the tape says those
   * names are done within minutes either way, so a trail would only donate.
   */
  lane?: 'dip' | 'green';
  /**
   * 1.11.852 — last mark accepted for this bag, and a quarantined one awaiting
   * confirmation. A single stream print collapsed 5.6420e-04 to 3.2402e-04
   * (−42.57% in one tick) on a bag sitting at +21.75%, fired the −25% stop and
   * closed it while the name kept climbing. A move that large has to be seen
   * twice before it decides anything.
   */
  lastMarkPriceUsd?: number;
  pendingMarkPriceUsd?: number;
  /**
   * 1.11.889 — which feed the quarantined print came from. Two byte-identical
   * prints from one feed are a stale value read twice, not a market at that
   * price, so they may not confirm each other.
   */
  pendingMarkSource?: 'stream' | 'dex';
  /** Running low-water mark from entry (never-arm bounce / freefall). */
  postEntryTroughUsd?: number;
  /** When postEntryTroughUsd was last deepened. */
  postEntryTroughAtMs?: number;
  /** W9.1 trail armed after MFE ≥ armPct. */
  trailArmed?: boolean;
  /** True after a successful partial scale-out (half bag sold). */
  scaleOutDone?: boolean;
  /**
   * MFE-bank ladder progress: 0/undefined = none, 1 = bank1 filled, 2 = bank2 filled.
   * Sleeve trail owns the remainder after stage ≥ 1 (wide giveback).
   */
  mfeBankStage?: number;
  /** 5m Dex volume at entry — baseline for the activity-fade exit. */
  entryVolume5mUsd?: number | null;
  /** Dex liquidity at entry — fallback baseline for exit → rebuy liq-drop. */
  entryLiquidityUsd?: number | null;
  /**
   * 1.11.874 — carried so the exit path can ask the entry gate whether it would
   * open this position now. Market cap is scaled by the price move since entry,
   * pair age grows with the hold; neither is re-read on the mark path.
   */
  entryMarketCapUsd?: number | null;
  entryPairAgeHours?: number | null;
  /**
   * 1.11.879 — when this bag last sold. A partial changes the size on chain and
   * the balance read lags, so the next decision has to wait for data that
   * postdates the sell; two `never_arm_bounce` legs fired 4.1s apart on 33Grh5V
   * / 2HJmyTW, the second on a reading from before the first.
   */
  lastSellAtMs?: number;
  /** Cumulative ms this bag has held a soft exit because the gate still passes. */
  exitDeferredMs?: number;
  /** Wall clock of the last such deferral, for accumulating the budget. */
  exitDeferredAtMs?: number;
  /**
   * Spaced Dex vol5m samples (≥5m apart) for sustained `never_arm_vol_fade`.
   * A single weak tick must not sell — need N consecutive weak windows.
   */
  volFadeSamples?: Array<{ ts: number; vol: number }>;
  /**
   * 1.11.761 — one-shot leader-align average-in already filled on this bag.
   * Prevents spam scale-in when soft exits keep re-firing under a leader buy.
   */
  leaderAlignScaleInDone?: boolean;
  /**
   * `tokenRaw` came from a settled sell (`before − sold`), not from the buy
   * quote. Only then may it cap the next sell: a buy's Jupiter `outAmount` runs
   * a few % above the confirmed fill, which is what made us ask for more than we
   * held in the first place.
   */
  tokenRawSettled?: boolean;
};

/** Last full exit — block rebuy near the same USD price (no Dex needed). */
export type MildDipLastExit = {
  priceUsd: number;
  atMs: number;
  pnlPct?: number;
  /** Dex pool liquidity at (or near) exit — rebuy liq-drop baseline. */
  liquidityUsd?: number | null;
};

export type MildDipState = {
  open: Record<string, MildDipOpenPosition>;
  /** mint → last close/attempt ms (cooldown). */
  cooldownUntilMs: Record<string, number>;
  /** mint → last full-exit fill/mark price for same-price rebuy guard. */
  lastExitByMint?: Record<string, MildDipLastExit>;
  /**
   * 1.11.906 — mint → when a leader was last seen holding or buying it, kept for
   * as long as `leaderSeenMemoryMs`.
   *
   * The first-touch gate asks whether a leader finds a name worth trading at all.
   * The measurement behind it used exactly that - ever - and found first touches
   * on leader-traded names at −0.1470 per position against −0.3068 on names no
   * leader wants. The implementation read the seed file instead, which carries a
   * two-hour window for its own purposes, so the gate was stricter than the
   * evidence: of 20,614 rejections, 1,066 were names the leaders had bought
   * earlier than two hours, which is the better population being turned away.
   */
  leaderSeenMints?: Record<string, number>;
  /** mint → deep-knife watch (wait for stabilize / bounce). */
  knifeWatch?: Record<string, KnifeWatchEntry>;
  /** mint → wait-dip watch (park signal; buy after extra dump). */
  waitDipWatch?: Record<string, WaitDipWatchEntry>;
  updatedAtMs: number;
};

function sanitizeKnifeWatch(
  raw: unknown,
): Record<string, KnifeWatchEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, KnifeWatchEntry> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<KnifeWatchEntry>;
    const detectedAtMs = Number(o.detectedAtMs);
    const knifeDipPct = Number(o.knifeDipPct);
    const peakPriceUsd = Number(o.peakPriceUsd);
    const troughPriceUsd = Number(o.troughPriceUsd);
    const troughAtMs = Number(o.troughAtMs);
    const lastPriceUsd = Number(o.lastPriceUsd);
    const lastAtMs = Number(o.lastAtMs);
    if (
      !(detectedAtMs > 0) ||
      !Number.isFinite(knifeDipPct) ||
      !(peakPriceUsd > 0) ||
      !(troughPriceUsd > 0) ||
      !(troughAtMs > 0) ||
      !(lastPriceUsd > 0) ||
      !(lastAtMs > 0)
    ) {
      continue;
    }
    const readyNotifiedAtMs = Number(o.readyNotifiedAtMs);
    out[mint] = {
      detectedAtMs,
      knifeDipPct,
      peakPriceUsd,
      troughPriceUsd,
      troughAtMs,
      lastPriceUsd,
      lastAtMs,
      ...(readyNotifiedAtMs > 0 ? { readyNotifiedAtMs } : {}),
    };
  }
  return out;
}

function sanitizeWaitDipWatch(raw: unknown): Record<string, WaitDipWatchEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, WaitDipWatchEntry> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<WaitDipWatchEntry>;
    const detectedAtMs = Number(o.detectedAtMs);
    const signalPriceUsd = Number(o.signalPriceUsd);
    const waitDipPct = Number(o.waitDipPct);
    const lastPriceUsd = Number(o.lastPriceUsd);
    const lastAtMs = Number(o.lastAtMs);
    const troughPriceUsd = Number(o.troughPriceUsd);
    const troughAtMs = Number(o.troughAtMs);
    const symbol = typeof o.symbol === 'string' ? o.symbol : mint.slice(0, 6);
    const originalDipSource =
      typeof o.originalDipSource === 'string' ? o.originalDipSource : 'dex';
    if (
      !(detectedAtMs > 0) ||
      !(signalPriceUsd > 0) ||
      !Number.isFinite(waitDipPct) ||
      !(waitDipPct < 0) ||
      !(lastPriceUsd > 0) ||
      !(lastAtMs > 0) ||
      !(troughPriceUsd > 0) ||
      !(troughAtMs > 0)
    ) {
      continue;
    }
    const metricsRaw =
      o.metrics && typeof o.metrics === 'object'
        ? (o.metrics as Partial<MildDipCandidateMetrics>)
        : {};
    const metrics: MildDipCandidateMetrics = {
      priceChange5mPct:
        typeof metricsRaw.priceChange5mPct === 'number' ? metricsRaw.priceChange5mPct : null,
      volume5mUsd: typeof metricsRaw.volume5mUsd === 'number' ? metricsRaw.volume5mUsd : null,
      liquidityUsd: typeof metricsRaw.liquidityUsd === 'number' ? metricsRaw.liquidityUsd : null,
      marketCapUsd: typeof metricsRaw.marketCapUsd === 'number' ? metricsRaw.marketCapUsd : null,
      pairAgeHours: typeof metricsRaw.pairAgeHours === 'number' ? metricsRaw.pairAgeHours : null,
      dexId: typeof metricsRaw.dexId === 'string' ? metricsRaw.dexId : null,
      buys5m: typeof metricsRaw.buys5m === 'number' ? metricsRaw.buys5m : null,
      sells5m: typeof metricsRaw.sells5m === 'number' ? metricsRaw.sells5m : null,
      volume1hUsd: typeof metricsRaw.volume1hUsd === 'number' ? metricsRaw.volume1hUsd : null,
      priceChange1hPct:
        typeof metricsRaw.priceChange1hPct === 'number' ? metricsRaw.priceChange1hPct : null,
    };
    out[mint] = {
      detectedAtMs,
      signalPriceUsd,
      waitDipPct,
      symbol,
      originalDipSource,
      metrics,
      lastPriceUsd,
      lastAtMs,
      troughPriceUsd,
      troughAtMs,
    };
  }
  return out;
}

function sanitizeLastExitByMint(raw: unknown): Record<string, MildDipLastExit> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, MildDipLastExit> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<MildDipLastExit>;
    const priceUsd = Number(o.priceUsd);
    const atMs = Number(o.atMs);
    if (!(priceUsd > 0) || !(atMs > 0)) continue;
    const pnlPct = Number(o.pnlPct);
    const liquidityUsd = Number(o.liquidityUsd);
    out[mint] = {
      priceUsd,
      atMs,
      ...(Number.isFinite(pnlPct) ? { pnlPct } : {}),
      ...(Number.isFinite(liquidityUsd) && liquidityUsd > 0
        ? { liquidityUsd }
        : {}),
    };
  }
  return out;
}

export function emptyMildDipState(nowMs = Date.now()): MildDipState {
  return {
    open: {},
    cooldownUntilMs: {},
    lastExitByMint: {},
    leaderSeenMints: {},
    knifeWatch: {},
    waitDipWatch: {},
    updatedAtMs: nowMs,
  };
}

export function loadMildDipState(statePath: string): MildDipState {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as MildDipState;
    if (!parsed || typeof parsed !== 'object') return emptyMildDipState();
    return {
      open: parsed.open && typeof parsed.open === 'object' ? parsed.open : {},
      cooldownUntilMs:
        parsed.cooldownUntilMs && typeof parsed.cooldownUntilMs === 'object'
          ? parsed.cooldownUntilMs
          : {},
      lastExitByMint: sanitizeLastExitByMint(parsed.lastExitByMint),
      /**
       * 1.11.909 — this loader builds a fresh object field by field, so anything
       * it does not name is dropped on every restart. The leader memory added in
       * 1.11.906 was not named, so it reset each reload and never grew past the
       * handful of mints one seed window holds.
       */
      leaderSeenMints:
        parsed.leaderSeenMints && typeof parsed.leaderSeenMints === 'object'
          ? parsed.leaderSeenMints
          : {},
      knifeWatch: sanitizeKnifeWatch(parsed.knifeWatch),
      waitDipWatch: sanitizeWaitDipWatch(parsed.waitDipWatch),
      updatedAtMs: Number(parsed.updatedAtMs) || Date.now(),
    };
  } catch {
    return emptyMildDipState();
  }
}

export function saveMildDipState(statePath: string, state: MildDipState): void {
  const dir = path.dirname(statePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  state.updatedAtMs = Date.now();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, statePath);
}

export function appendMildDipJournal(
  journalPath: string,
  event: Record<string, unknown>,
): void {
  const dir = path.dirname(journalPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify({ ts: Date.now(), ...event })}\n`, 'utf8');
}
