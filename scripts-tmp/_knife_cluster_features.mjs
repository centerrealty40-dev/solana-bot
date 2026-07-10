#!/usr/bin/env node
/**
 * Offline knife on-chain enrichment (READ-ONLY on intel tables only).
 *
 * Input: data/knife-catcher/knife-swaps.jsonl (captured by knife capture-only shadow).
 * Join wallets -> wallet_tags + entity_wallets.cluster_id (NOT the hot Discovery snapshot tables).
 *
 * For each detected dump (sell >= MIN_SELL off a recent local high in the captured stream),
 * compute on-chain "who is selling / who is buying the dip" features, then label the forward
 * outcome from the SAME captured swap prices (bounce vs keeps-falling). No journal, no PnL.
 *
 * Purpose: once ~1-2 weeks of capture exist, test whether cluster/bot concentration separates
 * bounce from falling knives — the signal TA alone could not provide.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import pg from 'pg';

const SWAPS = process.env.KNIFE_SWAPS || 'data/knife-catcher/knife-swaps.jsonl';
const OUT = process.env.OUT || '/tmp/_knife_cluster_features.json';
const MIN_SELL_USD = Number(process.env.MIN_SELL_USD || 1500);
const DUMP_WIN_MS = 15 * 60_000;
const MIN_DUMP = 10;
const MAX_DUMP = 40;
const HORIZON_MS = 2 * 3600_000;
const FALL_TH = -0.2;
const BOUNCE_TH = 0.12;
const FLOW_WIN_MS = 10 * 60_000; // wallet flow window around the dump

if (!fs.existsSync(SWAPS)) {
  console.error(`no capture file: ${SWAPS} — run knife capture-only shadow first`);
  process.exit(2);
}

// ---- load captured swaps per mint ----
const byMint = new Map();
let n = 0;
for await (const l of readline.createInterface({ input: fs.createReadStream(SWAPS), crlfDelay: Infinity })) {
  if (!l.startsWith('{')) continue;
  let e;
  try { e = JSON.parse(l); } catch { continue; }
  if (!e.mint || !e.ts || !e.wallet) continue;
  if (!byMint.has(e.mint)) byMint.set(e.mint, []);
  byMint.get(e.mint).push({
    ts: Number(e.ts), wallet: e.wallet, side: e.side,
    usd: Number(e.amountUsd) || 0, price: Number(e.price) || 0,
  });
  n++;
}
console.error(`captured swaps: ${n} across ${byMint.size} mints`);
if (n === 0) {
  fs.writeFileSync(OUT, JSON.stringify({ note: 'no captured swaps yet', swaps: 0 }, null, 2));
  console.log('no data yet');
  process.exit(0);
}

// ---- intel lookups (read-only) ----
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query("SET statement_timeout = '300000'");

const tagCache = new Map();
const clusterCache = new Map();
async function enrich(wallets) {
  const need = [...new Set(wallets)].filter((w) => !tagCache.has(w));
  for (let i = 0; i < need.length; i += 500) {
    const batch = need.slice(i, i + 500);
    const tg = await c.query(
      `SELECT wallet, array_agg(DISTINCT tag) tags FROM wallet_tags WHERE wallet = ANY($1) GROUP BY wallet`,
      [batch],
    ).catch(() => ({ rows: [] }));
    const tagMap = new Map(tg.rows.map((r) => [r.wallet, r.tags]));
    const cl = await c.query(
      `SELECT wallet, cluster_id FROM entity_wallets WHERE wallet = ANY($1) AND cluster_id IS NOT NULL`,
      [batch],
    ).catch(() => ({ rows: [] }));
    const clMap = new Map(cl.rows.map((r) => [r.wallet, r.cluster_id]));
    for (const w of batch) {
      tagCache.set(w, tagMap.get(w) || []);
      clusterCache.set(w, clMap.get(w) ?? null);
    }
  }
}

const BOTLIKE = new Set(['bot', 'dip_bot', 'mev_bot', 'farm_meta_member', 'farm_treasury', 'scam_operator', 'scam_proxy', 'sniper']);
function isBotlike(tags) { return tags.some((t) => BOTLIKE.has(t)); }

// ---- detect dumps in captured stream, compute on-chain features + forward label ----
const rows = [];
for (const [mint, swapsRaw] of byMint) {
  const swaps = swapsRaw.filter((s) => s.price > 0).sort((a, b) => a.ts - b.ts);
  if (swaps.length < 30) continue;

  let lastDump = -Infinity;
  for (let k = 5; k < swaps.length - 5; k++) {
    const now = swaps[k];
    if (now.side !== 'sell' || now.usd < MIN_SELL_USD) continue;
    if (now.ts - lastDump < 30 * 60_000) continue;
    // recent local high (15m) in captured prices
    let hi = 0;
    for (let j = k - 1; j >= 0 && swaps[j].ts >= now.ts - DUMP_WIN_MS; j--) if (swaps[j].price > hi) hi = swaps[j].price;
    if (!(hi > 0)) continue;
    const dumpPct = ((hi - now.price) / hi) * 100;
    if (dumpPct < MIN_DUMP || dumpPct > MAX_DUMP) continue;
    lastDump = now.ts;

    // flow window features
    const flow = swaps.filter((s) => s.ts >= now.ts - FLOW_WIN_MS && s.ts <= now.ts + FLOW_WIN_MS);
    await enrich(flow.map((s) => s.wallet));
    const sells = flow.filter((s) => s.side === 'sell');
    const buys = flow.filter((s) => s.side === 'buy');
    const sellUsd = sells.reduce((a, b) => a + b.usd, 0);
    const buyUsd = buys.reduce((a, b) => a + b.usd, 0);
    const sellBot = sells.filter((s) => isBotlike(tagCache.get(s.wallet) || [])).reduce((a, b) => a + b.usd, 0);
    const buyBot = buys.filter((s) => isBotlike(tagCache.get(s.wallet) || [])).reduce((a, b) => a + b.usd, 0);
    const uniqSellers = new Set(sells.map((s) => s.wallet)).size;
    const uniqBuyers = new Set(buys.map((s) => s.wallet)).size;
    // seller cluster concentration: top cluster share of sell usd
    const clSell = new Map();
    for (const s of sells) {
      const cl = clusterCache.get(s.wallet);
      const key = cl == null ? `w:${s.wallet}` : `c:${cl}`;
      clSell.set(key, (clSell.get(key) || 0) + s.usd);
    }
    const topSellerShare = sellUsd > 0 ? Math.max(0, ...[...clSell.values()]) / sellUsd : 0;
    const clusteredSellers = new Set(sells.map((s) => clusterCache.get(s.wallet)).filter((x) => x != null)).size;
    const nonBotBuyers = new Set(buys.filter((s) => !isBotlike(tagCache.get(s.wallet) || [])).map((s) => s.wallet)).size;

    // forward label from captured prices
    const fwd = swaps.filter((s) => s.ts > now.ts && s.ts <= now.ts + HORIZON_MS);
    if (fwd.length < 3) continue;
    let fMin = 0, fMax = 0;
    for (const s of fwd) { const r = s.price / now.price - 1; if (r < fMin) fMin = r; if (r > fMax) fMax = r; }
    let label = 'CHOP';
    if (fMin <= FALL_TH && fMax < BOUNCE_TH) label = 'KEEPS_FALLING';
    else if (fMax >= BOUNCE_TH) label = 'BOUNCE';

    rows.push({
      mint: mint.slice(0, 8),
      dumpPct: +dumpPct.toFixed(1),
      sellUsd: Math.round(sellUsd),
      buyUsd: Math.round(buyUsd),
      botSellShare: sellUsd > 0 ? +(sellBot / sellUsd).toFixed(3) : null,
      botBuyShare: buyUsd > 0 ? +(buyBot / buyUsd).toFixed(3) : null,
      topSellerClusterShare: +topSellerShare.toFixed(3),
      clusteredSellers,
      uniqSellers,
      uniqBuyers,
      nonBotBuyers,
      buyToSellUsd: sellUsd > 0 ? +(buyUsd / sellUsd).toFixed(2) : null,
      fwdMinPct: +(fMin * 100).toFixed(1),
      fwdMaxPct: +(fMax * 100).toFixed(1),
      label,
    });
  }
}
await c.end();

function agg(list, pick) {
  const v = list.map(pick).filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), med: +v[Math.floor(v.length / 2)].toFixed(3) };
}
const fall = rows.filter((r) => r.label === 'KEEPS_FALLING');
const bounce = rows.filter((r) => r.label === 'BOUNCE');
const feats = ['botSellShare', 'botBuyShare', 'topSellerClusterShare', 'clusteredSellers', 'uniqSellers', 'uniqBuyers', 'nonBotBuyers', 'buyToSellUsd'];
const compare = {};
for (const f of feats) compare[f] = { bounce: agg(bounce, (x) => x[f]), fall: agg(fall, (x) => x[f]) };

const out = {
  method: 'knife on-chain enrichment; captured Shyft swaps + wallet_tags/entity_wallets cluster join; forward label from captured prices',
  capturedSwaps: n,
  mints: byMint.size,
  dumps: rows.length,
  counts: { bounce: bounce.length, keepsFalling: fall.length },
  featureCompare: compare,
  sample: rows.slice(0, 20),
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.counts), 'dumps=', rows.length);
console.error('wrote', OUT);
