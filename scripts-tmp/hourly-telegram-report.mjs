import 'dotenv/config';
import fs from 'node:fs';

const STORE_PATH = process.env.PAPER_TRADES_PATH || '/opt/solana-alpha/data/paper-trades.jsonl';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const POSITION_USD = Number(process.env.POSITION_USD || 100);

const HOUR_MS = 60 * 60 * 1000;
const now = Date.now();
const since = now - HOUR_MS;

function shortMint(m) {
  if (!m || m.length < 10) return m || '-';
  return `${m.slice(0, 4)}...${m.slice(-4)}`;
}

function toNum(v, d = 2) {
  return Number.isFinite(v) ? Number(v.toFixed(d)) : 0;
}

function fmtPct(v) {
  const x = Number(v || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
}

function fmtUsd(v) {
  const x = Number(v || 0);
  return `${x >= 0 ? '+' : ''}$${x.toFixed(2)}`;
}

function parseJsonl(path) {
  if (!fs.existsSync(path)) return [];
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const ln of lines) {
    try {
      out.push(JSON.parse(ln));
    } catch {}
  }
  return out;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
    process.exit(1);
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Telegram ${r.status}: ${body.slice(0, 200)}`);
  }
}

function buildReport(events) {
  const byMintOpen = new Map();
  const latestTick = new Map();
  let lastResetTs = 0;

  for (const e of events) {
    if (e.kind === 'reset') lastResetTs = Math.max(lastResetTs, e.ts || 0);
  }

  const scoped = events.filter((e) => (e.ts || 0) >= lastResetTs);

  for (const e of scoped) {
    if (e.kind === 'open') byMintOpen.set(e.mint, e);
    if (e.kind === 'close') byMintOpen.delete(e.mint);
    if (e.kind === 'tick') latestTick.set(e.mint, e);
  }

  const hourly = scoped.filter((e) => (e.ts || 0) >= since);
  const opens1h = hourly.filter((e) => e.kind === 'open');
  const closes1h = hourly.filter((e) => e.kind === 'close');
  const partials1h = hourly.filter((e) => e.kind === 'partial-close');
  const evals1h = hourly.filter((e) => e.kind === 'eval');

  const failReasons = new Map();
  for (const e of evals1h) {
    if (e.pass) continue;
    for (const r of e.reasons || []) {
      failReasons.set(r, (failReasons.get(r) || 0) + 1);
    }
  }
  const topFails = [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const realizedPct1h = closes1h.reduce((s, e) => s + Number(e.pnlPct || 0), 0);
  const realizedUsd1h = realizedPct1h;

  const openRows = [];
  let unrealizedUsd = 0;
  for (const [mint, o] of byMintOpen.entries()) {
    const t = latestTick.get(mint);
    const curMc = Number(t?.mc || o.entryMcUsd || 0);
    const x = o.entryMcUsd > 0 ? curMc / o.entryMcUsd : 0;
    const pnlPct = (x - 1) * 100;
    const pnlUsd = (POSITION_USD * pnlPct) / 100;
    unrealizedUsd += pnlUsd;
    openRows.push({
      mint,
      symbol: o.symbol || '-',
      pnlPct,
      pnlUsd,
      ageMin: ((now - Number(o.entryTs || now)) / 60000),
    });
  }
  openRows.sort((a, b) => b.pnlPct - a.pnlPct);

  const topOpens = openRows.slice(0, 6);
  const topCloses = closes1h.slice(-8);
  const topBuys = opens1h.slice(-8);

  const lines = [];
  lines.push(`Hourly paper report`);
  lines.push(`Window: last 60m`);
  lines.push(``);
  lines.push(`Opened: ${opens1h.length} | Closed: ${closes1h.length} | Partial: ${partials1h.length}`);
  lines.push(`Realized 1h: ${fmtUsd(realizedUsd1h)} | Unrealized now: ${fmtUsd(unrealizedUsd)}`);
  lines.push(`Open positions: ${byMintOpen.size}`);
  lines.push(``);

  lines.push(`Recent buys (1h):`);
  if (!topBuys.length) lines.push(`- none`);
  for (const b of topBuys) lines.push(`- ${b.symbol || '-'} ${shortMint(b.mint)} entry_mc=${toNum((b.entryMcUsd || 0) / 1000, 1)}k`);
  lines.push(``);

  lines.push(`Recent closes (1h):`);
  if (!topCloses.length) lines.push(`- none`);
  for (const c of topCloses) {
    const usd = Number(c.pnlPct || 0);
    lines.push(`- ${c.symbol || '-'} ${shortMint(c.mint)} ${c.exitReason} ${fmtPct(c.pnlPct)} ${fmtUsd(usd)}`);
  }
  lines.push(``);

  lines.push(`Open positions now (top):`);
  if (!topOpens.length) lines.push(`- none`);
  for (const o of topOpens) {
    lines.push(`- ${o.symbol} ${shortMint(o.mint)} ${fmtPct(o.pnlPct)} ${fmtUsd(o.pnlUsd)} age=${Math.round(o.ageMin)}m`);
  }
  lines.push(``);

  lines.push(`Top fail reasons (1h):`);
  if (!topFails.length) lines.push(`- none`);
  for (const [k, v] of topFails) lines.push(`- ${k}: ${v}`);

  return lines.join('\n').slice(0, 3900);
}

async function main() {
  const events = parseJsonl(STORE_PATH);
  const report = buildReport(events);
  await sendTelegram(report);
  console.log('sent');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
