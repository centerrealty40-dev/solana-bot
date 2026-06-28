import type { HyperliquidMarketCache } from '../twap/hyperliquid-meta.js';

/**
 * Hardcoded denylist from HL Oscar backtest bottom-20 (12h + no-timestop merged).
 * BTC/ETH excluded — separate hl-oscar-majors bot (see docs/products/hl-oscar-majors/).
 * Override/extend via HL_OSCAR_DENYLIST / HL_OSCAR_DENYLIST_EXTRA / HL_OSCAR_WHITELIST env.
 */
export const OSCAR_PERP_DENYLIST_DEFAULT = [
  'BTC',
  'ETH',
  '2Z',
  'ACE',
  'APT',
  'ASTER',
  'AXS',
  'AZTEC',
  'BABY',
  'BERA',
  'BLUR',
  'DYDX',
  'GAS',
  'GMT',
  'HBAR',
  'HYPER',
  'INJ',
  'IP',
  'MINA',
  'MOVE',
  'NEAR',
  'NIL',
  'NXPC',
  'SAND',
  'SEI',
  'SKR',
  'SPX',
  'UNI',
  'W',
  'WCT',
  'XAI',
  'XMR',
  'XPL',
  'YGG',
  'ZEC',
] as const;

function parseCoinList(envName: string): Set<string> | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  const set = new Set<string>();
  for (const part of raw.split(',')) {
    const c = part.trim().toUpperCase();
    if (c) set.add(c);
  }
  return set.size > 0 ? set : null;
}

export function resolveOscarDenylist(): Set<string> {
  const envDeny = parseCoinList('HL_OSCAR_DENYLIST');
  if (envDeny) return envDeny;
  const extra = parseCoinList('HL_OSCAR_DENYLIST_EXTRA');
  const base = new Set<string>(OSCAR_PERP_DENYLIST_DEFAULT);
  if (extra) for (const c of extra) base.add(c);
  return base;
}

export function resolveOscarWhitelist(): Set<string> | null {
  return parseCoinList('HL_OSCAR_WHITELIST');
}

export type OscarUniverseCoin = {
  coin: string;
  displaySymbol: string;
  dayVlmUsd: number;
  midPx: number;
};

export function buildOscarUniverse(
  cache: HyperliquidMarketCache,
  opts: { minDayVolumeUsd: number; denylist: Set<string>; whitelist: Set<string> | null },
): OscarUniverseCoin[] {
  const out: OscarUniverseCoin[] = [];
  for (let i = 0; i < cache.perpNames.length; i++) {
    const coin = cache.perpNames[i]!;
    if (opts.whitelist && !opts.whitelist.has(coin.toUpperCase())) continue;
    if (opts.denylist.has(coin.toUpperCase())) continue;
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
