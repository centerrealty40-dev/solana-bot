/**
 * dca_frontrun — private dashboard (fastify). Binds to 127.0.0.1 by default; reachable
 * only over the VPN. Read-only views over the dcabot_* tables.
 *
 * Journal-style UI: open + closed positions, each expandable into a per-position timeline
 * (signal → buys per cycle → average-downs → take-profits → exit/early-cancel → close) with
 * Moscow-time stamps, fill price, quantity, USD and realized PnL.
 */
import Fastify from 'fastify';
import { dcabotConfig as cfg } from './config.js';
import { pgSql } from './db.js';
import { getPriceUsd } from './market.js';

const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DCA Front-run — paper</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:0;background:#0c0f14;color:#e6edf3}
  header{padding:14px 20px;border-bottom:1px solid #1d2530;display:flex;gap:22px;align-items:baseline;flex-wrap:wrap}
  h1{font-size:16px;margin:0;color:#7ee787;letter-spacing:.04em}
  .kpi{font-size:13px;color:#8b949e}.kpi b{color:#e6edf3;font-size:16px}
  main{padding:14px 20px}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #161b22;white-space:nowrap}
  th{color:#8b949e;font-weight:600}
  tr.head{cursor:pointer}tr.head:hover td{background:#10151c}
  .pos{color:#7ee787}.neg{color:#ff7b72}.mut{color:#8b949e}
  .pill{padding:1px 7px;border-radius:10px;font-size:11px;background:#1d2530;color:#cdd9e5}
  .pill.s_managing{background:#1b3a2a;color:#7ee787}.pill.s_armed{background:#2b2f17;color:#e3d04f}
  .pill.s_scoring{background:#1d2530}.pill.s_closing{background:#3a2a1b;color:#ffa657}
  .pill.s_closed{background:#21262d}.pill.s_skipped{background:#21262d;color:#8b949e}
  h2{font-size:12px;color:#8b949e;margin:22px 0 0;text-transform:uppercase;letter-spacing:.06em}
  .arrow{display:inline-block;width:12px;color:#8b949e}
  .detail td{background:#0a0d12;border-bottom:1px solid #161b22}
  .meta{display:flex;gap:18px;flex-wrap:wrap;margin:4px 0 10px;font-size:12px;color:#8b949e}
  .meta b{color:#e6edf3}
  .tl{width:100%;border-collapse:collapse;font-size:12.5px}
  .tl th{font-size:11px}
  .tl td{border-bottom:1px solid #11161d;padding:5px 8px}
  .ev{font-weight:600}
  .buy{color:#79c0ff}.sell{color:#ffa657}
  a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
  .copy{cursor:pointer;border-bottom:1px dotted #4b5563}
  code{color:#cdd9e5}
</style></head>
<body>
<header>
  <h1>DCA FRONT-RUN · paper</h1>
  <span class="kpi">Капитал <b id="eq">—</b></span>
  <span class="kpi">Реализ. <b id="rl">—</b></span>
  <span class="kpi">Нереализ. <b id="ur">—</b></span>
  <span class="kpi">Открыто <b id="op">—</b></span>
  <span class="kpi">Макс. задействовано <b id="mc">—</b></span>
  <span class="kpi mut" id="ts"></span>
</header>
<main>
  <h2>Открытые позиции</h2>
  <table id="open"><thead><tr>
    <th></th><th>Токен</th><th>Статус</th><th>Legit</th><th>Оценка роста</th>
    <th>Ср. вход</th><th>Цена сейчас</th><th>Кол-во</th><th>Стоимость $</th>
    <th>Нереализ. $</th><th>Реализ. $</th><th>Цикл $</th><th>Циклов</th>
  </tr></thead><tbody></tbody></table>
  <h2>Недавно закрытые</h2>
  <table id="closed"><thead><tr>
    <th></th><th>Токен</th><th>Причина</th><th>Реализ. $</th><th>Макс. кап. $</th>
    <th>Legit</th><th>Цикл $</th><th>Закрыто (МСК)</th>
  </tr></thead><tbody></tbody></table>
</main>
<script>
const MSK={timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'};
const fmtMsk=t=>{ if(!t) return '—'; const d=new Date(t); if(isNaN(d)) return '—';
  return new Intl.DateTimeFormat('ru-RU',MSK).format(d).replace(',','')+' МСК'; };
const money=n=>(n==null?'—':'$'+Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2}));
const num=(n,d=0)=>(n==null?'—':Number(n).toLocaleString('ru-RU',{maximumFractionDigits:d}));
const px=n=>(n==null||Number(n)===0?'—':'$'+Number(n).toPrecision(4));
const cls=n=>Number(n)>=0?'pos':'neg';
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function j(u){const r=await fetch(u);return r.ok?r.json():null}

const REASON={
  entry:'Вход (после цикла {c})', avg_down:'Усреднение (−5%)', take_profit:'Фиксация прибыли (+5%)',
  exit_pre_first:'Предвыход 50% (за 2 цикла до конца)', exit_pre_final:'Финальный выход (за 1 цикл до конца)',
  completed:'Закрытие — ордер завершён', early_cancel_profit:'Ранняя отмена (в плюсе) — продажа 100%',
  early_cancel_loss_1:'Ранняя отмена (в минусе) — продажа 50%', early_cancel_loss_2:'Ранняя отмена — продажа остатка',
  tp_dust:'Закрытие остатка'
};
const reasonLabel=(r,c)=>(REASON[r]||r||'').replace('{c}',c==null?'?':c);

function copySpan(txt,short){return '<span class="copy" title="нажми, чтобы скопировать" onclick="navigator.clipboard.writeText(\\''+esc(txt)+'\\')">'+esc(short)+'</span>';}

const expanded={};
function toggle(kind,id){ expanded[kind+id]=!expanded[kind+id];
  const d=document.getElementById('det_'+kind+id);
  if(d){ d.style.display=expanded[kind+id]?'table-row':'none';
    if(expanded[kind+id]&&!d.dataset.loaded){loadDetail(kind,id,d);} }
  const a=document.getElementById('arr_'+kind+id); if(a)a.textContent=expanded[kind+id]?'▾':'▸';
}

async function loadDetail(kind,id,tr){
  const cell=tr.querySelector('td');
  cell.innerHTML='<span class=mut>загрузка…</span>';
  const data=await j('/api/position?id='+id);
  if(!data){cell.innerHTML='<span class=neg>не загрузилось</span>';return;}
  const p=data.position, fills=data.fills||[], sc=data.score;
  const freq=p.cycle_freq_sec?Math.round(p.cycle_freq_sec)+'с':'—';
  const meta='<div class=meta>'
    +'<span>Mint: '+copySpan(p.mint,p.mint.slice(0,8)+'…'+p.mint.slice(-4))+' '
      +'<a href="https://gmgn.ai/sol/token/'+esc(p.mint)+'" target=_blank>GMGN</a></span>'
    +'<span>Оператор: '+copySpan(p.operator_wallet,(p.operator_wallet||'').slice(0,6)+'…')+'</span>'
    +'<span>Vault: '+copySpan(p.vault,(p.vault||'').slice(0,6)+'…')+'</span>'
    +'<span>План: <b>'+num(p.planned_cycles)+'</b> циклов × <b>'+money(p.cycle_usd)+'</b> / '+freq+'</span>'
    +'<span>Депозит: <b>'+money(p.deposit_usd)+'</b></span>'
    +'<span>Оценка роста: <b>'+(p.est_gain_pct==null?'—':Number(p.est_gain_pct).toFixed(1)+'%')+'</b></span>'
    +'<span>Legit: <b>'+(p.legit_score==null?'—':Math.round(p.legit_score))+'</b>'
      +(sc?(' ('+(sc.mint_renounced?'mint✓':'mint✗')+', '+(sc.freeze_renounced?'freeze✓':'freeze✗')
        +', top10 '+(sc.top10_pct==null?'—':Math.round(sc.top10_pct)+'%')+')'):'')+'</span>'
    +(data.current_price?'<span>Цена сейчас: <b>'+px(data.current_price)+'</b></span>':'')
    +(data.unrealized_usd!=null?'<span>Нереализ.: <b class="'+cls(data.unrealized_usd)+'">'+money(data.unrealized_usd)+'</b></span>':'')
    +'</div>';

  // build timeline: signal + fills + close marker
  const rows=[];
  rows.push({t:p.created_at,ev:'Сигнал обнаружен — позиция заведена',side:'',price:null,qty:null,usd:null,real:null,cyc:null});
  for(const f of fills){
    rows.push({t:f.ts,ev:reasonLabel(f.reason,f.cycle_index),side:f.side,price:f.price_usd,
      qty:f.qty_token,usd:f.usd,real:f.realized_usd,cyc:f.cycle_index});
  }
  if(p.closed_at&&(p.state==='closed'||p.state==='skipped')){
    rows.push({t:p.closed_at,ev:'Закрыто'+(p.close_reason?' — '+p.close_reason:''),side:'',price:null,qty:null,usd:null,real:null,cyc:null});
  }
  rows.sort((a,b)=>new Date(a.t)-new Date(b.t));
  let tl='<table class=tl><thead><tr><th>Время (МСК)</th><th>Событие</th><th>Цикл</th><th>Сторона</th>'
    +'<th>Цена</th><th>Кол-во</th><th>USD</th><th>Реализ.</th></tr></thead><tbody>';
  for(const r of rows){
    tl+='<tr><td class=mut>'+fmtMsk(r.t)+'</td>'
      +'<td class=ev>'+esc(r.ev)+'</td>'
      +'<td>'+(r.cyc==null?'':('#'+r.cyc))+'</td>'
      +'<td class="'+(r.side==='buy'?'buy':(r.side==='sell'?'sell':'mut'))+'">'+(r.side==='buy'?'покупка':(r.side==='sell'?'продажа':'—'))+'</td>'
      +'<td>'+px(r.price)+'</td>'
      +'<td>'+(r.qty==null?'—':num(r.qty,0))+'</td>'
      +'<td>'+money(r.usd)+'</td>'
      +'<td class="'+(r.real==null?'mut':cls(r.real))+'">'+(r.real==null?'—':money(r.real))+'</td></tr>';
  }
  if(!fills.length) tl+='<tr><td colspan=8 class=mut>сделок ещё не было (ждём исполнения цикла оператора)</td></tr>';
  tl+='</tbody></table>';
  cell.innerHTML=meta+tl;
  tr.dataset.loaded='1';
}

function openRow(p){
  const id=p.id;
  return '<tr class=head onclick="toggle(\\'o\\','+id+')"><td><span class=arrow id="arr_o'+id+'">▸</span></td>'
    +'<td>'+esc(p.symbol||p.mint.slice(0,6))+'</td>'
    +'<td><span class="pill s_'+esc(p.state)+'">'+esc(p.state)+'</span></td>'
    +'<td>'+(p.legit_score==null?'—':Math.round(p.legit_score))+'</td>'
    +'<td>'+(p.est_gain_pct==null?'—':Number(p.est_gain_pct).toFixed(1)+'%')+'</td>'
    +'<td>'+px(p.avg_entry_price)+'</td>'
    +'<td>'+px(p.cur_price)+'</td>'
    +'<td>'+num(p.qty_token,0)+'</td>'
    +'<td>'+money(p.cost_usd)+'</td>'
    +'<td class="'+cls(p.unrealized_usd)+'">'+(p.unrealized_usd==null?'—':money(p.unrealized_usd))+'</td>'
    +'<td class="'+cls(p.realized_usd)+'">'+money(p.realized_usd)+'</td>'
    +'<td>'+money(p.cycle_usd)+'</td>'
    +'<td>'+num(p.planned_cycles)+'</td></tr>'
    +'<tr class=detail id="det_o'+id+'" style="display:none"><td colspan=13></td></tr>';
}
function closedRow(p){
  const id=p.id;
  return '<tr class=head onclick="toggle(\\'c\\','+id+')"><td><span class=arrow id="arr_c'+id+'">▸</span></td>'
    +'<td>'+esc(p.symbol||p.mint.slice(0,6))+'</td>'
    +'<td class=mut>'+esc(p.close_reason||'')+'</td>'
    +'<td class="'+cls(p.realized_usd)+'">'+money(p.realized_usd)+'</td>'
    +'<td>'+money(p.max_capital_usd)+'</td>'
    +'<td>'+(p.legit_score==null?'—':Math.round(p.legit_score))+'</td>'
    +'<td>'+money(p.cycle_usd)+'</td>'
    +'<td class=mut>'+fmtMsk(p.closed_at)+'</td></tr>'
    +'<tr class=detail id="det_c'+id+'" style="display:none"><td colspan=8></td></tr>';
}

async function refresh(){
  const s=await j('/api/summary');
  if(s){eq.textContent=money(s.equity_usd);rl.textContent=money(s.realized_usd);
    ur.textContent=money(s.unrealized_usd);op.textContent=s.open_positions;
    mc.textContent=money(s.max_capital_usd);
    rl.className=cls(s.realized_usd);ur.className=cls(s.unrealized_usd);
    ts.textContent='обновлено '+new Intl.DateTimeFormat('ru-RU',MSK).format(new Date())+' МСК';}
  const o=await j('/api/positions?status=open');
  if(o){const open=document.querySelector('#open tbody');
    open.innerHTML=o.map(openRow).join('')||'<tr><td colspan=13 class=mut>нет открытых позиций</td></tr>';
    for(const p of o){ if(expanded['o'+p.id]){const d=document.getElementById('det_o'+p.id);
      if(d){d.style.display='table-row';loadDetail('o',p.id,d);} const a=document.getElementById('arr_o'+p.id);if(a)a.textContent='▾';}}}
  const c=await j('/api/positions?status=closed');
  if(c){const closed=document.querySelector('#closed tbody');
    closed.innerHTML=c.map(closedRow).join('')||'<tr><td colspan=8 class=mut>пока нет</td></tr>';
    for(const p of c){ if(expanded['c'+p.id]){const d=document.getElementById('det_c'+p.id);
      if(d){d.style.display='table-row';loadDetail('c',p.id,d);} const a=document.getElementById('arr_c'+p.id);if(a)a.textContent='▾';}}}
}
refresh();setInterval(refresh,5000);
</script>
</body></html>`;

type PosRow = Record<string, unknown> & { mint: string; qty_token: number; cost_usd: number; state: string };

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
        ORDER BY COALESCE(closed_at, updated_at) DESC LIMIT 100`;
    }
    const rows = (await pgSql`
      SELECT * FROM dcabot_positions WHERE state IN ('scoring','armed','managing','closing')
      ORDER BY created_at ASC LIMIT 100`) as unknown as PosRow[];
    // enrich holding positions with a live price + unrealized PnL for the table
    await Promise.all(
      rows.map(async (r) => {
        if ((r.state === 'managing' || r.state === 'closing') && Number(r.qty_token) > 0) {
          const price = await getPriceUsd(String(r.mint)).catch(() => 0);
          (r as Record<string, unknown>).cur_price = price;
          (r as Record<string, unknown>).unrealized_usd = price > 0 ? Number(r.qty_token) * price - Number(r.cost_usd) : null;
        } else {
          (r as Record<string, unknown>).cur_price = null;
          (r as Record<string, unknown>).unrealized_usd = null;
        }
      }),
    );
    return rows;
  });

  app.get('/api/position', async (req) => {
    const id = Number((req.query as { id?: string })?.id || 0);
    if (!id) return { position: null, fills: [], score: null };
    const posRows = await pgSql`SELECT * FROM dcabot_positions WHERE id = ${id} LIMIT 1`;
    const position = (posRows[0] as Record<string, unknown>) || null;
    if (!position) return { position: null, fills: [], score: null };
    const fills = await pgSql`SELECT * FROM dcabot_fills WHERE position_id = ${id} ORDER BY ts ASC, id ASC`;
    const scoreRows = await pgSql`SELECT * FROM dcabot_token_score WHERE mint = ${String(position.mint)} LIMIT 1`;
    let currentPrice: number | null = null;
    let unrealized: number | null = null;
    const st = String(position.state);
    if ((st === 'managing' || st === 'closing') && Number(position.qty_token) > 0) {
      currentPrice = await getPriceUsd(String(position.mint)).catch(() => 0);
      unrealized = currentPrice && currentPrice > 0 ? Number(position.qty_token) * currentPrice - Number(position.cost_usd) : null;
    }
    return { position, fills, score: scoreRows[0] || null, current_price: currentPrice, unrealized_usd: unrealized };
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
