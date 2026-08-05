/**
 * Candidate mint discovery for the mild-dip bot (DexScreener public endpoints).
 * Rate-limited; pair metrics come from `fetchDexScreenerPairDetails`.
 */
import fs from 'node:fs';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import { evaluateMildDipEntry, type MildDipCandidateMetrics } from './gates.js';
import { mildDipHotMints } from './hot-mints.js';

export type MildDipCandidate = {
  mint: string;
  symbol: string;
  priceUsd: number;
  metrics: MildDipCandidateMetrics;
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

export async function collectCandidateMints(cfg: MildDipConfig): Promise<string[]> {
  const sources = new Set(
    cfg.discoverSources
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const mints = new Set<string>();
  // Stream-hot mints first (freshest activity from Helius logsSubscribe).
  if (sources.has('stream')) {
    for (const m of mildDipHotMints.list()) mints.add(m);
  }
  if (sources.has('boosts')) {
    for (const m of await discoverBoostMints()) mints.add(m);
  }
  if (sources.has('profiles')) {
    for (const m of await discoverProfileMints()) mints.add(m);
  }
  if (sources.has('seed')) {
    for (const m of readSeedMints(cfg.seedMintsPath)) mints.add(m);
  }
  return [...mints];
}

export async function enrichAndFilterCandidates(
  cfg: MildDipConfig,
  mints: string[],
  opts?: { nowMs?: number; maxEnrich?: number },
): Promise<MildDipCandidate[]> {
  const nowMs = opts?.nowMs ?? Date.now();
  const maxEnrich = opts?.maxEnrich ?? 40;
  const out: MildDipCandidate[] = [];
  const slice = mints.slice(0, maxEnrich);

  const denied = new Set(cfg.deniedMints.map((m) => m.trim()).filter(Boolean));

  for (const mint of slice) {
    try {
      if (denied.has(mint)) continue;
      const details = await fetchDexScreenerPairDetails(mint, {
        bypassCache: true,
        nowMs,
      });
      if (!details || !(details.priceUsd != null && details.priceUsd > 0)) continue;

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
      };

      const verdict = evaluateMildDipEntry(metrics, cfg.entry);
      if (!verdict.pass) continue;

      out.push({
        mint,
        symbol: mint.slice(0, 6),
        priceUsd: details.priceUsd,
        metrics,
      });
    } catch {
      // skip mint
    }
  }

  // Prefer deeper mild dips first (more negative pc5m).
  out.sort((a, b) => (a.metrics.priceChange5mPct ?? 0) - (b.metrics.priceChange5mPct ?? 0));
  return out;
}
