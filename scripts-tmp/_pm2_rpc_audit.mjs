#!/usr/bin/env node
/** One-shot PM2 RPC env audit (redacts keys). Run on VPS: node scripts-tmp/_pm2_rpc_audit.mjs */
import { execSync } from 'node:child_process';

const RPC_KEYS = [
  'SA_RPC_HTTP_URL',
  'LIVE_RPC_HTTP_URL',
  'COPY_TRADER_RPC_URL',
  'SOLANA_RPC_HTTP_URL',
  'QUICKNODE_HTTP_URL',
  'HELIUS_RPC_URL',
  'ALCHEMY_HTTP_URL',
  'SOLANA_RPC_HELIUS_PREFER',
  'SOLANA_RPC_HELIUS_FALLBACK_ENABLED',
];

function redact(u) {
  if (!u) return '';
  return String(u)
    .replace(/\/\/[^/@]+@/g, '//***@')
    .replace(/api-key=[^&]+/gi, 'api-key=***')
    .replace(/\/v2\/[A-Za-z0-9_-]+/g, '/v2/***');
}

function hostHint(u) {
  if (!u) return '';
  if (/alchemy/i.test(u)) return 'alchemy';
  if (/helius/i.test(u)) return 'helius';
  if (/quicknode|quiknode|dawn-cosmological/i.test(u)) return 'quicknode';
  return 'other';
}

const raw = execSync('pm2 jlist', { encoding: 'utf8' });
const ps = JSON.parse(raw);
for (const p of ps) {
  const e = p.pm2_env?.env ?? {};
  const row = {
    name: p.name,
    status: p.pm2_env?.status,
    restarts: p.pm2_env?.restart_time ?? 0,
  };
  for (const k of RPC_KEYS) {
    if (e[k]) row[k] = redact(String(e[k]));
  }
  const primary = e.COPY_TRADER_RPC_URL || e.LIVE_RPC_HTTP_URL || e.SA_RPC_HTTP_URL || e.SOLANA_RPC_HTTP_URL || '';
  row.rpc_host = hostHint(primary);
  console.log(JSON.stringify(row));
}
