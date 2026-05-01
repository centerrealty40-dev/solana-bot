/**
 * W7.2 — Pre-entry safety check.
 *
 * Single batched QuickNode RPC (~60 credits, feature `safety`): mint info +
 * largest accounts. Fail-open when QN errors or budget blocks.
 */
import { qnBatchCall } from '../../core/rpc/qn-client.js';
import { child } from '../../core/logger.js';
import type { SafetyVerdict } from '../types.js';

const log = child('papertrader-safety');

type MintParsedInfo = {
  decimals: number;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  supply: string;
};

type AccountInfoResult = {
  value: {
    data: {
      parsed: {
        info: MintParsedInfo;
      };
    };
  } | null;
};

type LargestAccountsResult = {
  value: Array<{ address: string; amount: string; uiAmount?: number }>;
};

function topHolderPct(rows: Array<{ amount?: string }>, totalSupply: string): number | null {
  if (!rows.length || !totalSupply) return null;
  try {
    const total = BigInt(totalSupply);
    const top = BigInt(String(rows[0]?.amount ?? '0'));
    if (total <= 0n || top <= 0n) return null;
    return Number((top * 10000n) / total) / 100;
  } catch {
    return null;
  }
}

export type SafetyOptions = {
  topHolderMaxPct: number;
  requireMintAuthorityNull: boolean;
  requireFreezeAuthorityNull: boolean;
  /** AMM mints: pool vault often top-1 — skip concentration check. */
  treatAsAmm: boolean;
  timeoutMs: number;
};

export type SafetyOutcome =
  | { kind: 'verdict'; verdict: SafetyVerdict }
  | { kind: 'skipped'; reason: string };

function fmtPk(pk: string | null): string {
  if (pk == null || pk === '') return '';
  const s = String(pk);
  return s.length > 8 ? `${s.slice(0, 8)}…` : s;
}

export async function evaluateMintSafety(mint: string, opts: SafetyOptions): Promise<SafetyOutcome> {
  const res = await qnBatchCall<AccountInfoResult | LargestAccountsResult>(
    [
      { method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] },
      { method: 'getTokenLargestAccounts', params: [mint] },
    ],
    { feature: 'safety', creditsPerCall: 30, timeoutMs: opts.timeoutMs },
  );
  if (!res.ok) {
    log.debug({ mint, reason: res.reason }, 'safety: qn batch failed, fail-open skip');
    return { kind: 'skipped', reason: res.reason };
  }
  const [acc, largestWrap] = res.value;
  const info = (acc as AccountInfoResult | null)?.value?.data?.parsed?.info;
  if (!info) {
    return { kind: 'skipped', reason: 'mint_account_missing' };
  }
  const mintAuthority = info.mintAuthority ?? null;
  const freezeAuthority = info.freezeAuthority ?? null;
  const decimals = Number(info.decimals);
  const supply = String(info.supply);
  const rows = (largestWrap as LargestAccountsResult)?.value || [];
  const tHolder = opts.treatAsAmm ? null : topHolderPct(rows, supply);
  const reasons: string[] = [];
  if (opts.requireMintAuthorityNull && mintAuthority != null) {
    reasons.push(`mint_authority=${fmtPk(mintAuthority)}`);
  }
  if (opts.requireFreezeAuthorityNull && freezeAuthority != null) {
    reasons.push(`freeze_authority=${fmtPk(freezeAuthority)}`);
  }
  if (!opts.treatAsAmm && tHolder != null && tHolder > opts.topHolderMaxPct) {
    reasons.push(`top1=${tHolder.toFixed(1)}%`);
  }
  const verdict: SafetyVerdict = {
    ok: reasons.length === 0,
    reasons,
    mint_authority: mintAuthority,
    freeze_authority: freezeAuthority,
    top_holder_pct: tHolder,
    decimals: Number.isFinite(decimals) ? decimals : null,
    supply,
    ts: Date.now(),
  };
  return { kind: 'verdict', verdict };
}
