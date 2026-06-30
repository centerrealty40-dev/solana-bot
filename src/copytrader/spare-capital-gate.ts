/**
 * Copy-trader spare-capital gate: only mirror leader when SOL free above live-oscar reserve + open needs.
 */
import path from 'node:path';
import { readLiveOpenSnapshot } from '../live/open-snapshot.js';
import { restoreOpenTradeFromJson } from '../papertrader/executor/store-restore.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { lamportsFromGetBalanceResult, qnCall } from '../core/rpc/qn-client.js';
import type { CopyTraderConfig } from './config.js';
import { executionWalletPubkey } from './position-reconcile.js';

export type SpareCapitalVerdict =
  | { ok: true; spareUsd: number }
  | { ok: false; reason: string; spareUsd: number; requiredUsd: number };

function envNum(name: string, def: number): number {
  const s = process.env[name]?.trim();
  if (!s) return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return def;
}

function oscarOpenSnapshotPath(): string {
  const p = process.env.LIVE_OPEN_SNAPSHOT_PATH?.trim();
  if (p) return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const trades =
    process.env.LIVE_TRADES_PATH?.trim() ||
    path.join('data', 'live', 'pt1-oscar-live.jsonl');
  const absTrades = path.isAbsolute(trades) ? trades : path.resolve(process.cwd(), trades);
  return path.resolve(path.dirname(absTrades), 'live-oscar-open-snapshot.json');
}

/** Sum USD still deployed in live-oscar open positions (excludes copy-trader state). */
export function oscarOpenCommittedUsd(snapshotPath?: string): number {
  const snap = readLiveOpenSnapshot(snapshotPath ?? oscarOpenSnapshotPath());
  if (!snap) return 0;
  let total = 0;
  for (const row of snap.positions) {
    const ot = restoreOpenTradeFromJson(row.openTrade as Parameters<typeof restoreOpenTradeFromJson>[0]);
    if (!ot) continue;
    const frac = ot.remainingFraction > 0 ? ot.remainingFraction : 1;
    total += ot.totalInvestedUsd * frac;
  }
  return Math.round(total * 100) / 100;
}

function oscarReserveUsd(): number {
  const entryNotional = envNum('LIVE_ENTRY_NOTIONAL_USD', envNum('LIVE_MAX_POSITION_USD', 300));
  const minFreeMult = envNum('LIVE_ENTRY_MIN_FREE_MULT', 2);
  const minEquity = envNum('LIVE_MIN_WALLET_SOL_EQUITY_USD', 0);
  return Math.max(minEquity, entryNotional * minFreeMult);
}

async function walletFreeSolUsd(cfg: CopyTraderConfig): Promise<number | null> {
  const pk = executionWalletPubkey(cfg);
  const rpc = cfg.rpcUrl?.trim();
  if (!pk || !rpc) return null;
  const res = await qnCall<unknown>('getBalance', [pk, { commitment: 'processed' }], {
    feature: 'sim',
    creditsPerCall: 25,
    timeoutMs: 12_000,
    httpUrl: rpc,
  });
  if (!res.ok) return null;
  const lamports = lamportsFromGetBalanceResult(res.value);
  if (lamports === null) return null;
  const buf = BigInt(Math.max(0, Math.floor(envNum('LIVE_FREE_SOL_BUFFER_LAMPORTS', 50_000_000))));
  const avail = lamports > buf ? lamports - buf : 0n;
  const solUsd = getSolUsd();
  if (!(solUsd > 0)) return null;
  return (Number(avail) / 1e9) * solUsd;
}

/**
 * Returns whether copy buy `buyUsd` may proceed without starving live-oscar capital.
 */
export async function checkCopySpareCapitalGate(
  cfg: CopyTraderConfig,
  buyUsd: number,
): Promise<SpareCapitalVerdict> {
  if (!cfg.spareCapitalGateEnabled) {
    return { ok: true, spareUsd: Number.POSITIVE_INFINITY };
  }
  if (!(buyUsd > 0)) {
    return { ok: false, reason: 'invalid_buy_usd', spareUsd: 0, requiredUsd: buyUsd };
  }

  const freeUsd = await walletFreeSolUsd(cfg);
  if (freeUsd === null) {
    return { ok: false, reason: 'wallet_balance_rpc', spareUsd: 0, requiredUsd: buyUsd };
  }

  const committed = oscarOpenCommittedUsd();
  const reserve = oscarReserveUsd();
  const oscarNeeds = committed + reserve;
  const spareUsd = Math.round((freeUsd - oscarNeeds) * 100) / 100;

  if (spareUsd >= buyUsd) {
    return { ok: true, spareUsd };
  }

  return {
    ok: false,
    reason: 'insufficient_spare_capital',
    spareUsd,
    requiredUsd: buyUsd,
  };
}

export function spareCapitalGateEnabledFromEnv(): boolean {
  return envBool(process.env.COPY_TRADER_SPARE_CAPITAL_GATE, false);
}
