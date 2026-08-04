/**
 * Unified PM2 watchdog for live trading bots: status + heartbeat + auto-restart + Telegram.
 *
 * Watches by default: copy-trader-8zkg, copy-trader-8zkg-mirror (Oscar lane off 1.11.660).
 * Override: STRATEGY_PROCESS_WATCH_TARGETS JSON array [{ pm2, heartbeatPath, staleMs?, fatalPath? }]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sendTagged } from '../scripts/lib/telegram.mjs';
import {
  assessLiveOscarProcessSingleton,
  assessProcessHealth,
  defaultFeeSolWatchWallets,
  defaultStrategyWatchTargets,
  evaluateFeeSolLow,
  lamportsFromGetBalanceResult,
  parseFeeSolWatchWalletsJson,
  parseHeartbeatJson,
  parseWatchTargetsJson,
  readExpectedLiveOscarEntrySplitLegUsd,
  rootPm2HasOnlineLiveOscar,
  scanLiveOscarScriptProcesses,
} from './process-watch-lib.mjs';

const ROOT = process.cwd();
const POLL_MS = Number(process.env.STRATEGY_PROCESS_WATCH_POLL_MS || 30_000);
const TELEGRAM_ON = process.env.STRATEGY_PROCESS_WATCH_TELEGRAM !== '0';
const AUTO_RESTART = process.env.STRATEGY_PROCESS_WATCH_AUTO_RESTART !== '0';
const REPEAT_MIN = Number(process.env.STRATEGY_PROCESS_WATCH_ALERT_REPEAT_MIN || 15);
const FEE_SOL_WATCH_ON = process.env.STRATEGY_PROCESS_WATCH_FEE_SOL !== '0';
const FEE_SOL_MIN_USD = Number(process.env.STRATEGY_PROCESS_WATCH_FEE_SOL_MIN_USD || 20);
const FEE_SOL_REPEAT_MIN = Number(
  process.env.STRATEGY_PROCESS_WATCH_FEE_SOL_ALERT_REPEAT_MIN || 60,
);
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STATE_PATH =
  process.env.STRATEGY_PROCESS_WATCH_STATE_PATH ||
  path.join(ROOT, 'data/ops-heartbeats/process-watch-state.json');

function loadTargets() {
  const raw = process.env.STRATEGY_PROCESS_WATCH_TARGETS;
  return parseWatchTargetsJson(raw, ROOT) ?? defaultStrategyWatchTargets(ROOT);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { alerts: {}, fatals: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function getPm2StatusMap() {
  try {
    const out = execSync('pm2 jlist', {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const apps = JSON.parse(out);
    const map = new Map();
    for (const app of apps) map.set(app.name, app?.pm2_env?.status ?? 'unknown');
    return map;
  } catch {
    return new Map();
  }
}

function readHeartbeatAgeMs(heartbeatPath, now) {
  if (!fs.existsSync(heartbeatPath)) return Infinity;
  try {
    const hb = parseHeartbeatJson(fs.readFileSync(heartbeatPath, 'utf8'));
    if (!hb) return Infinity;
    return now - hb.ts;
  } catch {
    return Infinity;
  }
}

function readFatal(fatalPath) {
  if (!fatalPath || !fs.existsSync(fatalPath)) return null;
  try {
    return parseHeartbeatJson(fs.readFileSync(fatalPath, 'utf8'));
  } catch {
    return null;
  }
}

function pm2Restart(pm2Name) {
  execSync(`pm2 restart ${pm2Name}`, { cwd: ROOT, stdio: 'pipe' });
}

function resolveRpcUrl() {
  return (
    process.env.STRATEGY_PROCESS_WATCH_RPC_URL?.trim() ||
    process.env.COPY_TRADER_RPC_URL?.trim() ||
    process.env.LIVE_RPC_HTTP_URL?.trim() ||
    process.env.SA_RPC_HTTP_URL?.trim() ||
    process.env.SOLANA_RPC_HTTP_URL?.trim() ||
    process.env.HELIUS_RPC_URL?.trim() ||
    ''
  );
}

async function rpcJson(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || String(j.error));
  return j.result;
}

async function fetchSolUsdPrice() {
  const url = new URL('https://api.jup.ag/price/v3');
  url.searchParams.set('ids', SOL_MINT);
  const headers = { accept: 'application/json' };
  const key = process.env.JUPITER_API_KEY?.trim() || process.env.JUP_API_KEY?.trim();
  if (key) headers['x-api-key'] = key;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`jup price HTTP ${res.status}`);
  const j = await res.json();
  const px = Number(j?.[SOL_MINT]?.usdPrice ?? j?.data?.[SOL_MINT]?.price ?? 0);
  if (!(px > 20 && px < 5000)) throw new Error(`bad SOL usd price ${px}`);
  return px;
}

function loadFeeSolWallets() {
  return (
    parseFeeSolWatchWalletsJson(process.env.STRATEGY_PROCESS_WATCH_FEE_SOL_WALLETS) ??
    defaultFeeSolWatchWallets()
  );
}

async function tickFeeSolWatch(now, state) {
  if (!FEE_SOL_WATCH_ON || !(FEE_SOL_MIN_USD > 0)) return null;
  const rpcUrl = resolveRpcUrl();
  if (!rpcUrl) {
    console.warn('[strategy-process-watch] fee SOL watch skipped: no RPC URL');
    return null;
  }
  let solUsd;
  try {
    solUsd = await fetchSolUsdPrice();
  } catch (e) {
    console.warn('[strategy-process-watch] fee SOL price failed', String(e?.message || e));
    return null;
  }
  const wallets = loadFeeSolWallets();
  const rows = [];
  for (const w of wallets) {
    try {
      const raw = await rpcJson(rpcUrl, 'getBalance', [w.pubkey, { commitment: 'processed' }]);
      const lamports = lamportsFromGetBalanceResult(raw);
      const solAmount = Number.isFinite(lamports) ? lamports / 1e9 : null;
      const usd = solAmount != null ? solAmount * solUsd : null;
      rows.push({ ...w, solAmount, solUsd: usd });
    } catch (e) {
      console.warn(
        '[strategy-process-watch] fee SOL balance failed',
        w.label,
        String(e?.message || e),
      );
      rows.push({ ...w, solAmount: null, solUsd: null });
    }
  }
  const { low, alertKey, lines } = evaluateFeeSolLow(rows, FEE_SOL_MIN_USD);
  const prev = state.alerts.__fee_sol ?? {};
  if (low.length === 0) {
    if (prev.lastAlertKey) {
      if (TELEGRAM_ON) {
        await sendTagged(
          'ALERT',
          'fee_sol',
          'Fee SOL watch: all watched wallets ≥ $' + FEE_SOL_MIN_USD + ' native SOL',
        );
      }
      state.alerts.__fee_sol = { lastAlertAt: 0, lastAlertKey: '' };
    }
    return { ok: true, rows, solUsd };
  }
  const due =
    now - (prev.lastAlertAt ?? 0) >= FEE_SOL_REPEAT_MIN * 60_000 || prev.lastAlertKey !== alertKey;
  if (due && TELEGRAM_ON) {
    const body = [
      `[ALERT][fee_sol] native SOL for fees < $${FEE_SOL_MIN_USD} (SOL≈$${solUsd.toFixed(2)}):`,
      ...lines,
      'Top up native SOL on these wallets for fees/rent.',
    ].join('\n');
    await sendTagged('ALERT', 'fee_sol', body);
    state.alerts.__fee_sol = { lastAlertAt: now, lastAlertKey: alertKey };
  }
  return { ok: false, rows, solUsd, low };
}

function issueDetail(issue, target, status, heartbeatAgeMs) {
  if (issue.startsWith('pm2_status_')) {
    return `${target.pm2}: PM2 status=${status} (expected online)`;
  }
  if (issue.startsWith('heartbeat_stale_')) {
    const min = Math.round(heartbeatAgeMs / 60_000);
    return `${target.pm2}: heartbeat stale ~${min}m (${target.heartbeatPath})`;
  }
  if (issue.startsWith('live_oscar_')) {
    return `${target.pm2}: ${issue}`;
  }
  if (issue === 'root_pm2_live_oscar_online') {
    return `${target.pm2}: rogue /root/.pm2 still hosts online live-oscar (PM2_HOME=/root/.pm2 pm2 kill)`;
  }
  return `${target.pm2}: ${issue}`;
}

async function tick() {
  const now = Date.now();
  const state = loadState();
  if (!state.alerts) state.alerts = {};
  if (!state.fatals) state.fatals = {};
  const targets = loadTargets();
  const statusMap = getPm2StatusMap();
  const summary = [];

  if (rootPm2HasOnlineLiveOscar(execSync)) {
    const alertKey = 'root_pm2_live_oscar_online';
    const prev = state.alerts.__root_pm2 ?? {};
    const due =
      now - (prev.lastAlertAt ?? 0) >= REPEAT_MIN * 60_000 || prev.lastAlertKey !== alertKey;
    if (due && TELEGRAM_ON) {
      await sendTagged(
        'ALERT',
        'strategy_watch',
        'Strategy watchdog:\n• /root/.pm2 has online live-oscar — kill with: PM2_HOME=/root/.pm2 pm2 kill',
      );
      state.alerts.__root_pm2 = { lastAlertAt: now, lastAlertKey: alertKey };
    }
  }

  for (const target of targets) {
    const status = statusMap.get(target.pm2) ?? 'missing';
    const heartbeatAgeMs = readHeartbeatAgeMs(target.heartbeatPath, now);
    const health = assessProcessHealth({
      status,
      heartbeatAgeMs,
      heartbeatMaxStaleMs: target.staleMs,
    });

    if (target.pm2 === 'live-oscar') {
      const ecoPath = path.join(ROOT, 'ecosystem.config.cjs');
      const expectedLeg = fs.existsSync(ecoPath)
        ? readExpectedLiveOscarEntrySplitLegUsd(fs.readFileSync(ecoPath, 'utf8'))
        : process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD ?? null;
      const singleton = assessLiveOscarProcessSingleton(scanLiveOscarScriptProcesses(execSync), {
        expectedEntrySplitLegUsd: expectedLeg,
      });
      if (!singleton.ok) health.issues.push(...singleton.issues);
      if (rootPm2HasOnlineLiveOscar(execSync)) health.issues.push('root_pm2_live_oscar_online');
    }

    let restarted = false;
    if (!health.ok && AUTO_RESTART) {
      try {
        pm2Restart(target.pm2);
        restarted = true;
      } catch (e) {
        health.issues.push(`restart_failed:${String(e?.message || e).slice(0, 160)}`);
      }
    }

    const fatal = readFatal(target.fatalPath);
    const fatalKey = `${target.pm2}:${fatal?.ts ?? 0}`;
    if (fatal?.ts && state.fatals[fatalKey] !== fatal.ts) {
      const msg = `${target.pm2} last-fatal ${new Date(fatal.ts).toISOString()}\n${fatal.source ?? 'fatal'}: ${fatal.message ?? ''}`;
      if (TELEGRAM_ON) await sendTagged('ALERT', 'strategy_watch', msg);
      state.fatals[fatalKey] = fatal.ts;
    }

    if (!health.ok) {
      const alertKey = health.issues.join('|');
      const prev = state.alerts[target.pm2] ?? {};
      const due =
        now - (prev.lastAlertAt ?? 0) >= REPEAT_MIN * 60_000 || prev.lastAlertKey !== alertKey;
      if (due) {
        const lines = health.issues.map((i) => `• ${issueDetail(i, target, status, heartbeatAgeMs)}`);
        if (restarted) lines.push(`• pm2 restart ${target.pm2} issued`);
        const body = [`Strategy watchdog:`, ...lines].join('\n');
        if (TELEGRAM_ON) await sendTagged('ALERT', 'strategy_watch', body);
        state.alerts[target.pm2] = { lastAlertAt: now, lastAlertKey: alertKey };
      }
    } else if (state.alerts[target.pm2]?.lastAlertKey) {
      if (TELEGRAM_ON) {
        await sendTagged('ALERT', 'strategy_watch', `Strategy watchdog: ${target.pm2} recovered`);
      }
      state.alerts[target.pm2] = { lastAlertAt: 0, lastAlertKey: '' };
    }

    summary.push({
      pm2: target.pm2,
      ok: health.ok,
      status,
      heartbeatAgeSec: Number.isFinite(heartbeatAgeMs) ? Math.round(heartbeatAgeMs / 1000) : null,
      issues: health.issues,
      restarted,
    });
  }

  const feeSol = await tickFeeSolWatch(now, state);

  saveState(state);
  console.log(
    JSON.stringify({
      ok: summary.every((s) => s.ok) && (feeSol?.ok !== false),
      targets: summary,
      feeSol: feeSol
        ? {
            ok: feeSol.ok,
            solUsd: feeSol.solUsd,
            low: (feeSol.low ?? []).map((r) => r.label),
          }
        : null,
      ts: new Date(now).toISOString(),
    }),
  );
}

async function main() {
  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
