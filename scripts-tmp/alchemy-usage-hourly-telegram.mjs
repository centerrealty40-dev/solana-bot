#!/usr/bin/env node
/**
 * Hourly Alchemy RPC usage ping → operator Telegram.
 *
 * Alchemy has no public REST usage API on free/PAYG tiers (dashboard only).
 * We report internal solana-rpc-meter counters from data/quicknode-usage.json
 * (all qnCall + copy-trader rpc paths) and a getSlot health probe on SA_RPC_HTTP_URL.
 *
 * Env: SA_RPC_HTTP_URL, ALCHEMY_USAGE_INTERVAL_MS (default 3600000),
 *      ALCHEMY_EST_CU_PER_RPC (default 27 — Alchemy avg ~27 CU/request),
 *      ALCHEMY_USAGE_TELEGRAM=0 to disable sends.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { sendTagged } from '../scripts/lib/telegram.mjs';

const ROOT = process.cwd();
const INTERVAL_MS = Math.max(60_000, Number(process.env.ALCHEMY_USAGE_INTERVAL_MS || 3_600_000));
const EST_CU = Math.max(1, Number(process.env.ALCHEMY_EST_CU_PER_RPC || 27));
const CREDITS_PER_RPC = Math.max(1, Number(process.env.QUICKNODE_CREDITS_PER_SOLANA_RPC || 30));
const USAGE_PATH = process.env.QUICKNODE_USAGE_PATH || path.join(ROOT, 'data', 'quicknode-usage.json');
const STATE_PATH = path.join(ROOT, 'data', 'alchemy-usage-watch-state.json');
const TG_ON = process.env.ALCHEMY_USAGE_TELEGRAM !== '0';

function hourKeyUtc(d = new Date()) {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}`;
}

function readUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastReportedHour: '', lastHourCredits: 0 };
  }
}

function writeState(st) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

async function probeSlot(rpcUrl) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error?.message || `HTTP ${res.status}`);
  return body.result;
}

async function tick() {
  const rpcUrl =
    process.env.SA_RPC_HTTP_URL?.trim() ||
    process.env.ALCHEMY_HTTP_URL?.trim() ||
    process.env.SOLANA_RPC_HTTP_URL?.trim() ||
    '';
  const usage = readUsage();
  const hk = hourKeyUtc();
  const hourCredits = typeof usage?.creditsUsedHour === 'number' ? usage.creditsUsedHour : 0;
  const dayCredits = typeof usage?.creditsUsedDay === 'number' ? usage.creditsUsedDay : 0;
  const monthCredits = typeof usage?.creditsUsed === 'number' ? usage.creditsUsed : 0;

  const st = readState();
  let hourDelta = hourCredits;
  if (st.lastReportedHour === hk) {
    hourDelta = Math.max(0, hourCredits - (st.lastHourCredits ?? 0));
  } else if (usage?.hourUtc === hk) {
    hourDelta = hourCredits;
  }

  let slot = null;
  let slotErr = null;
  if (rpcUrl) {
    try {
      slot = await probeSlot(rpcUrl);
    } catch (e) {
      slotErr = String(e?.message || e);
    }
  } else {
    slotErr = 'SA_RPC_HTTP_URL missing';
  }

  const rpcCallsHour = Math.round(hourDelta / CREDITS_PER_RPC);
  const estCuHour = rpcCallsHour * EST_CU;
  const rpcCallsDay = Math.round(dayCredits / CREDITS_PER_RPC);
  const estCuDay = rpcCallsDay * EST_CU;

  const lines = [
    `Alchemy RPC (internal meter, ~${EST_CU} CU/call est.):`,
    `  last hour: ~${rpcCallsHour.toLocaleString('en-US')} calls ≈ ${estCuHour.toLocaleString('en-US')} CU`,
    `  UTC day: ~${rpcCallsDay.toLocaleString('en-US')} calls ≈ ${estCuDay.toLocaleString('en-US')} CU`,
    `  month meter: ${Math.round(monthCredits / CREDITS_PER_RPC).toLocaleString('en-US')} calls (${monthCredits.toLocaleString('en-US')} credits)`,
    slot != null ? `getSlot OK: ${slot}` : `getSlot FAIL: ${slotErr}`,
    'Note: Alchemy dashboard has no public usage REST API; numbers are in-process meter only.',
  ];
  const msg = lines.join('\n');

  console.log(`[alchemy-usage] ${new Date().toISOString()} ${msg.replace(/\n/g, ' | ')}`);

  if (TG_ON) {
    await sendTagged('REPORT', 'alchemy-usage', msg);
  }

  writeState({ lastReportedHour: hk, lastHourCredits: hourCredits, updatedAt: new Date().toISOString() });
}

async function main() {
  console.log(`[alchemy-usage] watch started interval=${INTERVAL_MS}ms usage=${USAGE_PATH}`);
  await tick();
  setInterval(() => {
    tick().catch((e) => console.error('[alchemy-usage] tick error', e));
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error('[alchemy-usage] fatal', e);
  process.exit(1);
});
