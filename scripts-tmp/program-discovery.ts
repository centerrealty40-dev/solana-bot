/**
 * Program Discovery — поиск молодых растущих Solana протоколов с потенциалом
 * для frontrunning публичных on-chain intents.
 *
 * Источник #1: DefiLlama API (бесплатный, агрегирует все listed протоколы)
 *   - Берём всё на Solana
 *   - Считаем "ed-score" (edge candidate score) на основе:
 *       + молодости (свежие <90 дней получают высокий бонус)
 *       + роста за 7д и 1м (положительный = бонус)
 *       + сладких категорий (DEX, Derivatives, Yield, Lending — главные кандидаты)
 *       + размера TVL (>$100k чтобы было что фронтранить, но <$500M чтобы edge ещё не закрыт)
 *
 * Все находки upsert в нашу таблицу `programs` (накапливаем data-asset для
 * долгосрочного варианта A). Печатаем top-50 кандидатов с метриками
 * для ручного review — нужно перейти на их сайт + почитать docs +
 * заглянуть в Solscan на 100 последних tx чтобы увидеть формат intents.
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../src/core/db/client.js';

const DEFILLAMA_PROTOCOLS = 'https://api.llama.fi/protocols';

// Категории, в которых исторически есть predictable on-chain intents
// Score-bonus для каждой:
const SWEET_CATEGORIES: Record<string, number> = {
  'Dexes':                40,
  'DEX Aggregator':       35,
  'Derivatives':          45,  // perps, options — funding/expiry/liquidations
  'Options':              50,  // expiries особенно вкусны
  'Lending':              45,  // ликвидации
  'CDP':                  45,  // ликвидации тоже
  'Yield':                30,
  'Yield Aggregator':     35,
  'Liquid Staking':       35,  // unstake queues
  'Liquid Restaking':     40,
  'Cross Chain':          25,
  'NFT Marketplace':      15,
  'Launchpad':            45,  // открытые fund-raise events
  'Prediction Market':    50,  // открытые orderbooks
  'RWA':                  20,
  'Staking Pool':         25,
  'Algo-Stables':         30,
};

// Чёрный список — это огромные старые протоколы где edge давно закрыт
const TOO_BIG_USD = 500_000_000;
const TOO_SMALL_USD = 50_000;

interface DLProtocol {
  name: string;
  slug: string;
  symbol?: string | null;
  url?: string;
  twitter?: string;
  description?: string;
  chains?: string[];
  category?: string;
  tvl?: number;
  chainTvls?: Record<string, number>;
  change_1h?: number | null;
  change_1d?: number | null;
  change_7d?: number | null;
  listedAt?: number | null;
  // address fields (rare but present for some)
  address?: string | null;
}

function score(p: DLProtocol, solTvl: number, ageDays: number | null): number {
  let s = 0;
  // Категория
  s += SWEET_CATEGORIES[p.category ?? ''] ?? 5;
  // Молодость
  if (ageDays !== null) {
    if (ageDays < 14)       s += 50;
    else if (ageDays < 60)  s += 40;
    else if (ageDays < 120) s += 25;
    else if (ageDays < 365) s += 10;
  } else {
    s += 5;  // unknown age — small bonus
  }
  // Рост 7д и 1м
  const c7 = p.change_7d ?? 0;
  if (c7 > 100) s += 35;
  else if (c7 > 30) s += 20;
  else if (c7 > 5)  s += 10;
  else if (c7 < -50) s -= 10;
  // TVL "правильный размер"
  if (solTvl >= 100_000 && solTvl < 5_000_000)        s += 25;  // sweet spot
  else if (solTvl >= 5_000_000 && solTvl < 50_000_000) s += 15;
  else if (solTvl >= 50_000_000 && solTvl < TOO_BIG_USD) s += 5;
  // Solana-only протоколы лучше multi-chain (фокус)
  if ((p.chains?.length ?? 0) === 1 && p.chains?.[0] === 'Solana') s += 15;
  return s;
}

async function upsertProgram(p: DLProtocol, solTvl: number, ageDays: number | null, sc: number) {
  const programId = p.address || `slug:${p.slug}`;
  const cat = p.category ?? null;
  const url = p.url ?? null;
  const tw  = p.twitter ?? null;
  const listedAt = p.listedAt ? new Date(p.listedAt * 1000) : null;
  const meta = {
    score: sc,
    age_days: ageDays,
    chains: p.chains,
    description: p.description?.slice(0, 500),
    tvl_total: p.tvl,
  };

  // Drizzle upsert
  await db.insert(schema.programs).values({
    programId,
    name: p.name,
    slug: p.slug,
    category: cat,
    chain: 'solana',
    source: 'defillama',
    url,
    twitter: tw,
    listedAt,
    tvlUsd: solTvl,
    change1d: p.change_1d ?? null,
    change7d: p.change_7d ?? null,
    change1m: null,
    metadata: meta,
  }).onConflictDoUpdate({
    target: schema.programs.programId,
    set: {
      name: p.name,
      slug: p.slug,
      category: cat,
      url,
      twitter: tw,
      tvlUsd: solTvl,
      change1d: p.change_1d ?? null,
      change7d: p.change_7d ?? null,
      lastCheckedAt: new Date(),
      metadata: meta,
    },
  });
}

async function main() {
  console.log(`\n=== Program Discovery (DefiLlama → Solana protocols) ===\n`);

  console.log('Качаю DefiLlama protocols...');
  const t0 = Date.now();
  const r = await fetch(DEFILLAMA_PROTOCOLS, { headers: { 'accept': 'application/json' } });
  if (!r.ok) {
    console.error(`DefiLlama HTTP ${r.status} ${r.statusText}`); process.exit(1);
  }
  const all: DLProtocol[] = await r.json();
  console.log(`Total protocols listed:    ${all.length}`);

  // Filter to Solana presence
  const sol = all.filter(p => Array.isArray(p.chains) && p.chains.includes('Solana'));
  console.log(`With Solana presence:      ${sol.length}`);

  // Compute Solana TVL specifically (chainTvls.Solana — иначе fallback на total)
  type Enriched = { p: DLProtocol; solTvl: number; ageDays: number | null; sc: number };
  const enriched: Enriched[] = [];
  for (const p of sol) {
    const solTvl = p.chainTvls?.['Solana'] ?? p.tvl ?? 0;
    const ageDays = p.listedAt ? Math.max(0, (Date.now() / 1000 - p.listedAt) / 86400) : null;
    if (solTvl > TOO_BIG_USD) continue;        // too big — edge закрыт
    if (solTvl < TOO_SMALL_USD) continue;      // too small — нечего фронтранить
    const sc = score(p, solTvl, ageDays);
    enriched.push({ p, solTvl, ageDays, sc });
  }
  console.log(`After size filter:         ${enriched.length}`);

  enriched.sort((a, b) => b.sc - a.sc);

  // Upsert ALL into DB (накапливаем data-asset)
  console.log(`\nСохраняю в БД (programs table)...`);
  let upserted = 0;
  for (const e of enriched) {
    try { await upsertProgram(e.p, e.solTvl, e.ageDays, e.sc); upserted++; }
    catch (err) { process.stderr.write(`  upsert err for ${e.p.slug}: ${String(err).slice(0,120)}\n`); }
  }
  console.log(`Upserted: ${upserted}/${enriched.length} (за ${Math.round((Date.now()-t0)/1000)}s)`);

  // === TOP-50 для ручного review ===
  console.log(`\n${'='.repeat(76)}`);
  console.log(`ТОП-50 КАНДИДАТОВ для frontrun-edge research`);
  console.log('='.repeat(76));
  console.log(`Колонки:  score | TVL (Solana) | 7d% | age | category | name | url\n`);

  for (const e of enriched.slice(0, 50)) {
    const ageStr = e.ageDays !== null ? `${e.ageDays.toFixed(0)}d`.padStart(5) : '   ?d';
    const tvl = e.solTvl >= 1_000_000 ? `$${(e.solTvl/1e6).toFixed(1)}M` : `$${(e.solTvl/1e3).toFixed(0)}k`;
    const c7 = e.p.change_7d != null ? `${e.p.change_7d > 0 ? '+' : ''}${e.p.change_7d.toFixed(0)}%` : '   ?';
    const cat = (e.p.category ?? '?').slice(0, 18).padEnd(18);
    console.log(
      `  ${String(e.sc).padStart(3)} | ${tvl.padStart(7)} | ${c7.padStart(6)} | ${ageStr} | ${cat} | ${e.p.name.slice(0,28).padEnd(28)} | ${e.p.url ?? ''}`,
    );
  }

  // === Категориальный summary ===
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY ПО КАТЕГОРИЯМ (топ-200)`);
  console.log('='.repeat(60));
  const top200 = enriched.slice(0, 200);
  const byCat = new Map<string, { n: number; avgScore: number; totalTvl: number }>();
  for (const e of top200) {
    const k = e.p.category ?? '?';
    const c = byCat.get(k) ?? { n: 0, avgScore: 0, totalTvl: 0 };
    c.n += 1; c.avgScore += e.sc; c.totalTvl += e.solTvl;
    byCat.set(k, c);
  }
  const sorted = [...byCat.entries()].sort((a, b) => b[1].avgScore / b[1].n - a[1].avgScore / a[1].n);
  for (const [cat, c] of sorted) {
    const tvlStr = c.totalTvl >= 1e6 ? `$${(c.totalTvl/1e6).toFixed(1)}M` : `$${(c.totalTvl/1e3).toFixed(0)}k`;
    console.log(`  ${cat.padEnd(22)} n=${String(c.n).padStart(3)}  avg-score=${(c.avgScore/c.n).toFixed(1).padStart(5)}  total-tvl=${tvlStr.padStart(8)}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`СЛЕДУЮЩИЙ ШАГ`);
  console.log('='.repeat(60));
  console.log(`
Из топ-50 нужно вручную выбрать 5-10 наиболее интересных кандидатов и для
каждого ответить на 3 вопроса:

  1. Есть ли у них scheduled / ordered intents?  (DCA, лимитки, expiry,
     vesting, ликвидации, withdraw queues)
  2. Эти intents видны on-chain ДО исполнения? (открытый orderbook,
     program account state, или они ушли в encrypted intent pool)
  3. Какой минимальный размер для фронтрана и какой shared MEV-pool

Для каждого кандидата:
  - Открыть docs (URL выше)
  - Посмотреть последние 100 tx на Solscan/SolanaFM
  - Если интересно — пометить в БД:
       UPDATE programs SET review_status='reviewed', our_priority='high',
                           edge_type='dca' WHERE slug='...';
`);

  // Распределение в нашей БД
  const dbStats: any = await db.execute(dsql`
    SELECT review_status, our_priority, COUNT(*)::int AS n
    FROM programs GROUP BY review_status, our_priority
    ORDER BY n DESC
  `);
  const dbRows = Array.isArray(dbStats) ? dbStats : (dbStats.rows ?? []);
  if (dbRows.length > 0) {
    console.log(`СОСТОЯНИЕ programs В БД:`);
    for (const r of dbRows) console.log(`  ${String(r.review_status).padEnd(12)} ${String(r.our_priority).padEnd(8)} ${r.n}`);
  }

  console.log(`\nDONE.\n`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
