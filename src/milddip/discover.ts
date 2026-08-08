/**
 * Candidate mint discovery for the mild-dip bot.
 * Universe: stream hot-list (+ boosts/profiles). Metrics: DexScreener.
 * Price samples always land in the price-ring (even on gate fail / cooldown)
 * so we remember the trough while waiting to rebuy.
 */
import fs from 'node:fs';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import { loadAwakeningConfig } from '../scripts/awakening/awakening-config.js';
import { evaluateAwakeningSignal } from '../scripts/awakening/awakening-signal.js';
import type { AwakeningDexMarket } from '../scripts/awakening/awakening-types.js';
import { evaluateGreenTapeEntry } from '../volgreen/green-tape-gates.js';
import {
  discoverGeckoTrendingMints,
  evaluateTripleGreenEntry,
} from '../volgreen/triple-green.js';
import type { MildDipConfig } from './config.js';
import { mapPool } from './exit-engine.js';
import { evaluateMildDipEntry, type MildDipCandidateMetrics } from './gates.js';
import { mildDipHotMints } from './hot-mints.js';
import { mildDipPriceRing } from './price-ring.js';

export type MildDipCandidate = {
  mint: string;
  symbol: string;
  priceUsd: number;
  metrics: MildDipCandidateMetrics;
  /** How the dip signal passed: Dex pc5m and/or stream drawdown. */
  dipSource: 'dex' | 'stream' | 'dex+stream';
  /** Awakening / green_tape path label. */
  entryPath?:
    | 'early_spike'
    | 'ignition'
    | 'gradual'
    | 'green_tape'
    | 'green_tape_impulse'
    | 'green_tape_liquid'
    | 'green_tape_liquid_tape'
    | 'green_tape_early'
    | 'green_tape_rocket'
    | 'green_tape_triple';
  /** Journal helpers — spike multiples when awakening / turnover score. */
  entryScore?: number;
};

/** Enriched mint that failed entry gates (for journal near-miss). */
export type EntrySkip = {
  mint: string;
  entryMode: MildDipConfig['entryMode'];
  reasons: string[];
  metrics?: Partial<MildDipCandidateMetrics> & {
    buySellRatio5m?: number | null;
    turnover5m?: number | null;
  };
};

export type EnrichFilterResult = {
  candidates: MildDipCandidate[];
  skips: EntrySkip[];
};

const SOLANA_CHAIN = 'solana';

async function fetchJson(url: string): Promise<unknown> {
  const { fetch } = await import('undici');
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return res.json();
}

function mintFromBoostOrProfile(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const o = row as { chainId?: string; tokenAddress?: string };
  if ((o.chainId ?? '').toLowerCase() !== SOLANA_CHAIN) return null;
  const m = (o.tokenAddress ?? '').trim();
  return m.length >= 32 ? m : null;
}

async function discoverBoostMints(): Promise<string[]> {
  const data = await fetchJson('https://api.dexscreener.com/token-boosts/top/v1');
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const row of data) {
    const m = mintFromBoostOrProfile(row);
    if (m) out.push(m);
  }
  return out;
}

async function discoverProfileMints(): Promise<string[]> {
  const data = await fetchJson('https://api.dexscreener.com/token-profiles/latest/v1');
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const row of data) {
    const m = mintFromBoostOrProfile(row);
    if (m) out.push(m);
  }
  return out;
}

function readSeedMints(seedPath: string | undefined): string[] {
  if (!seedPath) return [];
  try {
    const raw = fs.readFileSync(seedPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((m) => m.length >= 32 && !m.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Mints we must keep enriching while cooling / just after cooldown so the
 * price-ring records the trough before we consider a rebuy.
 */
export function priorityMintsFromCooldown(
  cooldownUntilMs: Record<string, number>,
  nowMs: number,
  opts?: { postCooldownMs?: number },
): string[] {
  const post = opts?.postCooldownMs ?? 120_000;
  const out: string[] = [];
  for (const [mint, until] of Object.entries(cooldownUntilMs)) {
    if (!mint || typeof until !== 'number') continue;
    // Still cooling, or cooled down within post window (about to decide).
    if (until > nowMs || (nowMs - until >= 0 && nowMs - until <= post)) {
      out.push(mint);
    }
  }
  // Soonest-to-ready first (cooling ending soon / just ended).
  out.sort((a, b) => (cooldownUntilMs[a] ?? 0) - (cooldownUntilMs[b] ?? 0));
  return out;
}

/**
 * Green-tape analogue of mild-dip's ring-dip priority: mints whose local
 * price-ring already shows a rally from trough should not lose Dex slots to
 * random newer stream noise.
 */
export function priorityMintsFromPriceRingGreen(
  cfg: Pick<MildDipConfig, 'cooldownBounceLookbackMs' | 'greenTape'>,
  mints: readonly string[],
  nowMs: number,
  opts?: { max?: number },
): string[] {
  const minRally = Math.max(
    0,
    cfg.greenTape.impulseMinPc5mPct,
    cfg.greenTape.liquidMinPc5mPct,
    cfg.greenTape.earlyMinPc5mPct,
  );
  // Allow overshoot vs entry caps — priority only, full gates still apply later.
  const maxRally = Math.max(
    cfg.greenTape.liquidMaxPc5mPct,
    cfg.greenTape.earlyMaxPc5mPct,
    cfg.greenTape.impulseMaxPc5mPct > 0 ? cfg.greenTape.impulseMaxPc5mPct : 500,
    cfg.greenTape.rocketMaxPc5mPct > 0 ? cfg.greenTape.rocketMaxPc5mPct : 500,
  );
  const max = Math.max(0, Math.floor(opts?.max ?? 60));
  const seen = new Set<string>();
  const rows: Array<{ mint: string; rallyPct: number; lastTs: number }> = [];
  for (const mint of mints) {
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    const rallyPct = mildDipPriceRing.rallyFromTroughPct(
      mint,
      cfg.cooldownBounceLookbackMs,
      nowMs,
    );
    if (rallyPct == null || !Number.isFinite(rallyPct)) continue;
    if (!(rallyPct > minRally && rallyPct <= maxRally)) continue;
    rows.push({
      mint,
      rallyPct,
      lastTs: mildDipPriceRing.lastPrice(mint, nowMs)?.tsMs ?? 0,
    });
  }
  rows.sort((a, b) => b.rallyPct - a.rallyPct || b.lastTs - a.lastTs);
  return rows.slice(0, max).map((r) => r.mint);
}

export async function collectCandidateMints(
  cfg: MildDipConfig,
  opts?: { priorityMints?: string[]; nowMs?: number },
): Promise<string[]> {
  const sources = new Set(
    cfg.discoverSources
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (m: string) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    ordered.push(m);
  };

  // 1) Cooldown-watched / just-ready — must win enrich slots.
  for (const m of opts?.priorityMints ?? []) push(m);

  // 2) Stream-hot — hits-weighted for awakening/green_tape, freshest for mild_dip.
  if (sources.has('stream')) {
    const nowMs = opts?.nowMs ?? Date.now();
    const streamMints =
      cfg.entryMode === 'awakening' || cfg.entryMode === 'green_tape'
        ? mildDipHotMints.listForEnrich(nowMs)
        : mildDipHotMints.list(nowMs);
    for (const m of streamMints) push(m);
  }
  if (sources.has('boosts')) {
    for (const m of await discoverBoostMints()) push(m);
  }
  if (sources.has('profiles')) {
    for (const m of await discoverProfileMints()) push(m);
  }
  // Live Solana pools by volume/trend — better for 1m candle patterns than boost ads.
  if (sources.has('gecko') || sources.has('trending')) {
    for (const m of await discoverGeckoTrendingMints()) push(m);
  }
  if (sources.has('seed')) {
    for (const m of readSeedMints(cfg.seedMintsPath)) push(m);
  }
  return ordered;
}

function streamDipInBand(
  cfg: MildDipConfig,
  mint: string,
  nowMs: number,
): { ok: boolean; drawdownPct: number | null } {
  const dd = mildDipPriceRing.drawdownFromPeakPct(
    mint,
    cfg.cooldownBounceLookbackMs,
    nowMs,
  );
  if (dd == null || !Number.isFinite(dd)) return { ok: false, drawdownPct: dd };
  const ok = dd > cfg.entry.minDipPct && dd <= cfg.entry.maxDipPct;
  return { ok, drawdownPct: dd };
}

type EnrichRow =
  | { kind: 'pass'; cand: MildDipCandidate }
  | { kind: 'skip'; skip: EntrySkip }
  | null;

type DexProbe = {
  mint: string;
  details: NonNullable<Awaited<ReturnType<typeof fetchDexScreenerPairDetails>>>;
  metrics: MildDipCandidateMetrics;
  volume5mUsd: number;
};

export async function enrichAndFilterCandidates(
  cfg: MildDipConfig,
  mints: string[],
  opts?: {
    nowMs?: number;
    /** How many mints get full entry gates after vol5m rank (tape modes). */
    maxEnrich?: number;
    /** How many mints to Dex-probe before ranking by vol5m. */
    probeMax?: number;
    enrichConcurrency?: number;
    /** Always enrich these even past probe window (cooldown / ring-priority). */
    forceEnrich?: string[];
  },
): Promise<EnrichFilterResult> {
  const nowMs = opts?.nowMs ?? Date.now();
  const awakening = cfg.entryMode === 'awakening';
  const greenTape = cfg.entryMode === 'green_tape';
  const tapeMode = awakening || greenTape;
  const evalTopN = opts?.maxEnrich ?? (tapeMode ? cfg.maxEnrichPerScan : 40);
  const probeMax = Math.max(
    evalTopN,
    opts?.probeMax ?? (tapeMode ? cfg.probeEnrichMax : evalTopN),
  );
  const enrichConcurrency = opts?.enrichConcurrency ?? cfg.enrichConcurrency ?? 12;

  const forceList = (opts?.forceEnrich ?? []).filter(Boolean);
  const slice: string[] = [];
  const seen = new Set<string>();
  const push = (m: string) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    slice.push(m);
  };
  // Force-interesting first (ring-green / cooldown), then fill probe budget.
  for (const m of forceList) push(m);
  for (const m of mints) {
    if (slice.length >= probeMax) break;
    push(m);
  }

  const denied = new Set(cfg.deniedMints.map((m) => m.trim()).filter(Boolean));
  const awCfg = awakening ? loadAwakeningConfig() : null;

  // Phase 1 — Dex probe (metrics only). Rank by vol5m so we gate the active tape first.
  const probeRows = await mapPool(slice, enrichConcurrency, async (mint): Promise<DexProbe | null> => {
    try {
      if (denied.has(mint)) return null;
      const details = await fetchDexScreenerPairDetails(mint, {
        bypassCache: true,
        nowMs,
        // Prefer pumpswap/raydium over higher-liq meteora so we don't
        // probe-then-reject as dex_not_allowed (NEEGY 6oGu… / 2y8Ntg…).
        allowedDexIds: cfg.entry.allowedDexIds,
      });
      if (!details || !(details.priceUsd != null && details.priceUsd > 0)) return null;
      mildDipPriceRing.note(mint, details.priceUsd, { tsMs: nowMs, source: 'dex' });
      const pairAgeHours =
        details.pairCreatedAtMs != null && details.pairCreatedAtMs > 0
          ? Math.max(0, (nowMs - details.pairCreatedAtMs) / 3_600_000)
          : null;
      const volume5mUsd = details.volume5mUsd ?? 0;
      return {
        mint,
        details,
        volume5mUsd: Number.isFinite(volume5mUsd) ? volume5mUsd : 0,
        metrics: {
          priceChange5mPct: details.priceChangeM5Pct,
          volume5mUsd: details.volume5mUsd,
          liquidityUsd: details.liquidityUsd,
          marketCapUsd: details.marketCapUsd,
          pairAgeHours,
          dexId: details.dexId,
        },
      };
    } catch {
      return null;
    }
  });

  const probed = probeRows.filter((p): p is DexProbe => p != null);
  probed.sort((a, b) => b.volume5mUsd - a.volume5mUsd);
  // Buy-force mints that got no Dex row — re-queue (8s cd) so a transient miss
  // does not drop the candle forever (Dealer 6f8ZQ: resolve→force→null probe).
  if (tapeMode && forceList.length > 0) {
    const probedSet = new Set(probed.map((p) => p.mint));
    for (const m of forceList) {
      if (!probedSet.has(m)) mildDipHotMints.requeueBuyForceMiss(m, nowMs);
    }
  }
  // Force-enrich must reach gates (and journal skips) — vol5m top-N used to
  // silently drop buyForce mints after probe (no entry_skip, "не видим").
  const forceSet = new Set(forceList);
  let toEvaluate: DexProbe[];
  if (tapeMode) {
    const forced = probed.filter((p) => forceSet.has(p.mint));
    const rest = probed.filter((p) => !forceSet.has(p.mint)).slice(0, evalTopN);
    const seenEval = new Set<string>();
    toEvaluate = [];
    for (const p of [...forced, ...rest]) {
      if (seenEval.has(p.mint)) continue;
      seenEval.add(p.mint);
      toEvaluate.push(p);
    }
  } else {
    toEvaluate = probed;
  }

  // Phase 2 — full entry gates only on the volume-leading probe set.
  const rows = await mapPool(toEvaluate, Math.min(8, enrichConcurrency), async (probe): Promise<EnrichRow> => {
    try {
      const { mint, details, metrics } = probe;

      if (awakening && awCfg) {
        if (cfg.entry.allowedDexIds.length > 0) {
          const dex = (details.dexId ?? '').toLowerCase();
          if (!dex || !cfg.entry.allowedDexIds.includes(dex)) {
            return {
              kind: 'skip',
              skip: {
                mint,
                entryMode: 'awakening',
                reasons: [`dex=${details.dexId ?? 'null'}_not_allowed`],
                metrics,
              },
            };
          }
        }
        if (details.volume6hUsd == null || details.volume24hUsd == null) {
          return {
            kind: 'skip',
            skip: {
              mint,
              entryMode: 'awakening',
              reasons: ['missing_vol6h_or_vol24h'],
              metrics,
            },
          };
        }
        const poolAgeMin =
          metrics.pairAgeHours != null ? metrics.pairAgeHours * 60 : null;
        const market: AwakeningDexMarket = {
          mint,
          priceUsd: details.priceUsd,
          marketCapUsd: details.marketCapUsd,
          liquidityUsd: details.liquidityUsd,
          volume5mUsd: details.volume5mUsd,
          volume1hUsd: details.volume1hUsd,
          volume6hUsd: details.volume6hUsd,
          volume24hUsd: details.volume24hUsd,
          buys5m: details.buys5m,
          sells5m: details.sells5m,
          priceChangeM5: details.priceChangeM5Pct,
          priceChangeH1: details.priceChangeH1Pct,
          priceChangeH6: details.priceChangeH6Pct,
          priceChangeH24: details.priceChangeH24Pct,
          pairAddress: details.pairAddress,
          dexId: details.dexId,
          poolAgeMin,
          fetchedAtMs: details.fetchedAtMs,
        };
        const verdict = evaluateAwakeningSignal(awCfg, market);
        if (!verdict.pass) {
          return {
            kind: 'skip',
            skip: {
              mint,
              entryMode: 'awakening',
              reasons: verdict.reasons,
              metrics,
            },
          };
        }
        const score =
          (verdict.metrics.vol5mSpikeVs6hMult ?? 0) + (verdict.metrics.vol5mSpikeVs1hMult ?? 0);
        const priceUsd = details.priceUsd as number;
        return {
          kind: 'pass',
          cand: {
            mint,
            symbol: mint.slice(0, 6),
            priceUsd,
            metrics,
            dipSource: 'dex',
            entryPath: verdict.metrics.entryPath,
            entryScore: score,
          },
        };
      }

      if (greenTape) {
        // Sole path mode: 1m small→small→huge (Prometheus / 8zkg). No OR-paths.
        if (cfg.greenTape.tripleGreenOnly) {
          const structural: string[] = [];
          const age = metrics.pairAgeHours;
          const vol5m = metrics.volume5mUsd ?? 0;
          const liqEarly = metrics.liquidityUsd;
          const mcapEarly = metrics.marketCapUsd ?? 0;
          // F1Xd / 7BNaxx: we watched the whole pump under age_h<0.5 while
          // vol5m hit $90k–$170k. Soft floor still blocks pure 1–2m newborns,
          // but liquid high-vol runners may enter earlier (activity-aged).
          const activityAged =
            vol5m >= 20_000 &&
            (liqEarly == null || liqEarly >= cfg.greenTape.minLiquidityUsd) &&
            mcapEarly >= cfg.greenTape.minMarketCapUsd;
          if (cfg.greenTape.minPairAgeHours > 0) {
            if (age == null) structural.push('missing_pair_age');
            else if (age < cfg.greenTape.minPairAgeHours && !activityAged) {
              structural.push(`age_h=${age.toFixed(2)}<${cfg.greenTape.minPairAgeHours}`);
            } else if (age < 0.1 && !activityAged) {
              // Absolute floor ~6m unless activity-aged.
              structural.push(`age_h=${age.toFixed(2)}<0.10_hard`);
            }
          }
          if (cfg.greenTape.maxPairAgeHours > 0 && age != null && age > cfg.greenTape.maxPairAgeHours) {
            structural.push(`age_h=${age.toFixed(2)}>${cfg.greenTape.maxPairAgeHours}`);
          }
          const liq = metrics.liquidityUsd;
          if (cfg.greenTape.minLiquidityUsd > 0) {
            // Null liq on Dex is common for pumpswap — don't hard-kill if mcap/vol ok.
            if (liq == null) {
              const vol = metrics.volume5mUsd ?? 0;
              if (!(vol >= 2_000)) structural.push('missing_liquidity');
            } else if (liq < cfg.greenTape.minLiquidityUsd) {
              structural.push(`liq=${liq.toFixed(0)}<${cfg.greenTape.minLiquidityUsd}`);
            }
          }
          const mcap = metrics.marketCapUsd;
          if (mcap == null || !(mcap > 0)) structural.push('missing_mcap');
          else if (mcap < cfg.greenTape.minMarketCapUsd) {
            structural.push(`mcap=${mcap.toFixed(0)}<${cfg.greenTape.minMarketCapUsd}`);
          }
          if (cfg.greenTape.allowedDexIds.length > 0) {
            const dex = (metrics.dexId ?? '').toLowerCase();
            if (!dex || !cfg.greenTape.allowedDexIds.includes(dex)) {
              structural.push(`dex=${metrics.dexId ?? 'null'}_not_allowed`);
            }
          }
          if (structural.length > 0) {
            return {
              kind: 'skip',
              skip: {
                mint,
                entryMode: 'green_tape',
                reasons: structural,
                metrics,
              },
            };
          }
          const forceSet = new Set(forceList);
          const leaderHit = mildDipHotMints.isLeaderHighlight(mint, nowMs);
          // BJWHLm/2iY3hd: last3=1.2,82.4,14.4 at 8zkg buy — classic triple wants
          // huge LAST so it skipped. Flex when leader-highlighted OR force+strong pc5m.
          const strongForce =
            forceSet.has(mint) &&
            (metrics.priceChange5mPct ?? 0) >= Math.max(25, cfg.greenTape.tripleHugeMinPc);
          const flex = leaderHit || strongForce;
          const tg = await evaluateTripleGreenEntry({
            pairAddress: details.pairAddress,
            nowMs,
            localPriceSamples: mildDipPriceRing.listSamples(mint, 20 * 60_000, nowMs),
            allowGeckoHttp: flex || forceSet.has(mint) || (metrics.volume5mUsd ?? 0) >= 2_500,
            geckoPriority: flex,
            leaderFlex: flex,
            gates: {
              enabled: true,
              smallMinPc: cfg.greenTape.tripleSmallMinPc,
              smallMaxPc: cfg.greenTape.tripleSmallMaxPc,
              hugeMinPc: cfg.greenTape.tripleHugeMinPc,
              hugeMinVolUsd: cfg.greenTape.tripleHugeMinVolUsd,
              maxAgeAfterHugeMs: cfg.greenTape.tripleMaxAgeAfterHugeMs,
            },
          });
          if (!tg.pass) {
            const waitingLocal = tg.reasons.some(
              (r) =>
                r.startsWith('triple_local_samples=') ||
                r.startsWith('triple_local_bars=') ||
                r === 'triple_ohlcv_budget' ||
                r === 'triple_gecko_deferred' ||
                r === 'triple_ohlcv_rate_limited',
            );
            // Peek-mode keeps waiting mints in buyForce; drop definitive misses.
            if (!waitingLocal && forceSet.has(mint)) {
              mildDipHotMints.clearBuyForce(mint);
            }
            return {
              kind: 'skip',
              skip: {
                mint,
                entryMode: 'green_tape',
                reasons: tg.reasons,
                metrics: {
                  ...metrics,
                  triplePattern: tg.pattern ?? null,
                },
              },
            };
          }
          mildDipHotMints.clearBuyForce(mint);
          // Fresh triple spike: allow mild pullback; only block dumps ≤ -8%.
          // F1Xd 2rgKQQ: triple=3.18/10.83/63.26 then tape_short_red=-16 after,
          // but the earlier miss was chase — still don't self-kill on -2% noise.
          const shortMs = cfg.greenTapeShortRedWindowMs;
          const shortPc =
            shortMs > 0 ? mildDipPriceRing.changeFromOldestPct(mint, shortMs, nowMs) : null;
          if (shortPc != null && shortPc <= -8) {
            return {
              kind: 'skip',
              skip: {
                mint,
                entryMode: 'green_tape',
                reasons: [
                  `tape_short_red:ring${Math.round(shortMs / 1000)}=${shortPc.toFixed(2)}<=-8`,
                  `triple=${tg.pattern?.small0}/${tg.pattern?.small1}/${tg.pattern?.huge}`,
                ],
                metrics,
              },
            };
          }
          const priceUsd = details.priceUsd as number;
          const score =
            (tg.pattern?.huge ?? 0) + (tg.pattern?.small0 ?? 0) + (tg.pattern?.small1 ?? 0);
          return {
            kind: 'pass',
            cand: {
              mint,
              symbol: mint.slice(0, 6),
              priceUsd,
              metrics: {
                ...metrics,
                triplePattern: tg.pattern ?? null,
              },
              dipSource: 'dex',
              entryPath: 'green_tape_triple',
              entryScore: score,
            },
          };
        }

        const verdict = evaluateGreenTapeEntry(
          {
            ...metrics,
            buys5m: details.buys5m,
            sells5m: details.sells5m,
          },
          cfg.greenTape,
        );
        if (!verdict.pass) {
          return {
            kind: 'skip',
            skip: {
              mint,
              entryMode: 'green_tape',
              reasons: verdict.reasons,
              metrics: {
                ...metrics,
                buySellRatio5m: verdict.buySellRatio5m,
                turnover5m: verdict.turnover5m,
              },
            },
          };
        }
        // Dex pc5m is a rolling window — can read "green" on a bounce inside a dump
        // (8T6rjb 02:09: Dex −24% then +8.7% while chart stayed red). Require our
        // local price-ring to also show green oldest→last over ~5m.
        const ringWindowMs = 5 * 60_000;
        const ringPc = mildDipPriceRing.changeFromOldestPct(mint, ringWindowMs, nowMs);
        const minRingPc = Math.max(
          cfg.greenTape.liquidMinPc5mPct,
          cfg.greenTape.earlyMinPc5mPct,
        );
        // Liquid mid-band (pc5m 10–25 noise): demand stronger local ring green.
        const pc5m = metrics.priceChange5mPct;
        const midLo = cfg.greenTape.liquidMidPc5mLo;
        const midHi =
          cfg.greenTape.liquidMidPc5mHi > 0
            ? cfg.greenTape.liquidMidPc5mHi
            : cfg.greenTape.liquidMaxPc5mPct;
        const liquidMid =
          verdict.path === 'liquid' &&
          cfg.greenTape.liquidMidMinBuySellRatio5m > 0 &&
          pc5m != null &&
          pc5m > midLo &&
          (midHi <= 0 || pc5m <= midHi);
        // liquid_tape: Dex may lag — ring floor is the real green signal.
        const ringFloor =
          verdict.path === 'liquid_tape'
            ? Math.max(0, cfg.greenTape.liquidTapeMinRingPc5mPct)
            : liquidMid
              ? Math.max(minRingPc, 8)
              : minRingPc;
        // Short-window red (≈1m): block all paths — Dex pc5m can stay green on a dump.
        const shortMs = cfg.greenTapeShortRedWindowMs;
        const shortPc =
          shortMs > 0 ? mildDipPriceRing.changeFromOldestPct(mint, shortMs, nowMs) : null;
        if (shortPc != null && shortPc <= 0) {
          return {
            kind: 'skip',
            skip: {
              mint,
              entryMode: 'green_tape',
              reasons: [
                `tape_short_red:ring${Math.round(shortMs / 1000)}=${shortPc.toFixed(2)}<=0`,
                `dex_pc5m=${metrics.priceChange5mPct ?? 'n/a'}`,
              ],
              metrics: {
                ...metrics,
                buySellRatio5m: verdict.buySellRatio5m,
                turnover5m: verdict.turnover5m,
              },
            },
          };
        }
        // Impulse/rocket: skip strict 5m ring floor (race the candle) but keep short-red.
        // liquid_tape MUST have ring green (that's the whole point vs Dex lag).
        if (
          verdict.path !== 'rocket' &&
          verdict.path !== 'impulse'
        ) {
          if (ringPc == null) {
            return {
              kind: 'skip',
              skip: {
                mint,
                entryMode: 'green_tape',
                reasons: ['ring_insufficient_samples'],
                metrics: {
                  ...metrics,
                  buySellRatio5m: verdict.buySellRatio5m,
                  turnover5m: verdict.turnover5m,
                },
              },
            };
          }
          if (!(ringPc > ringFloor)) {
            return {
              kind: 'skip',
              skip: {
                mint,
                entryMode: 'green_tape',
                reasons: [
                  `ring_not_green:ringPc=${ringPc.toFixed(2)}<=${ringFloor}`,
                  `dex_pc5m=${metrics.priceChange5mPct ?? 'n/a'}`,
                  verdict.path === 'liquid_tape' ? 'path=liquid_tape' : '',
                ].filter(Boolean),
                metrics: {
                  ...metrics,
                  buySellRatio5m: verdict.buySellRatio5m,
                  turnover5m: verdict.turnover5m,
                },
              },
            };
          }
        }
        // Prefer larger impulse magnitude (leader: wait for a real green, then buy).
        const pathBonus =
          verdict.path === 'impulse'
            ? 20
            : verdict.path === 'liquid_tape'
              ? 12
              : verdict.path === 'early'
                ? 5
                : 0;
        const score =
          (verdict.turnover5m ?? 0) * 100 +
          (verdict.buySellRatio5m ?? 0) * 10 +
          pathBonus +
          Math.min(80, Math.max(0, metrics.priceChange5mPct ?? 0)) +
          Math.min(50, ringPc ?? 0);
        const priceUsd = details.priceUsd as number;
        const entryPath =
          verdict.path === 'impulse'
            ? 'green_tape_impulse'
            : verdict.path === 'rocket'
              ? 'green_tape_rocket'
              : verdict.path === 'early'
                ? 'green_tape_early'
                : verdict.path === 'liquid_tape'
                  ? 'green_tape_liquid_tape'
                  : 'green_tape_liquid';
        return {
          kind: 'pass',
          cand: {
            mint,
            symbol: mint.slice(0, 6),
            priceUsd,
            metrics,
            dipSource: 'dex',
            entryPath,
            entryScore: score,
          },
        };
      }

      const dexVerdict = evaluateMildDipEntry(metrics, cfg.entry);
      const stream = streamDipInBand(cfg, mint, nowMs);
      const structuralOk = structuralGatesPass(metrics, cfg);

      let dipSource: MildDipCandidate['dipSource'] | null = null;
      if (dexVerdict.pass && stream.ok) dipSource = 'dex+stream';
      else if (dexVerdict.pass) dipSource = 'dex';
      else if (cfg.streamDipEntryEnabled && stream.ok && structuralOk) dipSource = 'stream';
      else {
        return {
          kind: 'skip',
          skip: {
            mint,
            entryMode: 'mild_dip',
            reasons: [...dexVerdict.reasons, ...(stream.ok ? [] : ['stream_dip_fail'])],
            metrics,
          },
        };
      }

      const priceUsd = details.priceUsd as number;
      return {
        kind: 'pass',
        cand: {
          mint,
          symbol: mint.slice(0, 6),
          priceUsd,
          metrics:
            dipSource === 'stream' && stream.drawdownPct != null
              ? { ...metrics, priceChange5mPct: stream.drawdownPct }
              : metrics,
          dipSource,
        },
      };
    } catch (err) {
      return {
        kind: 'skip',
        skip: {
          mint: probe.mint,
          entryMode: cfg.entryMode,
          reasons: [`enrich_error:${err instanceof Error ? err.message : String(err)}`],
        },
      };
    }
  });

  const out: MildDipCandidate[] = [];
  const skips: EntrySkip[] = [];
  for (const r of rows) {
    if (!r) continue;
    if (r.kind === 'pass') out.push(r.cand);
    else skips.push(r.skip);
  }

  // Prefer highest 5m volume among passes (mild-dip parallel-agent scheme).
  out.sort(
    (a, b) =>
      (b.metrics.volume5mUsd ?? 0) - (a.metrics.volume5mUsd ?? 0) ||
      (b.entryScore ?? 0) - (a.entryScore ?? 0) ||
      (a.metrics.priceChange5mPct ?? 0) - (b.metrics.priceChange5mPct ?? 0),
  );
  return { candidates: out, skips };
}

/** Liq / mcap / age / dex without requiring Dex pc5m. */
function structuralGatesPass(
  metrics: MildDipCandidateMetrics,
  cfg: MildDipConfig,
): boolean {
  const g = cfg.entry;
  if (metrics.volume5mUsd == null || !(metrics.volume5mUsd >= g.minVolume5mUsd)) return false;
  if (metrics.liquidityUsd == null || !(metrics.liquidityUsd >= g.minLiquidityUsd)) return false;
  if (metrics.marketCapUsd == null || !(metrics.marketCapUsd >= g.minMarketCapUsd)) return false;
  if (metrics.marketCapUsd > g.maxMarketCapUsd) return false;
  if (metrics.pairAgeHours == null || metrics.pairAgeHours < g.minPairAgeHours) return false;
  if (g.maxPairAgeHours > 0 && metrics.pairAgeHours > g.maxPairAgeHours) return false;
  if (g.allowedDexIds.length > 0) {
    const dex = (metrics.dexId ?? '').toLowerCase();
    if (!dex || !g.allowedDexIds.includes(dex)) return false;
  }
  return true;
}
