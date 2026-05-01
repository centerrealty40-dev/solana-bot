// Direct smoke-test of verifyEntryPrice on the VPS, no need to wait for a real open.
import 'dotenv/config';
import { verifyEntryPrice } from '/opt/solana-alpha/src/papertrader/pricing/price-verify.js';

const cfg = {
  priceVerifyEnabled: true,
  priceVerifyBlockOnFail: false,
  priceVerifyUseJupiterPrice: false,
  priceVerifyMaxSlipPct: 4.0,
  priceVerifyMaxSlipBps: 400,
  priceVerifyMaxPriceImpactPct: 8.0,
  priceVerifyTimeoutMs: 5000,
};

console.log('PAPER_PRICE_VERIFY_QUOTE_URL =', process.env.PAPER_PRICE_VERIFY_QUOTE_URL);

const cases = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USDC',   decimals: 6, snapshotPriceUsd: 1.0 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'BONK',   decimals: 5, snapshotPriceUsd: 0.000020 },
];
for (const c of cases) {
  const v = await verifyEntryPrice({
    cfg, mint: c.mint, outMintDecimals: c.decimals, sizeUsd: 100, solUsd: 160, snapshotPriceUsd: c.snapshotPriceUsd,
  });
  console.log(`--- ${c.name} (${c.mint.slice(0,8)}) snapPx=${c.snapshotPriceUsd} ---`);
  console.log(JSON.stringify(v, null, 2));
}
