/**
 * Candidate mint discovery for the mild-dip bot.
 * Universe: stream hot-list (+ boosts/profiles). Metrics: DexScreener.
 * Price samples always land in the price-ring (even on gate fail / cooldown)
 * so we remember the trough while waiting to rebuy.
 */
import fs from 'node:fs';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import { mapPool } from './exit-engine.js';
import {
  evaluateMildDipEntry,
  evaluateYoungShallowCombo,
  type MildDipCandidateMetrics,
} from './gates.js';
import { mildDipHotMints } from './hot-mints.js';
import { mildDipPriceRing } from './price-ring.js';

export type MildDipCandidate = {
  mint: string;
  symbol: string;
  priceUsd: number;
  metrics: MildDipCandidateMetrics;
  /** How the dip signal passed: Dex pc5m and/or stream drawdown. */
  dipSource: 'dex' | 'stream' | 'dex+stream';
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

  // 2) Stream-hot (freshest activity).
  if (sources.has('stream')) {
    for (const m of mildDipHotMints.list(opts?.nowMs)) push(m);
  }
  if (sources.has('boosts')) {
    for (const m of await discoverBoostMints()) push(m);
  }
  if (sources.has('profiles')) {
    for (const m of await discoverProfileMints()) push(m);
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

export async function enrichAndFilterCandidates(
  cfg: MildDipConfig,
  mints: string[],
  opts?: {
    nowMs?: number;
    maxEnrich?: number;
    enrichConcurrency?: number;
    /** Always enrich these even past maxEnrich (cooldown watch). */
    forceEnrich?: string[];
  },
): Promise<MildDipCandidate[]> {
  const nowMs = opts?.nowMs ?? Date.now();
  const maxEnrich = opts?.maxEnrich ?? 40;
  const enrichConcurrency = opts?.enrichConcurrency ?? cfg.enrichConcurrency ?? 12;

  const force = new Set((opts?.forceEnrich ?? []).filter(Boolean));
  const slice: string[] = [];
  const seen = new Set<string>();
  for (const m of [...force, ...mints]) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    slice.push(m);
    // force mints do not count against maxEnrich budget the same way —
    // allow force + maxEnrich headroom capped at maxEnrich + force.size
    if (slice.length >= maxEnrich + force.size) break;
  }

  const denied = new Set(cfg.deniedMints.map((m) => m.trim()).filter(Boolean));

  const rows = await mapPool(slice, enrichConcurrency, async (mint) => {
    try {
      if (denied.has(mint)) return null;
      const details = await fetchDexScreenerPairDetails(mint, {
        bypassCache: true,
        nowMs,
      });
      if (!details || !(details.priceUsd != null && details.priceUsd > 0)) return null;

      // Always record Dex mark — including during cooldown / failed gates.
      mildDipPriceRing.note(mint, details.priceUsd, { tsMs: nowMs, source: 'dex' });

      const pairAgeHours =
        details.pairCreatedAtMs != null && details.pairCreatedAtMs > 0
          ? Math.max(0, (nowMs - details.pairCreatedAtMs) / 3_600_000)
          : null;

      const metrics: MildDipCandidateMetrics = {
        priceChange5mPct: details.priceChangeM5Pct,
        volume5mUsd: details.volume5mUsd,
        liquidityUsd: details.liquidityUsd,
        marketCapUsd: details.marketCapUsd,
        pairAgeHours,
        dexId: details.dexId,
        buys5m: details.buys5m,
        sells5m: details.sells5m,
        volume1hUsd: details.volume1hUsd,
      };

      const dexVerdict = evaluateMildDipEntry(metrics, cfg.entry);
      const stream = streamDipInBand(cfg, mint, nowMs);
      // Structural Dex gates (liq/mcap/age/dex) must pass; dip may come from stream.
      const structuralOk = structuralGatesPass(metrics, cfg);

      let dipSource: MildDipCandidate['dipSource'] | null = null;
      if (dexVerdict.pass && stream.ok) dipSource = 'dex+stream';
      else if (dexVerdict.pass) dipSource = 'dex';
      else if (cfg.streamDipEntryEnabled && stream.ok && structuralOk) {
        // Stream dip replaces Dex pc5m — still enforce young+shallow on that depth.
        const streamMetrics: MildDipCandidateMetrics = {
          ...metrics,
          priceChange5mPct: stream.drawdownPct,
        };
        if (!evaluateYoungShallowCombo(streamMetrics, cfg.entry).pass) return null;
        dipSource = 'stream';
      } else return null;

      return {
        mint,
        symbol: mint.slice(0, 6),
        priceUsd: details.priceUsd,
        metrics:
          dipSource === 'stream' && stream.drawdownPct != null
            ? { ...metrics, priceChange5mPct: stream.drawdownPct }
            : metrics,
        dipSource,
      } satisfies MildDipCandidate;
    } catch {
      return null;
    }
  });

  const out = rows.filter((r): r is MildDipCandidate => r != null);

  // Prefer deeper mild dips first (more negative pc5m / stream drawdown).
  out.sort((a, b) => (a.metrics.priceChange5mPct ?? 0) - (b.metrics.priceChange5mPct ?? 0));
  return out;
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
