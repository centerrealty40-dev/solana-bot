import 'dotenv/config';

const URL_BASE = process.env.PAPER_PRICE_VERIFY_QUOTE_URL?.trim() || 'https://lite-api.jup.ag/swap/v1/quote';
console.log('PAPER_PRICE_VERIFY_QUOTE_URL =', process.env.PAPER_PRICE_VERIFY_QUOTE_URL);
console.log('using URL_BASE =', URL_BASE);

const SOL_USD = 160;
const cases = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USDC', decimals: 6, snapshotPriceUsd: 1.0 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'BONK', decimals: 5, snapshotPriceUsd: 0.000020 },
];

for (const c of cases) {
  const lamports = Math.floor((100 / SOL_USD) * 1e9);
  const url = new URL(URL_BASE);
  url.searchParams.set('inputMint', 'So11111111111111111111111111111111111111112');
  url.searchParams.set('outputMint', c.mint);
  url.searchParams.set('amount', String(lamports));
  url.searchParams.set('slippageBps', '400');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const start = Date.now();
    const r = await fetch(url.toString(), { signal: ac.signal, headers: { accept: 'application/json' } });
    const elapsed = Date.now() - start;
    const status = r.status;
    let body = await r.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    let jupiterPriceUsd = null;
    if (parsed?.outAmount) {
      const tokenOut = Number(parsed.outAmount) / Math.pow(10, c.decimals);
      const usdIn = (lamports / 1e9) * SOL_USD;
      jupiterPriceUsd = usdIn / tokenOut;
    }
    const slipPct = jupiterPriceUsd != null
      ? +(((c.snapshotPriceUsd - jupiterPriceUsd) / c.snapshotPriceUsd) * 100).toFixed(4)
      : null;
    console.log(`--- ${c.name} (${c.mint.slice(0,8)}) http=${status} ${elapsed}ms ---`);
    console.log(`  outAmount=${parsed?.outAmount}  priceImpactPct=${parsed?.priceImpactPct}  routeHops=${(parsed?.routePlan ?? []).length}`);
    console.log(`  jupiterPriceUsd=${jupiterPriceUsd}  snapshotPriceUsd=${c.snapshotPriceUsd}  slipPct=${slipPct}`);
  } catch (e) {
    console.log(`--- ${c.name} ERROR ---`);
    console.log('  name=', e?.name, ' message=', e?.message, ' cause=', e?.cause?.message);
  } finally {
    clearTimeout(t);
  }
}
