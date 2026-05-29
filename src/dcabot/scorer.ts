/**
 * dca_frontrun — coin legitimacy scorer.
 * Computes a 0..100 trust score and persists it. NON-BLOCKING for now: we still buy
 * everything (per owner), but the score is recorded and surfaced on the dashboard so we
 * can later turn it into a hard gate.
 */
import { rpc } from './rpc.js';
import { getTokenMarket } from './market.js';
import { saveTokenScore } from './db.js';

export type LegitScore = {
  mint: string;
  symbol: string | null;
  score: number | null;
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  top10Pct: number | null;
  liquidityUsd: number | null;
  ageMin: number | null;
  flags: Record<string, unknown>;
};

async function mintAuthorities(mint: string): Promise<{ mintRenounced: boolean | null; freezeRenounced: boolean | null; supply: number | null }> {
  const res = await rpc<{ value?: { data?: { parsed?: { info?: any } } } }>(
    'getAccountInfo',
    [mint, { encoding: 'jsonParsed' }],
  );
  const info = res?.value?.data?.parsed?.info;
  if (!info) return { mintRenounced: null, freezeRenounced: null, supply: null };
  const decimals = Number(info.decimals || 0);
  const rawSupply = Number(info.supply || 0);
  const supply = rawSupply > 0 ? rawSupply / 10 ** decimals : null;
  return {
    mintRenounced: info.mintAuthority == null,
    freezeRenounced: info.freezeAuthority == null,
    supply,
  };
}

async function top10Pct(mint: string, supply: number | null): Promise<number | null> {
  if (!supply || supply <= 0) return null;
  const res = await rpc<{ value?: Array<{ uiAmount?: number }> }>('getTokenLargestAccounts', [mint]);
  const accts = res?.value;
  if (!Array.isArray(accts) || accts.length === 0) return null;
  const top = accts.slice(0, 10).reduce((s, a) => s + Number(a.uiAmount || 0), 0);
  return Math.min(100, (top / supply) * 100);
}

export async function scoreToken(mint: string): Promise<LegitScore> {
  const market = await getTokenMarket(mint);
  const auth = await mintAuthorities(mint);
  const top10 = await top10Pct(mint, auth.supply);

  const flags: Record<string, unknown> = {};
  let score = 50;

  if (auth.mintRenounced === true) score += 20;
  else if (auth.mintRenounced === false) {
    score -= 25;
    flags.mintAuthorityActive = true;
  }
  if (auth.freezeRenounced === true) score += 15;
  else if (auth.freezeRenounced === false) {
    score -= 25;
    flags.freezeAuthorityActive = true;
  }
  if (top10 != null) {
    if (top10 > 50) {
      score -= 20;
      flags.highTop10 = top10;
    } else if (top10 < 25) score += 10;
  }
  const liq = market?.liquidityUsd ?? 0;
  if (liq >= 100_000) score += 10;
  else if (liq > 0 && liq < 20_000) {
    score -= 10;
    flags.lowLiquidity = liq;
  }
  if (market?.ageMin != null && market.ageMin < 30) {
    score -= 5;
    flags.veryNew = Math.round(market.ageMin);
  }

  const finalScore = Math.max(0, Math.min(100, score));
  const result: LegitScore = {
    mint,
    symbol: market?.symbol ?? null,
    score: finalScore,
    mintRenounced: auth.mintRenounced,
    freezeRenounced: auth.freezeRenounced,
    top10Pct: top10,
    liquidityUsd: market?.liquidityUsd ?? null,
    ageMin: market?.ageMin ?? null,
    flags,
  };

  await saveTokenScore({
    mint,
    symbol: result.symbol,
    score: result.score,
    mintRenounced: result.mintRenounced,
    freezeRenounced: result.freezeRenounced,
    lpLocked: null,
    top10Pct: result.top10Pct,
    liquidityUsd: result.liquidityUsd,
    ageMin: result.ageMin,
    flags: result.flags,
  });

  return result;
}
