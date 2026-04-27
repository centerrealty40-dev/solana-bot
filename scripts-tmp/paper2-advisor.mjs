import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const PAPER2_DIR = process.env.PAPER2_DIR || '/opt/solana-alpha/data/paper2';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const MIN_TRADES_FOR_RANK = Number(process.env.PAPER2_ADVISOR_MIN_TRADES || 12);

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const ln of lines) {
    try { out.push(JSON.parse(ln)); } catch {}
  }
  return out;
}

function listStrategyFiles() {
  if (!fs.existsSync(PAPER2_DIR)) return [];
  return fs
    .readdirSync(PAPER2_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(PAPER2_DIR, f))
    .sort();
}

function metricForEvents(events) {
  const closes = events.filter((e) => e.kind === 'close');
  const openNow = new Set(events.filter((e) => e.kind === 'open').map((e) => e.mint));
  for (const c of closes) openNow.delete(c.mint);
  if (!closes.length) {
    return { trades: 0, sumPnlPct: 0, avgPnlPct: 0, winRate: 0, maxDrawdownPct: 0, score: -Infinity, closes: [], openNow: openNow.size };
  }
  const sorted = [...closes].sort((a, b) => (a.exitTs || 0) - (b.exitTs || 0));
  let eq = 0;
  let peak = 0;
  let mdd = 0;
  let wins = 0;
  for (const c of sorted) {
    const p = Number(c.pnlPct || 0);
    if (p > 0) wins++;
    eq += p;
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq - peak);
  }
  const sumPnlPct = sorted.reduce((s, c) => s + Number(c.pnlPct || 0), 0);
  const avgPnlPct = sumPnlPct / sorted.length;
  const winRate = (wins / sorted.length) * 100;
  const maxDrawdownPct = mdd;
  const score = sorted.length >= MIN_TRADES_FOR_RANK ? sumPnlPct + maxDrawdownPct * 0.5 : -Infinity;
  return { trades: sorted.length, sumPnlPct, avgPnlPct, winRate, maxDrawdownPct, score, closes: sorted, openNow: openNow.size };
}

function mintAdvice(closes) {
  const byMint = new Map();
  for (const c of closes) {
    const m = c.mint;
    if (!byMint.has(m)) byMint.set(m, { n: 0, pnl: 0, wins: 0, symbol: c.symbol || '?' });
    const row = byMint.get(m);
    const p = Number(c.pnlPct || 0);
    row.n += 1;
    row.pnl += p;
    if (p > 0) row.wins += 1;
  }
  const arr = [...byMint.entries()].map(([mint, r]) => ({
    mint,
    symbol: r.symbol,
    n: r.n,
    pnl: r.pnl,
    winRate: r.n ? (r.wins / r.n) * 100 : 0,
  }));
  const add = arr
    .filter((x) => x.n >= 3 && x.winRate >= 65 && x.pnl > 10)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 5);
  const drop = arr
    .filter((x) => x.n >= 2 && x.pnl < -12)
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 5);
  return { add, drop };
}

function tpAdvice(closes) {
  if (!closes.length) return [];
  const tp = closes.filter((c) => c.exitReason === 'TP').length;
  const timeout = closes.filter((c) => c.exitReason === 'TIMEOUT').length;
  const trail = closes.filter((c) => c.exitReason === 'TRAIL').length;
  const sl = closes.filter((c) => c.exitReason === 'SL').length;
  const total = closes.length;
  const out = [];
  if (timeout / total > 0.45) out.push('Много TIMEOUT: предложить снизить TP или таймаут, чтобы ускорить фиксацию.');
  if ((trail + timeout) / total > 0.6 && tp / total < 0.1) out.push('TP срабатывает редко: можно опустить первую ступень TP.');
  if (sl / total > 0.35) out.push('Высокий SL-рейт: усилить фильтр входа или ужесточить anti-knife.');
  if (!out.length) out.push('Текущая конфигурация exit выглядит сбалансированной на текущей выборке.');
  return out;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const { sendTagged } = await import('../scripts/lib/telegram.mjs');
  await sendTagged('ADVICE', 'paper2', text);
  return;
  // unreachable legacy path kept for safety
  // eslint-disable-next-line no-unreachable
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Telegram ${r.status}: ${body.slice(0, 200)}`);
  }
}

async function main() {
  const files = listStrategyFiles();
  if (!files.length) throw new Error(`No strategy files in ${PAPER2_DIR}`);

  const strategies = files.map((fp) => {
    const id = path.basename(fp, '.jsonl');
    const events = parseJsonl(fp);
    const m = metricForEvents(events);
    return { id, ...m };
  });
  strategies.sort((a, b) => b.score - a.score);
  const best = strategies[0];
  const mint = mintAdvice(best?.closes || []);
  const tp = tpAdvice(best?.closes || []);

  const payload = {
    generated_at: new Date().toISOString(),
    paper2_dir: PAPER2_DIR,
    min_trades_for_rank: MIN_TRADES_FOR_RANK,
    ranking: strategies.map((s) => ({
      id: s.id,
      trades: s.trades,
      sum_pnl_pct: Number(s.sumPnlPct.toFixed(2)),
      avg_pnl_pct: Number(s.avgPnlPct.toFixed(2)),
      win_rate_pct: Number(s.winRate.toFixed(2)),
      max_drawdown_pct: Number(s.maxDrawdownPct.toFixed(2)),
      open_now: s.openNow,
      score: Number.isFinite(s.score) ? Number(s.score.toFixed(2)) : null,
    })),
    advisor: {
      primary_strategy: best?.id || null,
      tp_suggestions: tp,
      mint_add_suggestions: mint.add.map((x) => ({ symbol: x.symbol, mint: x.mint, trades: x.n, pnl_pct: Number(x.pnl.toFixed(2)), win_rate_pct: Number(x.winRate.toFixed(1)) })),
      mint_drop_suggestions: mint.drop.map((x) => ({ symbol: x.symbol, mint: x.mint, trades: x.n, pnl_pct: Number(x.pnl.toFixed(2)), win_rate_pct: Number(x.winRate.toFixed(1)) })),
      note: 'Advisor only. Suggestions are NOT auto-applied.',
    },
  };

  const outPath = process.env.PAPER2_ADVISOR_OUT || '/opt/solana-alpha/data/paper2/advisor-latest.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));

  const lines = [];
  lines.push('paper2 advisor');
  if (best) lines.push(`primary: ${best.id} (trades=${best.trades}, sum=${best.sumPnlPct.toFixed(1)}%)`);
  lines.push('');
  lines.push('TP suggestions:');
  for (const s of tp) lines.push(`- ${s}`);
  lines.push('');
  lines.push('Mint add suggestions:');
  if (!mint.add.length) lines.push('- none');
  for (const a of mint.add) lines.push(`- ${a.symbol} ${a.mint.slice(0, 6)}... pnl=${a.pnl.toFixed(1)}% wr=${a.winRate.toFixed(0)}%`);
  lines.push('');
  lines.push('Mint drop suggestions:');
  if (!mint.drop.length) lines.push('- none');
  for (const d of mint.drop) lines.push(`- ${d.symbol} ${d.mint.slice(0, 6)}... pnl=${d.pnl.toFixed(1)}% wr=${d.winRate.toFixed(0)}%`);

  await sendTelegram(lines.join('\n').slice(0, 3900));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
