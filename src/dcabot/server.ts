/**
 * dca_frontrun — private dashboard (fastify). Binds to 127.0.0.1 by default; reachable
 * only over the VPN. Read-only views over the dcabot_* tables.
 */
import Fastify from 'fastify';
import { dcabotConfig as cfg } from './config.js';
import { pgSql } from './db.js';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DCA Front-run — paper</title>
<style>
  :root{color-scheme:dark}
  body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0c0f14;color:#e6edf3}
  header{padding:16px 20px;border-bottom:1px solid #1d2530;display:flex;gap:24px;align-items:baseline;flex-wrap:wrap}
  h1{font-size:16px;margin:0;color:#7ee787}
  .kpi{font-size:13px;color:#8b949e}.kpi b{color:#e6edf3;font-size:16px}
  main{padding:16px 20px}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #161b22;white-space:nowrap}
  th{color:#8b949e;font-weight:600}
  .pos{color:#7ee787}.neg{color:#ff7b72}.mut{color:#8b949e}
  .pill{padding:1px 7px;border-radius:10px;font-size:11px;background:#1d2530}
  h2{font-size:13px;color:#8b949e;margin:24px 0 0;text-transform:uppercase;letter-spacing:.05em}
</style></head>
<body>
<header>
  <h1>DCA FRONT-RUN · paper</h1>
  <span class="kpi">Equity <b id="eq">—</b></span>
  <span class="kpi">Realized <b id="rl">—</b></span>
  <span class="kpi">Unrealized <b id="ur">—</b></span>
  <span class="kpi">Open <b id="op">—</b></span>
  <span class="kpi">Max capital used <b id="mc">—</b></span>
  <span class="kpi mut" id="ts"></span>
</header>
<main>
  <h2>Open positions</h2>
  <table id="open"><thead><tr>
    <th>Token</th><th>State</th><th>Legit</th><th>Est gain</th><th>Avg entry</th><th>Qty</th>
    <th>Cost $</th><th>Realized $</th><th>Cycle $</th><th>Planned</th>
  </tr></thead><tbody></tbody></table>
  <h2>Recently closed</h2>
  <table id="closed"><thead><tr>
    <th>Token</th><th>Reason</th><th>Realized $</th><th>Max cap $</th><th>Legit</th><th>Cycle $</th>
  </tr></thead><tbody></tbody></table>
</main>
<script>
const money=n=>(n==null?'—':'$'+Number(n).toLocaleString(undefined,{maximumFractionDigits:2}));
const cls=n=>Number(n)>=0?'pos':'neg';
async function j(u){const r=await fetch(u);return r.ok?r.json():null}
function row(p){
  return '<tr><td>'+(p.symbol||p.mint.slice(0,6))+'</td>'+
    '<td><span class="pill">'+p.state+'</span></td>'+
    '<td>'+(p.legit_score==null?'—':Math.round(p.legit_score))+'</td>'+
    '<td>'+(p.est_gain_pct==null?'—':Number(p.est_gain_pct).toFixed(1)+'%')+'</td>'+
    '<td>'+(p.avg_entry_price?Number(p.avg_entry_price).toPrecision(4):'—')+'</td>'+
    '<td>'+Number(p.qty_token).toLocaleString(undefined,{maximumFractionDigits:0})+'</td>'+
    '<td>'+money(p.cost_usd)+'</td>'+
    '<td class="'+cls(p.realized_usd)+'">'+money(p.realized_usd)+'</td>'+
    '<td>'+money(p.cycle_usd)+'</td>'+
    '<td>'+p.planned_cycles+'</td></tr>';
}
async function refresh(){
  const s=await j('/api/summary');
  if(s){eq.textContent=money(s.equity_usd);rl.textContent=money(s.realized_usd);
    ur.textContent=money(s.unrealized_usd);op.textContent=s.open_positions;
    mc.textContent=money(s.max_capital_usd);
    rl.className=cls(s.realized_usd);ur.className=cls(s.unrealized_usd);
    ts.textContent='updated '+new Date().toLocaleTimeString();}
  const o=await j('/api/positions?status=open');
  if(o)document.querySelector('#open tbody').innerHTML=o.map(row).join('')||'<tr><td colspan=10 class=mut>no open positions</td></tr>';
  const c=await j('/api/positions?status=closed');
  if(c)document.querySelector('#closed tbody').innerHTML=c.map(p=>'<tr><td>'+(p.symbol||p.mint.slice(0,6))+'</td><td class=mut>'+(p.close_reason||'')+'</td><td class="'+cls(p.realized_usd)+'">'+money(p.realized_usd)+'</td><td>'+money(p.max_capital_usd)+'</td><td>'+(p.legit_score==null?'—':Math.round(p.legit_score))+'</td><td>'+money(p.cycle_usd)+'</td></tr>').join('')||'<tr><td colspan=6 class=mut>none yet</td></tr>';
}
refresh();setInterval(refresh,5000);
</script>
</body></html>`;

export async function startDashboard(): Promise<void> {
  const app = Fastify({ logger: false });

  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(PAGE);
  });

  app.get('/api/summary', async () => {
    const rows = await pgSql`SELECT * FROM dcabot_equity ORDER BY ts DESC LIMIT 1`;
    return rows[0] || { equity_usd: cfg.bankUsd, realized_usd: 0, unrealized_usd: 0, open_positions: 0, max_capital_usd: 0 };
  });

  app.get('/api/positions', async (req) => {
    const status = (req.query as { status?: string })?.status === 'closed' ? 'closed' : 'open';
    if (status === 'closed') {
      return pgSql`
        SELECT * FROM dcabot_positions WHERE state IN ('closed','skipped')
        ORDER BY updated_at DESC LIMIT 50`;
    }
    return pgSql`
      SELECT * FROM dcabot_positions WHERE state IN ('scoring','armed','managing','closing')
      ORDER BY created_at ASC LIMIT 100`;
  });

  app.get('/api/fills', async (req) => {
    const id = Number((req.query as { position?: string })?.position || 0);
    if (!id) return [];
    return pgSql`SELECT * FROM dcabot_fills WHERE position_id = ${id} ORDER BY ts ASC`;
  });

  app.get('/api/equity', async () => {
    return pgSql`SELECT ts, equity_usd, realized_usd, unrealized_usd FROM dcabot_equity ORDER BY ts DESC LIMIT 500`;
  });

  await app.listen({ host: cfg.dashHost, port: cfg.dashPort });
  console.log(`[dcabot] dashboard on http://${cfg.dashHost}:${cfg.dashPort} (private)`);
}
