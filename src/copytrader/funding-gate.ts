/**
 * Pre-buy funding check for the USDC copy-trader lane.
 *
 * With USDC funding the wallet needs two separate balances: USDC to size the
 * swap, and native SOL for priority fees plus ATA rent. Running out of either
 * turns every mirror attempt into a failed Jupiter round trip, so both are
 * checked before we ask for a quote.
 *
 * SOL-funded lanes keep their existing behavior (spare-capital-gate) and this
 * gate is a no-op for them.
 */
import { lamportsFromGetBalanceResult, qnCall } from '../core/rpc/qn-client.js';
import type { CopyTraderConfig } from './config.js';
import { executionWalletPubkey } from './position-reconcile.js';
import { copyQuoteSpec } from './quote-mint.js';

export type FundingVerdict =
  | { ok: true; quoteUsd: number; feeSol: number }
  | { ok: false; reason: string; quoteUsd: number; feeSol: number; requiredUsd: number };

type Cached = { ts: number; quoteUsd: number; feeSol: number };

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, Cached>();

export function resetCopyFundingCache(): void {
  cache.clear();
}

async function readBalances(
  cfg: CopyTraderConfig,
  quoteMint: string,
  quoteUnit: number,
  nowMs: number,
): Promise<Cached | null> {
  const pk = executionWalletPubkey(cfg);
  const rpc = cfg.rpcUrl?.trim();
  if (!pk || !rpc) return null;

  const hit = cache.get(pk);
  if (hit && nowMs - hit.ts < CACHE_TTL_MS) return hit;

  const [solRes, tokRes] = await Promise.all([
    qnCall<unknown>('getBalance', [pk, { commitment: 'processed' }], {
      feature: 'sim',
      creditsPerCall: 25,
      timeoutMs: 12_000,
      httpUrl: rpc,
    }),
    qnCall<unknown>(
      'getTokenAccountsByOwner',
      [pk, { mint: quoteMint }, { encoding: 'jsonParsed', commitment: 'processed' }],
      { feature: 'sim', creditsPerCall: 25, timeoutMs: 12_000, httpUrl: rpc },
    ),
  ]);

  if (!solRes.ok || !tokRes.ok) return null;
  const lamports = lamportsFromGetBalanceResult(solRes.value);
  if (lamports === null) return null;

  const rows = (tokRes.value as { value?: unknown[] } | null)?.value ?? [];
  let raw = 0n;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const amt = (
      row as {
        account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } };
      }
    ).account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amt === 'string' && /^\d+$/.test(amt)) raw += BigInt(amt);
  }

  const next: Cached = {
    ts: nowMs,
    quoteUsd: Number(raw) / quoteUnit,
    feeSol: Number(lamports) / 1e9,
  };
  cache.set(pk, next);
  return next;
}

/** Verifies USDC covers `buyUsd` and native SOL still covers fees. */
export async function checkCopyFundingGate(
  cfg: CopyTraderConfig,
  buyUsd: number,
  nowMs = Date.now(),
): Promise<FundingVerdict> {
  const spec = copyQuoteSpec(cfg);
  if (spec.usdPegged !== true) return { ok: true, quoteUsd: Number.POSITIVE_INFINITY, feeSol: 0 };
  if (!(buyUsd > 0)) {
    return { ok: false, reason: 'invalid_buy_usd', quoteUsd: 0, feeSol: 0, requiredUsd: buyUsd };
  }

  const bal = await readBalances(cfg, spec.mint, spec.unit, nowMs);
  if (!bal) {
    return { ok: false, reason: 'wallet_balance_rpc', quoteUsd: 0, feeSol: 0, requiredUsd: buyUsd };
  }

  if (bal.feeSol < cfg.minFeeSolReserve) {
    return {
      ok: false,
      reason: `insufficient_fee_sol sol=${bal.feeSol.toFixed(4)}<min=${cfg.minFeeSolReserve}`,
      quoteUsd: bal.quoteUsd,
      feeSol: bal.feeSol,
      requiredUsd: buyUsd,
    };
  }

  if (bal.quoteUsd + 1e-6 < buyUsd) {
    return {
      ok: false,
      reason: 'insufficient_usdc',
      quoteUsd: bal.quoteUsd,
      feeSol: bal.feeSol,
      requiredUsd: buyUsd,
    };
  }

  return { ok: true, quoteUsd: bal.quoteUsd, feeSol: bal.feeSol };
}
