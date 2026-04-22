/**
 * Paper-trader STATS — сводка по виртуальному портфелю.
 *
 * Показывает:
 *   - кол-во trades по статусам
 *   - реализованный + нереализованный PnL
 *   - распределение return'ов
 *   - топ wins / worst losses
 *   - все open позиции с текущим P&L
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../src/core/db/client.js';

async function rows<T = any>(q: any): Promise<T[]> {
  const r: any = await db.execute(q);
  return Array.isArray(r) ? r : (r.rows ?? []);
}

async function main() {
  const all = await db.select().from(schema.paperTrades);
  if (all.length === 0) {
    console.log('No paper trades yet. Run `npm run paper:trader` to start.');
    process.exit(0);
  }

  // 1. Status breakdown
  const byStatus: Record<string, number> = {};
  for (const t of all) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  console.log('='.repeat(72));
  console.log(`PAPER TRADES — total: ${all.length}`);
  console.log('='.repeat(72));
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${n}`);
  }

  // 2. Realized PnL
  const realized = all.reduce((s, t) => s + Number(t.realizedPnlUsd), 0);
  const totalStake = all.reduce((s, t) => s + Number(t.entrySizeUsd), 0);
  console.log(`\nTotal stake invested: $${totalStake.toFixed(2)}`);
  console.log(`Realized PnL:         $${realized.toFixed(2)}`);

  // 3. Unrealized for open positions: assume current price = lastPriceUsd
  const open = all.filter(t => !t.status.startsWith('closed'));
  const unrealized = open.reduce((s, t) => {
    const ratio = t.entryPriceUsd > 0 ? Number(t.lastPriceUsd) / Number(t.entryPriceUsd) : 0;
    const valueLeft = Number(t.entrySizeUsd) * Number(t.remainingFraction) * ratio;
    const costLeft = Number(t.entrySizeUsd) * Number(t.remainingFraction);
    return s + (valueLeft - costLeft);
  }, 0);
  console.log(`Unrealized PnL (open, ${open.length}): $${unrealized.toFixed(2)}`);
  console.log(`TOTAL EQUITY P&L:     $${(realized + unrealized).toFixed(2)}`);
  console.log(`ROI:                  ${((realized + unrealized) / Math.max(totalStake, 1) * 100).toFixed(1)}%`);

  // 4. Closed positions return distribution
  const closed = all.filter(t => t.status.startsWith('closed'));
  if (closed.length > 0) {
    const finalRets = closed.map(t => Number(t.realizedPnlUsd) / Number(t.entrySizeUsd));
    finalRets.sort((a, b) => a - b);
    const median = finalRets[Math.floor(finalRets.length / 2)];
    const wins = finalRets.filter(r => r > 0).length;
    const bigWins = finalRets.filter(r => r > 1).length;       // >2x net
    const moonshots = finalRets.filter(r => r > 10).length;    // >11x net
    const losses = finalRets.filter(r => r < -0.5).length;
    console.log(`\n${'='.repeat(72)}`);
    console.log(`CLOSED POSITIONS — ${closed.length}`);
    console.log('='.repeat(72));
    console.log(`  median return: ${(median * 100).toFixed(1)}%`);
    console.log(`  win rate: ${wins}/${closed.length} (${(wins / closed.length * 100).toFixed(0)}%)`);
    console.log(`  >2x net (>+100%): ${bigWins}`);
    console.log(`  >11x net (>+1000% = "moonshot"): ${moonshots}`);
    console.log(`  losses >-50%: ${losses}`);
  }

  // 5. Top wins
  const topWins = [...closed]
    .sort((a, b) => Number(b.realizedPnlUsd) - Number(a.realizedPnlUsd))
    .slice(0, 5);
  if (topWins.length > 0) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`TOP WINS:`);
    console.log('='.repeat(72));
    for (const t of topWins) {
      console.log(`  ${t.mint}  pnl=$${Number(t.realizedPnlUsd).toFixed(2)}  status=${t.status}`);
      console.log(`    https://dexscreener.com/solana/${t.mint}`);
    }
  }

  // 6. Worst losses
  const worstLosses = [...closed]
    .sort((a, b) => Number(a.realizedPnlUsd) - Number(b.realizedPnlUsd))
    .slice(0, 5);
  if (worstLosses.length > 0 && Number(worstLosses[0].realizedPnlUsd) < 0) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`WORST LOSSES:`);
    console.log('='.repeat(72));
    for (const t of worstLosses) {
      if (Number(t.realizedPnlUsd) >= 0) break;
      console.log(`  ${t.mint}  pnl=$${Number(t.realizedPnlUsd).toFixed(2)}  status=${t.status}`);
    }
  }

  // 7. Open positions
  if (open.length > 0) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`OPEN POSITIONS — ${open.length}`);
    console.log('='.repeat(72));
    for (const t of [...open].sort((a, b) =>
      (Number(b.lastPriceUsd) / Number(b.entryPriceUsd)) - (Number(a.lastPriceUsd) / Number(a.entryPriceUsd))
    )) {
      const cur = Number(t.lastPriceUsd) / Number(t.entryPriceUsd) - 1;
      const peak = Number(t.maxPriceSeenUsd) / Number(t.entryPriceUsd) - 1;
      const ageH = (Date.now() - new Date(t.entryTs).getTime()) / 3_600_000;
      console.log(`  ${t.mint}  cur=${(cur * 100).toFixed(0)}%  peak=${(peak * 100).toFixed(0)}%  rem=${Number(t.remainingFraction).toFixed(2)}  realized=$${Number(t.realizedPnlUsd).toFixed(2)}  age=${ageH.toFixed(1)}h  status=${t.status}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
