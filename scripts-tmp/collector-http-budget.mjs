/**
 * Static HTTP budget for DEX snapshot collectors (DexScreener + Gecko Terminal).
 * Run: npm run collector:http-budget
 *
 * Steady state ≈ DexScreener search term calls per tick.
 * Upper bound ≈ full fallback chain when DexScreener returns 0 rows (then Gecko pages).
 */
const MS_PER_MIN = 60_000;

function rpm(intervalMs, requestsPerTick) {
  if (!(intervalMs > 0) || !(requestsPerTick >= 0)) return 0;
  return (MS_PER_MIN / intervalMs) * requestsPerTick;
}

const collectors = [
  {
    name: 'sa-raydium',
    intervalMs: Number(process.env.RAYDIUM_COLLECTOR_INTERVAL_MS || 60_000),
    searchTerms: (process.env.RAYDIUM_DEX_SEARCH_TERMS || 'raydium,solana,meme').split(',').filter(Boolean).length,
    geckoTrendPages: Number(process.env.RAYDIUM_GECKO_TRENDING_PAGES || 2),
    geckoNewPages: 0,
  },
  {
    name: 'sa-meteora',
    intervalMs: Number(process.env.METEORA_COLLECTOR_INTERVAL_MS || 60_000),
    searchTerms: (process.env.METEORA_DEX_SEARCH_TERMS || 'meteora,dlmm,solana').split(',').filter(Boolean).length,
    geckoTrendPages: Number(process.env.METEORA_GECKO_TRENDING_PAGES || 2),
    geckoNewPages: 0,
  },
  {
    name: 'sa-orca',
    intervalMs: Number(process.env.ORCA_COLLECTOR_INTERVAL_MS || 90_000),
    searchTerms: (process.env.ORCA_DEX_SEARCH_TERMS || 'orca,whirlpool,orca solana').split(',').filter(Boolean).length,
    geckoTrendPages: Number(process.env.ORCA_GECKO_TRENDING_PAGES || 2),
    geckoNewPages: Number(process.env.ORCA_GECKO_NEW_POOLS_PAGES || 2),
  },
  {
    name: 'sa-moonshot',
    intervalMs: Number(process.env.MOONSHOT_COLLECTOR_INTERVAL_MS || 90_000),
    searchTerms: (process.env.MOONSHOT_DEX_SEARCH_TERMS || 'moonshot,moonshot solana,moonshot token')
      .split(',')
      .filter(Boolean).length,
    geckoTrendPages: Number(process.env.MOONSHOT_GECKO_TRENDING_PAGES || 2),
    geckoNewPages: Number(process.env.MOONSHOT_GECKO_NEW_POOLS_PAGES || 2),
  },
  {
    name: 'sa-pumpswap',
    intervalMs: Number(process.env.PUMPSWAP_COLLECTOR_INTERVAL_MS || 60_000),
    searchTerms: (process.env.PUMPSWAP_DEX_SEARCH_TERMS || 'pumpswap,pump swap,pump.fun solana')
      .split(',')
      .filter(Boolean).length,
    geckoTrendPages: Number(process.env.PUMPSWAP_GECKO_TRENDING_PAGES || 2),
    geckoNewPages: Number(process.env.PUMPSWAP_GECKO_NEW_POOLS_PAGES || 2),
  },
];

console.log(JSON.stringify({ msg: 'collector-http-budget', unit: 'HTTP_requests_per_minute' }, null, 0));

let sumSteady = 0;
let sumWorst = 0;

for (const c of collectors) {
  const steadyTick = c.searchTerms;
  const worstTick = c.searchTerms + c.geckoTrendPages + c.geckoNewPages;
  const steady = rpm(c.intervalMs, steadyTick);
  const worst = rpm(c.intervalMs, worstTick);
  sumSteady += steady;
  sumWorst += worst;
  console.log(
    JSON.stringify(
      {
        collector: c.name,
        intervalMs: c.intervalMs,
        tick_requests_steady: steadyTick,
        tick_requests_worst_fallback_chain: worstTick,
        rpm_steady: +steady.toFixed(3),
        rpm_worst: +worst.toFixed(3),
      },
      null,
      2,
    ),
  );
}

console.log(
  JSON.stringify(
    {
      total_rpm_steady_all_five: +sumSteady.toFixed(3),
      total_rpm_worst_all_five: +sumWorst.toFixed(3),
      note: 'Paper2 open-mint merge adds extra DexScreener /tokens calls — not included.',
    },
    null,
    2,
  ),
);
