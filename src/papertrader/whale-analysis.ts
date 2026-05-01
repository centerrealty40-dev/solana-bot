import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from './config.js';
import type { SellerProfile, WhaleAnalysis, WhaleSeller } from './types.js';

function shortWallet(w: string | null | undefined): string {
  if (!w) return '';
  return `${w.slice(0, 4)}...${w.slice(-4)}`;
}

function classifyProfile(
  cfg: PaperTraderConfig,
  args: {
    amount_usd: number;
    pctDumpedNow: number;
    nSells24h: number;
    medianIntervalMin: number | null;
    medianChunkUsd: number | null;
  },
): SellerProfile {
  const { amount_usd, pctDumpedNow, nSells24h, medianIntervalMin, medianChunkUsd } = args;
  if (
    nSells24h >= cfg.whaleDcaAggrMinSells24h &&
    medianIntervalMin !== null &&
    medianIntervalMin < cfg.whaleDcaAggrMaxIntervalMin
  )
    return 'dca_aggressive';
  if (
    nSells24h >= cfg.whaleDcaPredMinSells24h &&
    (medianIntervalMin ?? 0) >= cfg.whaleDcaPredMinIntervalMin &&
    (medianChunkUsd ?? 0) >= cfg.whaleDcaPredMinChunkUsd
  )
    return 'dca_predictable';
  if (pctDumpedNow >= cfg.whaleCapitulationPct && amount_usd >= cfg.whaleLargeSellUsd) return 'capitulator';
  if (nSells24h <= 1) return 'panic_random';
  return 'unknown';
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function fetchWhaleAnalysis(cfg: PaperTraderConfig, mint: string): Promise<WhaleAnalysis> {
  const empty: WhaleAnalysis = {
    enabled: cfg.whaleEnabled,
    creator_wallet: null,
    creator_dumped_pct: 0,
    creator_dump_block: false,
    large_sells: [],
    single_whale_capitulation: false,
    group_sell_pressure: false,
    dca_predictable_present: false,
    dca_aggressive_present: false,
    trigger_fired: null,
    block_reasons: [],
  };
  if (!cfg.whaleEnabled) return empty;

  try {
    const safeMint = mint.replace(/'/g, "''");
    const largeUsd = cfg.whaleLargeSellUsd;
    const lookbackMin = Math.floor(cfg.whaleRecentLookbackMin);

    const r1 = await db.execute(dsql.raw(`
      WITH creator AS (
        SELECT wallet
        FROM swaps
        WHERE base_mint = '${safeMint}' AND side = 'buy'
        ORDER BY block_time ASC
        LIMIT 1
      ),
      large_sells AS (
        SELECT wallet, amount_usd::float AS amount_usd, block_time
        FROM swaps
        WHERE base_mint = '${safeMint}'
          AND side = 'sell'
          AND amount_usd >= ${largeUsd}
          AND block_time >= now() - interval '${lookbackMin} minutes'
        ORDER BY amount_usd DESC
        LIMIT 20
      )
      SELECT
        (SELECT wallet FROM creator) AS creator_wallet,
        (SELECT json_agg(row_to_json(ls)) FROM large_sells ls) AS sells
    `));
    const r1rows = r1 as unknown as Array<{ creator_wallet: string | null; sells: unknown }>;
    const head = r1rows[0] || {};
    const creatorWallet: string | null = head.creator_wallet ?? null;
    const sells: Array<{ wallet: string; amount_usd: number; block_time: unknown }> = Array.isArray(head.sells)
      ? (head.sells as Array<{ wallet: string; amount_usd: number; block_time: unknown }>)
      : [];

    const sellerWallets = [...new Set(sells.map((s) => s.wallet))];
    const enrichments = await Promise.all(
      sellerWallets.map(async (wallet) => {
        try {
          const safeW = wallet.replace(/'/g, "''");
          const r2 = await db.execute(dsql.raw(`
          SELECT
            COALESCE(SUM(amount_usd) FILTER (WHERE base_mint = '${safeMint}' AND side = 'buy'), 0)::float AS total_buy_on_mint,
            COALESCE(SUM(amount_usd) FILTER (WHERE base_mint = '${safeMint}' AND side = 'sell'), 0)::float AS total_sell_on_mint,
            COUNT(*) FILTER (WHERE side = 'sell' AND block_time >= now() - interval '24 hours')::int AS n_sells_24h
          FROM swaps
          WHERE wallet = '${safeW}'
            AND block_time >= now() - interval '24 hours'
        `));
          const r2rows = r2 as unknown as Array<{
            total_buy_on_mint: number | string;
            total_sell_on_mint: number | string;
            n_sells_24h: number | string;
          }>;
          const baseInfo = r2rows[0] || { total_buy_on_mint: 0, total_sell_on_mint: 0, n_sells_24h: 0 };
          const r3 = await db.execute(dsql.raw(`
          SELECT block_time, amount_usd::float AS amount_usd
          FROM swaps
          WHERE wallet = '${safeW}'
            AND side = 'sell'
            AND block_time >= now() - interval '24 hours'
          ORDER BY block_time ASC
        `));
          const r3rows = r3 as unknown as Array<{ block_time: unknown; amount_usd: number | string }>;
          const chunks = r3rows.map((row) => Number(row.amount_usd ?? 0)).filter((x) => Number.isFinite(x));
          const intervalsMin: number[] = [];
          for (let i = 1; i < r3rows.length; i++) {
            const prev = new Date(String(r3rows[i - 1].block_time)).getTime();
            const curr = new Date(String(r3rows[i].block_time)).getTime();
            if (curr > prev) intervalsMin.push((curr - prev) / 60_000);
          }
          const rLast = await db.execute(dsql.raw(`
          SELECT MAX(block_time) AS bt
          FROM swaps
          WHERE wallet = '${safeW}'
            AND base_mint = '${safeMint}'
            AND side = 'sell'
            AND block_time >= now() - interval '24 hours'
        `));
          const lastRows = rLast as unknown as Array<{ bt: unknown }>;
          const bt = lastRows[0]?.bt;
          let lastSellTsMs = 0;
          if (bt != null && bt !== '') {
            const t = new Date(String(bt)).getTime();
            if (Number.isFinite(t)) lastSellTsMs = t;
          }
          return {
            wallet,
            total_buy_on_mint: Number(baseInfo.total_buy_on_mint || 0),
            total_sell_on_mint: Number(baseInfo.total_sell_on_mint || 0),
            n_sells_24h: Number(baseInfo.n_sells_24h || 0),
            median_chunk_usd: median(chunks),
            median_interval_min: median(intervalsMin),
            last_sell_ts_ms: lastSellTsMs,
          };
        } catch (err) {
          console.warn(`whale enrich failed for ${wallet}: ${err}`);
          return null;
        }
      }),
    );
    const byWallet = new Map<
      string,
      NonNullable<(typeof enrichments)[number]> & {
        total_buy_on_mint: number;
        total_sell_on_mint: number;
        n_sells_24h: number;
        median_chunk_usd: number | null;
        median_interval_min: number | null;
        last_sell_ts_ms: number;
      }
    >();
    for (const e of enrichments) if (e) byWallet.set(e.wallet, e);

    const largeSellersOut: WhaleSeller[] = [];
    let groupSumUsd = 0;
    let groupSellersCount = 0;
    let dcaPredictablePresent = false;
    let dcaAggressivePresent = false;
    let singleCapitulation = false;

    for (const sell of sells) {
      const enr = byWallet.get(sell.wallet) || {
        total_buy_on_mint: 0,
        total_sell_on_mint: 0,
        n_sells_24h: 0,
        median_chunk_usd: null,
        median_interval_min: null,
        last_sell_ts_ms: 0,
      };
      const totalBuy = enr.total_buy_on_mint || 0;
      const totalSell = enr.total_sell_on_mint || 0;
      const pctDumpedNow = totalBuy > 0 ? Math.min(1, totalSell / totalBuy) : 0;
      const pctOfPositionThis = totalBuy > 0 ? Math.min(1, sell.amount_usd / totalBuy) : 0;
      const profile = classifyProfile(cfg, {
        amount_usd: sell.amount_usd,
        pctDumpedNow,
        nSells24h: enr.n_sells_24h,
        medianIntervalMin: enr.median_interval_min,
        medianChunkUsd: enr.median_chunk_usd,
      });
      const isCreator = creatorWallet === sell.wallet;
      const seller: WhaleSeller = {
        wallet: shortWallet(sell.wallet),
        amount_usd: +Number(sell.amount_usd).toFixed(2),
        pct_of_position_dumped: +pctOfPositionThis.toFixed(3),
        pct_total_dumped_now: +pctDumpedNow.toFixed(3),
        is_creator: isCreator,
        profile,
        n_sells_24h: enr.n_sells_24h,
        median_interval_min: enr.median_interval_min !== null ? +enr.median_interval_min.toFixed(1) : null,
        median_chunk_usd: enr.median_chunk_usd !== null ? +enr.median_chunk_usd.toFixed(0) : null,
      };
      largeSellersOut.push(seller);

      if (!isCreator) {
        if (profile === 'capitulator') {
          let silenceOk = true;
          if (cfg.whaleSilenceMinAfterLastSell > 0) {
            const rowTs = new Date(String(sell.block_time)).getTime();
            const lastSellTs = Math.max(enr.last_sell_ts_ms ?? 0, Number.isFinite(rowTs) ? rowTs : 0);
            if (lastSellTs <= 0) silenceOk = false;
            else {
              const ageMin = (Date.now() - lastSellTs) / 60_000;
              silenceOk = ageMin >= cfg.whaleSilenceMinAfterLastSell;
            }
            if (!silenceOk) seller.profile = 'still_dumping';
          }
          if (silenceOk) singleCapitulation = true;
        }
        if (profile === 'dca_predictable') dcaPredictablePresent = true;
        if (profile === 'dca_aggressive') dcaAggressivePresent = true;
        if (pctOfPositionThis >= cfg.whaleGroupDumpPct) {
          groupSumUsd += sell.amount_usd;
          groupSellersCount += 1;
        }
      }
    }
    const groupPressure =
      groupSumUsd >= cfg.whaleGroupSellUsd && groupSellersCount >= cfg.whaleGroupMinSellers;

    let creatorDumpedPct = 0;
    let creatorBlock = false;
    if (creatorWallet) {
      try {
        const safeCreator = creatorWallet.replace(/'/g, "''");
        const creatorLb = Math.floor(cfg.whaleCreatorDumpLookbackMin);
        const r4 = await db.execute(dsql.raw(`
          SELECT
            COALESCE(SUM(amount_usd) FILTER (WHERE side = 'buy'), 0)::float AS total_buy,
            COALESCE(SUM(amount_usd) FILTER (
              WHERE side = 'sell' AND block_time >= now() - interval '${creatorLb} minutes'
            ), 0)::float AS recent_sell
          FROM swaps
          WHERE base_mint = '${safeMint}' AND wallet = '${safeCreator}'
        `));
        const r4rows = r4 as unknown as Array<{ total_buy: number | string; recent_sell: number | string }>;
        const cb = Number(r4rows[0]?.total_buy ?? 0);
        const rs = Number(r4rows[0]?.recent_sell ?? 0);
        creatorDumpedPct = cb > 0 ? rs / cb : 0;
        if (
          cfg.whaleBlockCreatorDump &&
          creatorDumpedPct >= cfg.whaleCreatorDumpMinPct &&
          creatorDumpedPct <= cfg.whaleCreatorDumpMaxPct
        )
          creatorBlock = true;
      } catch (err) {
        console.warn(`creator analysis failed for ${mint}: ${err}`);
      }
    }

    let trigger: WhaleAnalysis['trigger_fired'] = null;
    const blockReasons: string[] = [];
    if (creatorBlock) blockReasons.push(`creator_dumping_${(creatorDumpedPct * 100).toFixed(0)}%`);
    if (dcaAggressivePresent) blockReasons.push('dca_aggressive_present');
    if (singleCapitulation && !blockReasons.length) trigger = 'whale_capitulation';
    else if (groupPressure && !blockReasons.length) trigger = 'group_pressure';
    else if (dcaPredictablePresent && !blockReasons.length) trigger = 'dca_predictable';

    return {
      enabled: true,
      creator_wallet: creatorWallet ? shortWallet(creatorWallet) : null,
      creator_dumped_pct: +creatorDumpedPct.toFixed(3),
      creator_dump_block: creatorBlock,
      large_sells: largeSellersOut,
      single_whale_capitulation: singleCapitulation,
      group_sell_pressure: groupPressure,
      dca_predictable_present: dcaPredictablePresent,
      dca_aggressive_present: dcaAggressivePresent,
      trigger_fired: trigger,
      block_reasons: blockReasons,
    };
  } catch (err) {
    console.warn(`fetchWhaleAnalysis failed for ${mint}: ${err}`);
    return empty;
  }
}
