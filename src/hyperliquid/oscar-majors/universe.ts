import type { HyperliquidMarketCache } from '../twap/hyperliquid-meta.js';

export type OscarUniverseCoin = {
  coin: string;
  displaySymbol: string;
  dayVlmUsd: number;
  midPx: number;
};

export function buildMajorsUniverse(
  cache: HyperliquidMarketCache,
  opts: { minDayVolumeUsd: number; whitelist: string[] },
): OscarUniverseCoin[] {
  const allow = new Set(opts.whitelist.map((c) => c.toUpperCase()));
  const out: OscarUniverseCoin[] = [];
  for (let i = 0; i < cache.perpNames.length; i++) {
    const coin = cache.perpNames[i]!;
    if (!allow.has(coin.toUpperCase())) continue;
    const ctx = cache.perpCtxByIndex.get(i);
    const dayVlmUsd = ctx?.dayNtlVlm ? Number(ctx.dayNtlVlm) : 0;
    if (!(dayVlmUsd >= opts.minDayVolumeUsd)) continue;
    const midPx = cache.mids.get(coin) ?? 0;
    if (!(midPx > 0)) continue;
    out.push({ coin, displaySymbol: coin, dayVlmUsd, midPx });
  }
  out.sort((a, b) => b.dayVlmUsd - a.dayVlmUsd);
  return out;
}

export function resolveMajorsWhitelist(cfgWhitelist: string[]): Set<string> {
  return new Set(cfgWhitelist.map((c) => c.toUpperCase()));
}
