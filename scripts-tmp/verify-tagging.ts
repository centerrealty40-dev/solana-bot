/**
 * Verify Tagging Quality — критическая проверка нашего wallet_tagger.
 *
 * Гипотеза: tagger ставит `bot_farm_distributor` / `bot_farm_boss` /
 * `gas_distributor` / `scam_operator` слишком агрессивно. Текущие пороги
 * (≥30 recipients, ≥0.5 SOL avg, idle <14d) совпадают одновременно с:
 *   - реальными ботами-фермами (то что мы хотим ловить)
 *   - публичными trading терминалами (Photon, Bullx, BonkBot, Trojan, Maestro)
 *   - DEX/aggregator routers (Jupiter, Raydium, Meteora)
 *   - market-maker desks
 *
 * Этот скрипт берёт по N кошельков из каждого farm-tag'а и печатает признаки,
 * по которым человек глазами решает: это правда farm или ложное срабатывание.
 *
 * Что выводим для каждого кошелька:
 *   - Базовые stats (txs, mints, counterparties, SOL in/out)
 *   - Lifespan (first → last activity, дни)
 *   - Соотношение n_swaps / distinct_mints (фермы — мало swaps на mint;
 *     терминалы и flippers — много)
 *   - Top-5 получателей (если все unique random wallets — терминал;
 *     если повторяющиеся small wallets — ферма)
 *   - Какие primary_tags у получателей (если retail/meme_flipper —
 *     это терминал, который раздаёт газ юзерам; если no_tag и свежие —
 *     возможно ферма)
 *   - Решающий heuristic: насколько wallet больше похож на терминал
 *     или на ферму
 *   - Solscan link для ручной проверки
 *
 * ZERO Helius cost — только локальный Postgres.
 *
 * Usage:
 *   npm run tagging:verify -- --tag bot_farm_distributor --limit 10
 *   npm run tagging:verify -- --tag bot_farm_boss --limit 5
 *   npm run tagging:verify -- --tag gas_distributor --limit 10
 *   npm run tagging:verify -- --tag scam_operator --limit 10
 *   npm run tagging:verify  (без флагов = по 5 на каждую категорию)
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

interface CliArgs {
  tag: string | null;
  limit: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let tag: string | null = null;
  let limit = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) {
      tag = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = Math.max(1, Number.parseInt(args[i + 1], 10));
      i++;
    }
  }
  return { tag, limit };
}

async function rows<T = any>(q: any): Promise<T[]> {
  const r: any = await db.execute(q);
  return Array.isArray(r) ? r : (r.rows ?? []);
}

interface ProfileRow {
  wallet: string;
  primary_tag: string | null;
  tx_count: number;
  distinct_counterparties: number;
  distinct_mints: number;
  total_funded_sol: number;
  total_fee_spent_sol: number;
  first_tx_at: string | null;
  last_tx_at: string | null;
}

async function pickWallets(tag: string, limit: number): Promise<string[]> {
  const r = await rows<{ wallet: string }>(dsql.raw(`
    SELECT wallet FROM entity_wallets
    WHERE primary_tag = '${tag}'
    ORDER BY distinct_counterparties DESC NULLS LAST
    LIMIT ${limit}
  `));
  return r.map(x => x.wallet);
}

async function profile(wallet: string): Promise<ProfileRow | null> {
  const r = await rows<ProfileRow>(dsql.raw(`
    SELECT wallet, primary_tag, tx_count, distinct_counterparties, distinct_mints,
           total_funded_sol, total_fee_spent_sol,
           first_tx_at, last_tx_at
    FROM entity_wallets WHERE wallet = '${wallet}' LIMIT 1
  `));
  return r[0] ?? null;
}

async function swapStats(wallet: string) {
  const r = await rows<{
    n_swaps: number; n_buys: number; n_sells: number;
    n_mints: number; total_usd: number;
  }>(dsql.raw(`
    SELECT COUNT(*)::int AS n_swaps,
           COUNT(*) FILTER (WHERE side='buy')::int AS n_buys,
           COUNT(*) FILTER (WHERE side='sell')::int AS n_sells,
           COUNT(DISTINCT base_mint)::int AS n_mints,
           COALESCE(SUM(amount_usd),0)::float AS total_usd
    FROM swaps WHERE wallet = '${wallet}'
  `));
  return r[0] ?? { n_swaps: 0, n_buys: 0, n_sells: 0, n_mints: 0, total_usd: 0 };
}

async function topRecipients(wallet: string) {
  return rows<{
    target_wallet: string; total_sol: number; n_tx: number;
    target_tag: string | null;
  }>(dsql.raw(`
    SELECT mf.target_wallet,
           SUM(mf.amount)::float AS total_sol,
           COUNT(*)::int AS n_tx,
           ew.primary_tag AS target_tag
    FROM money_flows mf
    LEFT JOIN entity_wallets ew ON ew.wallet = mf.target_wallet
    WHERE mf.source_wallet = '${wallet}' AND mf.asset = 'SOL'
    GROUP BY mf.target_wallet, ew.primary_tag
    ORDER BY total_sol DESC
    LIMIT 5
  `));
}

async function topSources(wallet: string) {
  return rows<{
    source_wallet: string; total_sol: number; n_tx: number;
    source_tag: string | null;
  }>(dsql.raw(`
    SELECT mf.source_wallet,
           SUM(mf.amount)::float AS total_sol,
           COUNT(*)::int AS n_tx,
           ew.primary_tag AS source_tag
    FROM money_flows mf
    LEFT JOIN entity_wallets ew ON ew.wallet = mf.source_wallet
    WHERE mf.target_wallet = '${wallet}' AND mf.asset = 'SOL'
    GROUP BY mf.source_wallet, ew.primary_tag
    ORDER BY total_sol DESC
    LIMIT 5
  `));
}

async function recipientTagDistribution(wallet: string) {
  return rows<{ tag: string; n: number }>(dsql.raw(`
    SELECT COALESCE(ew.primary_tag, '(no tag)') AS tag,
           COUNT(DISTINCT mf.target_wallet)::int AS n
    FROM money_flows mf
    LEFT JOIN entity_wallets ew ON ew.wallet = mf.target_wallet
    WHERE mf.source_wallet = '${wallet}' AND mf.asset = 'SOL'
    GROUP BY 1
    ORDER BY n DESC
  `));
}

async function sourceTagDistribution(wallet: string) {
  return rows<{ tag: string; n: number }>(dsql.raw(`
    SELECT COALESCE(ew.primary_tag, '(no tag)') AS tag,
           COUNT(DISTINCT mf.source_wallet)::int AS n
    FROM money_flows mf
    LEFT JOIN entity_wallets ew ON ew.wallet = mf.source_wallet
    WHERE mf.target_wallet = '${wallet}' AND mf.asset = 'SOL'
    GROUP BY 1
    ORDER BY n DESC
  `));
}

async function fundingProfile(wallet: string) {
  // outbound profile (для distributors)
  const out = await rows<{
    recipients: number; n_tx: number; avg_sol: number; sum_sol: number;
    max_sol: number; min_sol: number;
    span_days: number; idle_days: number;
  }>(dsql.raw(`
    SELECT COUNT(DISTINCT target_wallet)::int AS recipients,
           COUNT(*)::int AS n_tx,
           COALESCE(AVG(amount),0)::float AS avg_sol,
           COALESCE(SUM(amount),0)::float AS sum_sol,
           COALESCE(MAX(amount),0)::float AS max_sol,
           COALESCE(MIN(amount),0)::float AS min_sol,
           COALESCE(EXTRACT(EPOCH FROM (MAX(tx_time)-MIN(tx_time)))/86400,0)::float AS span_days,
           COALESCE(EXTRACT(EPOCH FROM (now()-MAX(tx_time)))/86400,1e9)::float AS idle_days
    FROM money_flows
    WHERE source_wallet='${wallet}' AND asset='SOL' AND amount > 0
  `));
  // inbound profile (для bosses)
  const inn = await rows<{
    sources: number; n_tx: number; avg_sol: number; sum_sol: number;
    max_sol: number; min_sol: number;
    span_days: number; idle_days: number;
  }>(dsql.raw(`
    SELECT COUNT(DISTINCT source_wallet)::int AS sources,
           COUNT(*)::int AS n_tx,
           COALESCE(AVG(amount),0)::float AS avg_sol,
           COALESCE(SUM(amount),0)::float AS sum_sol,
           COALESCE(MAX(amount),0)::float AS max_sol,
           COALESCE(MIN(amount),0)::float AS min_sol,
           COALESCE(EXTRACT(EPOCH FROM (MAX(tx_time)-MIN(tx_time)))/86400,0)::float AS span_days,
           COALESCE(EXTRACT(EPOCH FROM (now()-MAX(tx_time)))/86400,1e9)::float AS idle_days
    FROM money_flows
    WHERE target_wallet='${wallet}' AND asset='SOL' AND amount > 0
  `));
  return { out: out[0]!, inn: inn[0]! };
}

interface Verdict {
  label: string;
  /** -3..+3, negative = looks like terminal/legit, positive = looks like farm */
  score: number;
  reasons: string[];
}

function judgeDistributor(p: ProfileRow, swap: Awaited<ReturnType<typeof swapStats>>,
                          recvDist: Awaited<ReturnType<typeof recipientTagDistribution>>,
                          fund: Awaited<ReturnType<typeof fundingProfile>>): Verdict {
  const reasons: string[] = [];
  let score = 0;

  const out = fund.out;
  const recipientsTaggedRetail = recvDist
    .filter(r => r.tag === 'retail' || r.tag === 'meme_flipper' || r.tag === 'terminal_user')
    .reduce((s, r) => s + r.n, 0);
  const recipientsNoTag = recvDist
    .filter(r => r.tag === '(no tag)' || r.tag === null)
    .reduce((s, r) => s + r.n, 0);
  const recipientsTaggedFarm = recvDist
    .filter(r => r.tag?.startsWith('bot_farm') || r.tag === 'sniper' || r.tag === 'rotation_node')
    .reduce((s, r) => s + r.n, 0);

  // 1. Lifespan: fermas — short (days/weeks), terminals — months/years
  if (out.span_days > 90) {
    score -= 2;
    reasons.push(`long lifespan ${out.span_days.toFixed(0)}d → terminal-like`);
  } else if (out.span_days < 7) {
    score += 1;
    reasons.push(`short lifespan ${out.span_days.toFixed(1)}d → farm-like`);
  }

  // 2. Recipients tag distribution
  if (recipientsTaggedRetail >= recipientsTaggedFarm * 2) {
    score -= 2;
    reasons.push(`receivers are retail/flippers (${recipientsTaggedRetail}) > farm (${recipientsTaggedFarm}) → likely terminal`);
  }
  if (recipientsTaggedFarm >= 5 && recipientsTaggedFarm > recipientsTaggedRetail) {
    score += 2;
    reasons.push(`receivers include ${recipientsTaggedFarm} farm-tagged wallets → farm-like`);
  }

  // 3. Wallet's own swap activity
  // Real farm-distributor mostly distributes SOL — has FEW personal swaps.
  // Terminal program is a smart-contract — has 0 swaps.
  // Real human flipper using as helper has many swaps.
  if (swap.n_swaps === 0 && p.distinct_mints === 0) {
    score -= 1;
    reasons.push(`zero swaps → could be program/contract`);
  }
  if (swap.n_swaps > 100) {
    score -= 1;
    reasons.push(`${swap.n_swaps} swaps → wallet trades itself, not pure distributor`);
  }

  // 4. Avg SOL amount uniformity (fermas — uniform; terminals — varied)
  const ratio = out.max_sol > 0 ? out.min_sol / out.max_sol : 0;
  if (out.n_tx >= 30 && ratio > 0.5) {
    score += 1;
    reasons.push(`uniform amounts (min/max=${ratio.toFixed(2)}) → coordinated farm`);
  }
  if (out.n_tx >= 30 && ratio < 0.05 && out.max_sol > 5) {
    score -= 1;
    reasons.push(`varied amounts (min=${out.min_sol.toFixed(3)}/max=${out.max_sol.toFixed(1)}) → user-driven terminal`);
  }

  // 5. Volume scale
  if (out.sum_sol > 10000) {
    score -= 1;
    reasons.push(`huge volume ${out.sum_sol.toFixed(0)} SOL → MM/terminal scale`);
  }

  let label = 'unsure';
  if (score >= 2) label = 'LIKELY FARM ✓';
  else if (score <= -2) label = 'LIKELY TERMINAL/LEGIT ✗';
  return { label, score, reasons };
}

function judgeBoss(p: ProfileRow, swap: Awaited<ReturnType<typeof swapStats>>,
                   srcDist: Awaited<ReturnType<typeof sourceTagDistribution>>,
                   fund: Awaited<ReturnType<typeof fundingProfile>>): Verdict {
  const reasons: string[] = [];
  let score = 0;
  const inn = fund.inn;

  const sourcesFarm = srcDist
    .filter(r => r.tag?.startsWith('bot_farm') || r.tag === 'sniper' || r.tag === 'rotation_node')
    .reduce((s, r) => s + r.n, 0);
  const sourcesRetail = srcDist
    .filter(r => r.tag === 'retail' || r.tag === 'meme_flipper' || r.tag === 'terminal_user')
    .reduce((s, r) => s + r.n, 0);
  const sourcesNoTag = srcDist
    .filter(r => r.tag === '(no tag)')
    .reduce((s, r) => s + r.n, 0);

  if (inn.span_days > 180) {
    score -= 2;
    reasons.push(`receiving for ${inn.span_days.toFixed(0)}d → exchange/MM`);
  }
  if (sourcesFarm >= 10) {
    score += 2;
    reasons.push(`${sourcesFarm} farm-tagged senders → genuine boss`);
  }
  if (sourcesRetail >= sourcesFarm * 2 && sourcesRetail >= 20) {
    score -= 2;
    reasons.push(`${sourcesRetail} retail senders → likely CEX/exchange/withdrawal`);
  }
  if (inn.sum_sol > 50000) {
    score -= 1;
    reasons.push(`${inn.sum_sol.toFixed(0)} SOL inflow → exchange-scale`);
  }
  if (swap.n_swaps > 500) {
    score -= 1;
    reasons.push(`${swap.n_swaps} own swaps → active trader, not pure collector`);
  }
  if (p.distinct_mints > 100) {
    score -= 1;
    reasons.push(`${p.distinct_mints} distinct mints → portfolio wallet`);
  }

  let label = 'unsure';
  if (score >= 2) label = 'LIKELY FARM-BOSS ✓';
  else if (score <= -2) label = 'LIKELY EXCHANGE/MM ✗';
  return { label, score, reasons };
}

async function inspectOne(wallet: string, idx: number, total: number) {
  const p = await profile(wallet);
  if (!p) {
    console.log(`\n[${idx}/${total}] ${wallet} — no profile in atlas`);
    return null;
  }
  const swap = await swapStats(wallet);
  const recv = await topRecipients(wallet);
  const srcs = await topSources(wallet);
  const recvDist = await recipientTagDistribution(wallet);
  const srcDist = await sourceTagDistribution(wallet);
  const fund = await fundingProfile(wallet);

  const ageDays = p.first_tx_at
    ? (Date.now() - new Date(p.first_tx_at).getTime()) / 86400000
    : 0;
  const idleDays = p.last_tx_at
    ? (Date.now() - new Date(p.last_tx_at).getTime()) / 86400000
    : 0;

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`[${idx}/${total}] ${wallet}  (primary_tag=${p.primary_tag})`);
  console.log(`  https://solscan.io/account/${wallet}`);
  console.log(`  age=${ageDays.toFixed(1)}d  idle=${idleDays.toFixed(1)}d  txs=${p.tx_count}  mints=${p.distinct_mints}  cps=${p.distinct_counterparties}`);
  console.log(`  funded_in=${p.total_funded_sol.toFixed(2)} SOL  fee_spent=${p.total_fee_spent_sol.toFixed(4)} SOL`);
  console.log(`  swaps: total=${swap.n_swaps}  buys=${swap.n_buys}  sells=${swap.n_sells}  mints=${swap.n_mints}  vol=$${swap.total_usd.toFixed(0)}`);
  console.log(`  outflow:  recipients=${fund.out.recipients}  txs=${fund.out.n_tx}  sum=${fund.out.sum_sol.toFixed(2)}sol  avg=${fund.out.avg_sol.toFixed(3)}  span=${fund.out.span_days.toFixed(1)}d`);
  console.log(`  inflow:   sources=${fund.inn.sources}  txs=${fund.inn.n_tx}  sum=${fund.inn.sum_sol.toFixed(2)}sol  avg=${fund.inn.avg_sol.toFixed(3)}  span=${fund.inn.span_days.toFixed(1)}d`);

  if (recv.length > 0) {
    console.log(`  TOP RECIPIENTS (sol out):`);
    for (const r of recv) {
      console.log(`    → ${r.target_wallet}  ${r.total_sol.toFixed(3)}sol×${r.n_tx}  tag=${r.target_tag ?? '-'}`);
    }
  }
  if (srcs.length > 0) {
    console.log(`  TOP SOURCES (sol in):`);
    for (const s of srcs) {
      console.log(`    ← ${s.source_wallet}  ${s.total_sol.toFixed(3)}sol×${s.n_tx}  tag=${s.source_tag ?? '-'}`);
    }
  }
  if (recvDist.length > 0 && fund.out.recipients > 0) {
    const dist = recvDist.map(r => `${r.tag}=${r.n}`).join(', ');
    console.log(`  RECIPIENT-TAG-DIST: ${dist}`);
  }
  if (srcDist.length > 0 && fund.inn.sources > 0) {
    const dist = srcDist.map(r => `${r.tag}=${r.n}`).join(', ');
    console.log(`  SOURCE-TAG-DIST:    ${dist}`);
  }

  // Render verdict only for tags where we have a heuristic
  let verdict: Verdict | null = null;
  if (p.primary_tag === 'bot_farm_distributor' || p.primary_tag === 'gas_distributor') {
    verdict = judgeDistributor(p, swap, recvDist, fund);
  } else if (p.primary_tag === 'bot_farm_boss') {
    verdict = judgeBoss(p, swap, srcDist, fund);
  }
  if (verdict) {
    console.log(`  ▶ VERDICT: ${verdict.label}  (score=${verdict.score})`);
    for (const r of verdict.reasons) console.log(`    • ${r}`);
  }
  return { wallet, tag: p.primary_tag, verdict };
}

async function inspectGroup(tag: string, limit: number, summary: Map<string, { ok: number; bad: number; unsure: number }>) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`>>> primary_tag = ${tag}  (top-${limit} by distinct_counterparties)`);
  console.log('='.repeat(72));
  const wallets = await pickWallets(tag, limit);
  if (wallets.length === 0) {
    console.log(`  (no wallets in atlas)`);
    return;
  }
  const stats = { ok: 0, bad: 0, unsure: 0 };
  for (let i = 0; i < wallets.length; i++) {
    const r = await inspectOne(wallets[i], i + 1, wallets.length);
    if (r?.verdict) {
      if (r.verdict.score >= 2) stats.ok += 1;
      else if (r.verdict.score <= -2) stats.bad += 1;
      else stats.unsure += 1;
    }
  }
  summary.set(tag, stats);
}

async function main() {
  const args = parseArgs();
  console.log(`\n=== Wallet Tagging Verification ===`);
  console.log(`Goal: detect false-positive tags (terminals/MM mislabeled as farms)\n`);

  const summary = new Map<string, { ok: number; bad: number; unsure: number }>();

  if (args.tag) {
    await inspectGroup(args.tag, args.limit, summary);
  } else {
    for (const tag of ['bot_farm_distributor', 'bot_farm_boss', 'gas_distributor', 'scam_operator']) {
      await inspectGroup(tag, args.limit, summary);
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`SUMMARY — false-positive rate per tag:`);
  console.log('='.repeat(72));
  for (const [tag, s] of summary) {
    const total = s.ok + s.bad + s.unsure;
    if (total === 0) { console.log(`  ${tag.padEnd(24)} (no verdicts)`); continue; }
    const fpRate = total > 0 ? Math.round((s.bad * 100) / total) : 0;
    console.log(`  ${tag.padEnd(24)} sample=${total}  legit=${s.ok}  false_pos=${s.bad} (${fpRate}%)  unsure=${s.unsure}`);
  }

  console.log(`\nDONE. Откройте Solscan-ссылки выше для финального вердикта руками.\n`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
