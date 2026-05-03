/**
 * Диагностика `wallet_balance_rpc` у Live Oscar:
 * 1) Сырой JSON-RPC getBalance (без локального meter / qnCall).
 * 2) Тот же вызов через qnCall(feature: sim) — как в phase5-gates rpcWalletSolLamports.
 * 3) Снимок локальных лимитов: quicknode-usage.json, qn-feature-usage.json (sim).
 *
 * Запуск на VPS (как у live-oscar, cwd = корень продукта):
 *   cd /opt/solana-alpha && DIAG_DOTENV=.env DIAG_WORKDIR=. sudo -E -u salpha npx tsx scripts/diag-live-wallet-rpc.ts
 *
 * Локально:
 *   npx tsx scripts/diag-live-wallet-rpc.ts
 *
 * Флаги: --no-raw | --no-meter (пропустить шаг).
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadLiveKeypairFromSecretEnv } from '../src/live/wallet.js';
import { lamportsFromGetBalanceResult, qnCall } from '../src/core/rpc/qn-client.js';
import { solanaRpcMeterCounters } from '../src/core/rpc/solana-rpc-meter.js';
import { qnFeatureBudgetMonth, readQnFeatureUsageForSnapshot } from '../src/core/rpc/qn-feature-usage.js';

function loadDotenv(): void {
  const p = process.env.DIAG_DOTENV?.trim();
  if (p) {
    dotenv.config({ path: path.isAbsolute(p) ? p : path.resolve(process.cwd(), p) });
    return;
  }
  for (const cand of ['.env', '.env.local']) {
    const abs = path.resolve(process.cwd(), cand);
    if (fs.existsSync(abs)) dotenv.config({ path: abs });
  }
}

function applyWorkdir(): void {
  const w = process.env.DIAG_WORKDIR?.trim();
  if (w) process.chdir(path.isAbsolute(w) ? w : path.resolve(process.cwd(), w));
}

function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      const tok = parts[parts.length - 1];
      if (tok.length > 16) {
        parts[parts.length - 1] = `${tok.slice(0, 6)}...${tok.slice(-4)}`;
        u.pathname = '/' + parts.join('/');
      }
    }
    return u.toString();
  } catch {
    return url.length > 40 ? `${url.slice(0, 24)}...` : url;
  }
}

function readJsonSafe(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function rawGetBalance(rpcUrl: string, pubkey: string): Promise<void> {
  const body = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'getBalance',
    params: [pubkey, { commitment: 'processed' }],
  };
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 25_000);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    clearTimeout(to);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 800);
    }
    console.log('[raw] HTTP', res.status, res.statusText);
    console.log('[raw] body:', JSON.stringify(parsed, null, 2));
  } catch (e) {
    clearTimeout(to);
    console.log('[raw] fetch_error:', e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  const skipRaw = argv.has('--no-raw');
  const skipMeter = argv.has('--no-meter');

  applyWorkdir();
  loadDotenv();

  const rpcUrl = (process.env.SA_RPC_HTTP_URL || '').trim();
  const liveRpc = (process.env.LIVE_RPC_HTTP_URL || '').trim();
  const secret = process.env.LIVE_WALLET_SECRET?.trim();
  const expectPk = process.env.LIVE_WALLET_PUBKEY?.trim();

  console.log('cwd:', process.cwd());
  console.log('SA_RPC_HTTP_URL:', rpcUrl ? redactRpcUrl(rpcUrl) : '(missing)');
  if (liveRpc) console.log('LIVE_RPC_HTTP_URL:', redactRpcUrl(liveRpc), '(getBalance в коде использует SA_RPC_HTTP_URL)');
  console.log('');

  const usagePath = process.env.QUICKNODE_USAGE_PATH || path.join('data', 'quicknode-usage.json');
  const featPath = process.env.QN_FEATURE_USAGE_PATH || path.join('data', 'qn-feature-usage.json');
  console.log('[files]', usagePath, fs.existsSync(usagePath) ? 'ok' : 'missing');
  console.log('[files]', featPath, fs.existsSync(featPath) ? 'ok' : 'missing');

  const counters = solanaRpcMeterCounters();
  console.log('[meter global]', JSON.stringify(counters, null, 2));

  const featSnap = readQnFeatureUsageForSnapshot();
  const simBudget = qnFeatureBudgetMonth('sim');
  const simUsed = featSnap.perFeature.sim.monthCredits;
  console.log('[meter sim feature]', { monthCredits: simUsed, budgetMonth: simBudget, remaining: simBudget - simUsed });

  const rawUsage = readJsonSafe(usagePath);
  const rawFeat = readJsonSafe(featPath);
  if (rawUsage && typeof rawUsage === 'object') {
    console.log('[quicknode-usage.json head]', JSON.stringify(rawUsage, null, 2).slice(0, 1200));
  }
  if (rawFeat && typeof rawFeat === 'object') {
    const pf = (rawFeat as { perFeature?: { sim?: unknown } }).perFeature;
    console.log('[qn-feature-usage sim]', JSON.stringify(pf?.sim ?? null, null, 2));
  }

  console.log('');
  console.log('QUICKNODE_DAILY_ENFORCE=', process.env.QUICKNODE_DAILY_ENFORCE ?? '(unset→enforce)');
  console.log('QUICKNODE_DAILY_CREDIT_BUDGET=', process.env.QUICKNODE_DAILY_CREDIT_BUDGET ?? '(default 3M)');
  console.log('QUICKNODE_DAILY_ENFORCE_PROVIDER=', process.env.QUICKNODE_DAILY_ENFORCE_PROVIDER ?? '(unset)');
  console.log('QN_FEATURE_BUDGET_SIM=', process.env.QN_FEATURE_BUDGET_SIM ?? '(default from code)');
  console.log('');

  if (!rpcUrl) {
    console.error('SA_RPC_HTTP_URL missing — cannot probe getBalance.');
    process.exitCode = 2;
    return;
  }

  let pubkey = expectPk ?? '';
  if (!pubkey) {
    if (!secret) {
      console.error('Need LIVE_WALLET_PUBKEY or LIVE_WALLET_SECRET for pubkey.');
      process.exitCode = 2;
      return;
    }
    try {
      pubkey = loadLiveKeypairFromSecretEnv(secret).publicKey.toBase58();
    } catch (e) {
      console.error('loadLiveKeypairFromSecretEnv:', (e as Error).message);
      process.exitCode = 2;
      return;
    }
  }

  console.log('pubkey:', pubkey);
  if (expectPk && secret) {
    try {
      const got = loadLiveKeypairFromSecretEnv(secret).publicKey.toBase58();
      if (got !== expectPk) console.warn('WARN: LIVE_WALLET_PUBKEY !== keypair pubkey', { expectPk, got });
    } catch {
      /* */
    }
  }

  const timeoutMs = Number(process.env.LIVE_SIM_TIMEOUT_MS ?? 12000) || 12000;
  const creditsPerCall = Number(process.env.LIVE_SIM_CREDITS_PER_CALL ?? 30) || 30;

  if (!skipRaw) {
    console.log('\n--- Raw JSON-RPC (no qnCall / no local credit reserve) ---\n');
    await rawGetBalance(rpcUrl, pubkey);
  }

  if (!skipMeter) {
    console.log('\n--- qnCall getBalance feature=sim (same as Live Phase 5) ---\n');
    const r = await qnCall<unknown>('getBalance', [pubkey, { commitment: 'processed' }], {
      feature: 'sim',
      creditsPerCall,
      timeoutMs,
    });
    console.log('qnCall result:', JSON.stringify(r, null, 2));
    if (!r.ok) {
      console.log('\n[interpret]');
      switch (r.reason) {
        case 'budget':
          console.log(
            'Локальный meter отказал в резерве кредитов (глобальный дневной/часовой/месячный лимит ИЛИ месячный лимит feature `sim`). См. блоки [meter global] и [meter sim feature] выше.',
          );
          break;
        case 'rate':
          console.log('HTTP 429 от провайдера RPC.');
          break;
        case 'timeout':
          console.log('Таймаут запроса (AbortController / сеть).');
          break;
        case 'rpc_error':
          console.log('JSON-RPC error от ноды:', r.message);
          break;
        case 'http':
          console.log('HTTP ошибка или нет SA_RPC_HTTP_URL:', r.status, r.message?.slice(0, 400));
          break;
        default:
          console.log('Неизвестная причина:', r);
      }
    } else {
      const lam = lamportsFromGetBalanceResult(r.value);
      console.log('parsed lamports:', lam?.toString() ?? '(null)', '→ SOL:', lam != null ? Number(lam) / 1e9 : 'n/a');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
