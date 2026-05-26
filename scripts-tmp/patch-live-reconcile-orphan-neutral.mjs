#!/usr/bin/env node
/**
 * One-shot: fix legacy live JSONL rows where RECONCILE_ORPHAN used marketSell=0 and showed -100% PnL.
 * Rewrites closedTrade economics to match tracker neutral orphan accounting (remainder at cost).
 *
 * Usage: node scripts-tmp/patch-live-reconcile-orphan-neutral.mjs <path-to-live.jsonl>
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file?.trim()) {
  console.error('Usage: node patch-live-reconcile-orphan-neutral.mjs <live.jsonl>');
  process.exit(1);
}
const abs = path.resolve(file);
if (!fs.existsSync(abs)) {
  console.error('File not found:', abs);
  process.exit(1);
}

function patchClosedTrade(ct) {
  if (!ct || ct.exitReason !== 'RECONCILE_ORPHAN') return false;
  const invested = Number(ct.totalInvestedUsd ?? 0);
  const rf = Number(ct.remainingFraction ?? 1);
  let partialNet = 0;
  let partialGross = 0;
  if (Array.isArray(ct.partialSells)) {
    for (const p of ct.partialSells) {
      partialNet += Number(p.proceedsUsd ?? 0);
      partialGross += Number(p.grossProceedsUsd ?? 0);
    }
  }
  const avgEntry = Number(ct.avgEntry ?? 0);
  const avgEntryMarket = Number(ct.avgEntryMarket ?? avgEntry);
  const remUsdAtCost = invested * Math.max(0, rf);
  const remUsdAtCostGross =
    avgEntry > 0 && avgEntryMarket > 0 ? remUsdAtCost * (avgEntryMarket / avgEntry) : remUsdAtCost;

  ct.totalProceedsUsd = partialNet + remUsdAtCost;
  ct.grossTotalProceedsUsd = partialGross + remUsdAtCostGross;
  ct.netPnlUsd = ct.totalProceedsUsd - invested;
  ct.grossPnlUsd = ct.grossTotalProceedsUsd - invested;
  ct.pnlPct = invested > 0 ? (ct.netPnlUsd / invested) * 100 : 0;
  ct.grossPnlPct = invested > 0 ? (ct.grossPnlUsd / invested) * 100 : 0;
  ct.effective_exit_price = avgEntry;
  ct.theoretical_exit_price = avgEntryMarket;
  ct.exitMcUsd = 0;

  if (ct.exitContext && typeof ct.exitContext === 'object') {
    ct.exitContext.closePnlPct = +ct.pnlPct.toFixed(2);
  }

  const net = ct.netPnlUsd;
  const gross = ct.grossPnlUsd;
  const nw = 0;
  ct.costs = {
    ...(typeof ct.costs === 'object' && ct.costs !== null ? ct.costs : {}),
    net_pnl_usd: +net.toFixed(4),
    gross_pnl_usd: +gross.toFixed(4),
    network_fee_usd_total: +nw.toFixed(4),
    network_cost_usd: +nw.toFixed(4),
    fee_cost_usd: +(gross - net - nw).toFixed(4),
    slippage_cost_usd: 0,
  };
  return true;
}

const raw = fs.readFileSync(abs, 'utf8');
const bak = `${abs}.bak-reconcile-orphan-${Date.now()}`;
fs.copyFileSync(abs, bak);
console.error('Backup:', bak);

let n = 0;
const out = raw.split('\n').map((ln) => {
  const t = ln.trim();
  if (!t) return ln;
  let o;
  try {
    o = JSON.parse(ln);
  } catch {
    return ln;
  }
  if (o.kind !== 'live_position_close') return ln;
  const ct = o.closedTrade;
  if (!ct || typeof ct !== 'object') return ln;
  if (patchClosedTrade(ct)) {
    n++;
    return JSON.stringify(o);
  }
  return ln;
});

fs.writeFileSync(abs, out.join('\n'), 'utf8');
console.error('Patched RECONCILE_ORPHAN closes:', n, '→', abs);
