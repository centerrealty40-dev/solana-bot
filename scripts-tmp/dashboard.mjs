import { createServer } from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3007);
const STORE = process.env.STORE_PATH || '/tmp/paper-trades.jsonl';
const VISITS = process.env.VISITS_PATH || '/tmp/dashboard-visits.jsonl';
const HTML_PATH = new URL('./dashboard.html', import.meta.url);

// PAPER-MONEY LEGEND
const POSITION_USD = Number(process.env.POSITION_USD || 100);
const BANK_START_USD = Number(process.env.BANK_START_USD || 1000);

const mcCache = new Map();
async function getMc(m) {
  const c = mcCache.get(m);
  if (c && Date.now() - c.ts < 30000) return c.mc;
  try {
    const r = await fetch('https://frontend-api-v3.pump.fun/coins/' + m, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    const mc = Number(j?.usd_market_cap || 0);
    if (mc > 0) { mcCache.set(m, { mc, ts: Date.now() }); return mc; }
  } catch {}
  return null;
}

function loadStore() {
  if (!fs.existsSync(STORE)) return { open: [], closed: [], firstTs: Date.now(), lastTs: Date.now(), resetTs: 0 };
  const lines = fs.readFileSync(STORE, 'utf-8').split('\n').filter(Boolean);
  const om = new Map(), cl = [];
  let f = Date.now(), l = 0, resetTs = 0;
  for (const ln of lines) {
    if (ln.includes('"kind":"tick"')) continue;
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (e.ts) { if (e.ts < f) f = e.ts; if (e.ts > l) l = e.ts; }
    if (e.kind === 'reset') { resetTs = e.ts; continue; }
    if (e.kind === 'open') {
      om.set(e.mint, { mint: e.mint, symbol: e.symbol, entryTs: e.entryTs, entryMcUsd: e.entryMcUsd, peakMcUsd: e.entryMcUsd, peakPnlPct: 0, trailingArmed: false });
    } else if (e.kind === 'peak' && om.has(e.mint)) {
      const o = om.get(e.mint);
      o.peakMcUsd = Math.max(o.peakMcUsd, e.peakMcUsd || 0);
      o.peakPnlPct = Math.max(o.peakPnlPct, e.peakPnlPct || 0);
      o.trailingArmed = o.trailingArmed || !!e.trailingArmed;
    } else if (e.kind === 'close') { om.delete(e.mint); cl.push(e); }
  }
  return { open: [...om.values()], closed: cl, firstTs: f, lastTs: l, resetTs };
}

function pctToUsd(p) { return (p / 100) * POSITION_USD; }

function metrics(c) {
  const emptyBreak = { TP:{count:0,sumPct:0,sumUsd:0,avgPct:0}, SL:{count:0,sumPct:0,sumUsd:0,avgPct:0}, TRAIL:{count:0,sumPct:0,sumUsd:0,avgPct:0}, TIMEOUT:{count:0,sumPct:0,sumUsd:0,avgPct:0}, NO_DATA:{count:0,sumPct:0,sumUsd:0,avgPct:0} };
  const base = { total: 0, wins: 0, winRate: 0, sumPnl: 0, avgPnl: 0, avgPeak: 0, bestPnl: 0, worstPnl: 0,
                 sumPnlUsd: 0, bestPnlUsd: 0, worstPnlUsd: 0,
                 exits: {TP:0,SL:0,TRAIL:0,TIMEOUT:0,NO_DATA:0}, exitsBreakdown: emptyBreak };
  if (!c.length) return base;
  const ex = {TP:0,SL:0,TRAIL:0,TIMEOUT:0,NO_DATA:0};
  const breakdown = JSON.parse(JSON.stringify(emptyBreak));
  let s=0, p=0, w=0, b=-Infinity, wr=Infinity;
  for (const x of c) {
    s += x.pnlPct;
    p += x.peakPnlPct || 0;
    if (x.pnlPct > 0) w++;
    if (x.pnlPct > b) b = x.pnlPct;
    if (x.pnlPct < wr) wr = x.pnlPct;
    const r = x.exitReason || 'NO_DATA';
    ex[r] = (ex[r] || 0) + 1;
    if (breakdown[r]) {
      breakdown[r].count++;
      breakdown[r].sumPct += x.pnlPct;
      breakdown[r].sumUsd += pctToUsd(x.pnlPct);
    }
  }
  for (const r of Object.keys(breakdown)) {
    breakdown[r].avgPct = breakdown[r].count ? breakdown[r].sumPct / breakdown[r].count : 0;
  }
  return {
    total: c.length, wins: w, winRate: (w/c.length)*100,
    sumPnl: s, avgPnl: s/c.length, avgPeak: p/c.length,
    bestPnl: b, worstPnl: wr,
    sumPnlUsd: pctToUsd(s), bestPnlUsd: pctToUsd(b), worstPnlUsd: pctToUsd(wr),
    exits: ex, exitsBreakdown: breakdown,
  };
}

function hashIp(i) {
  const t = String(i).replace(/^::ffff:/, '').split(',')[0].trim();
  const tr = t.includes(':') ? t.split(':').slice(0,4).join(':') : t.split('.').slice(0,2).join('.');
  return crypto.createHash('sha256').update('laivy|' + tr).digest('hex').slice(0, 12);
}

function logVisit(req) {
  const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0';
  try { fs.appendFileSync(VISITS, JSON.stringify({ ts: Date.now(), ip: hashIp(ip), ua: (req.headers['user-agent'] || '').slice(0, 120) }) + '\n'); } catch {}
}

function vstats() {
  if (!fs.existsSync(VISITS)) return { total: 0, uniqueDay: 0, uniqueHour: 0, unique7d: 0 };
  const al = fs.readFileSync(VISITS, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const n = Date.now(), h = 3600000, d = 86400000;
  const uD = new Set(), uH = new Set(), u7 = new Set();
  for (const v of al) {
    const a = n - v.ts;
    if (a <= 7*d) u7.add(v.ip);
    if (a <= d) uD.add(v.ip);
    if (a <= h) uH.add(v.ip);
  }
  return { total: al.length, uniqueDay: uD.size, uniqueHour: uH.size, unique7d: u7.size };
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('cache-control', 'no-store');
  if (u.pathname === '/') {
    logVisit(req);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(HTML_PATH, 'utf-8'));
    return;
  }
  if (u.pathname === '/api/state') {
    const { open, closed, firstTs, lastTs, resetTs } = loadStore();
    const en = await Promise.all(open.map(async ot => {
      const cm = await getMc(ot.mint);
      const cur = cm || ot.peakMcUsd;
      const pnl = cm ? ((cm/ot.entryMcUsd)-1)*100 : 0;
      return { ...ot, currentMcUsd: cur, peakMcUsd: Math.max(ot.peakMcUsd, cur), pnlPct: pnl, peakPnlPct: Math.max(ot.peakPnlPct, pnl), pnlUsd: pctToUsd(pnl), ageMin: (Date.now()-ot.entryTs)/60000, hasLiveMc: !!cm };
    }));
    const m = metrics(closed);
    const closedWithUsd = closed.map(c => ({ ...c, pnlUsd: pctToUsd(c.pnlPct) }));
    const unrealizedUsd = en.reduce((s, x) => s + x.pnlUsd, 0);
    const startedAt = resetTs || firstTs;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      now: Date.now(), startedAt, lastTs,
      hoursOfData: (Date.now() - startedAt) / 3600000,
      legend: {
        positionUsd: POSITION_USD,
        bankStartUsd: BANK_START_USD,
        bankNowUsd: BANK_START_USD + m.sumPnlUsd,
        capitalAtRiskUsd: en.length * POSITION_USD,
        unrealizedUsd,
        roiPct: (m.sumPnlUsd / BANK_START_USD) * 100,
      },
      metrics: m, open: en,
      recentClosed: [...closedWithUsd].sort((a,b)=>b.exitTs-a.exitTs).slice(0,30),
      topWinners: [...closedWithUsd].sort((a,b)=>b.pnlPct-a.pnlPct).slice(0,5),
      topLosers: [...closedWithUsd].sort((a,b)=>a.pnlPct-b.pnlPct).slice(0,5),
      config: { tp: 3, sl: 0.3, trailTrigger: 1.5, trailDrop: 0.4, timeoutHours: 12, calibration: 'V7' }
    }));
    return;
  }
  if (u.pathname === '/api/visits') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(vstats()));
    return;
  }
  if (u.pathname === '/api/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => console.log('[dashboard] http://127.0.0.1:' + PORT + ' store=' + STORE + ' position=$' + POSITION_USD + ' bank=$' + BANK_START_USD));
