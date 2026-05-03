/**
 * Aggregate execution shortfall vs Jupiter quote for confirmed live swaps (journal SSOT).
 *
 * Buy: compares quoted token `outAmount` to wallet token delta (same mint).
 * Sell: compares quoted SOL lamports `outAmount` to native + WSOL proceeds for the wallet.
 *
 * USD uses SOL→USD at report time unless overridden (historical variance caveat).
 */
import fs from 'node:fs';
import { qnCall } from '../core/rpc/qn-client.js';
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';
import { readLiveJournalLinesBounded } from './replay-strategy-journal.js';

type TokenBalRow = {
  accountIndex: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
    uiAmountString?: string;
    uiAmount?: number;
  };
};

function lineMatchesChannel(row: Record<string, unknown>): boolean {
  const ch = row.channel;
  return ch === undefined || ch === null || ch === 'live';
}

function uiStringToRaw(ui: string, decimals: number): bigint {
  const neg = ui.startsWith('-');
  const s = neg ? ui.slice(1) : ui;
  const [intPart, fracPart = ''] = s.split('.');
  const ip = intPart.replace(/^0+/, '') || '0';
  const pad = decimals > 0 ? (fracPart + '0'.repeat(decimals)).slice(0, decimals) : '';
  const fracBig = decimals > 0 ? BigInt(pad.padEnd(decimals, '0')) : 0n;
  let v = BigInt(ip) * 10n ** BigInt(decimals) + fracBig;
  if (neg) v = -v;
  return v;
}

function rawFromRow(r: TokenBalRow): bigint {
  const amt = r.uiTokenAmount?.amount;
  if (typeof amt === 'string' && /^\d+$/.test(amt)) return BigInt(amt);
  const ui = r.uiTokenAmount?.uiAmountString;
  const dec = r.uiTokenAmount?.decimals;
  if (typeof ui === 'string' && typeof dec === 'number' && dec >= 0 && dec <= 24) return uiStringToRaw(ui, dec);
  return 0n;
}

/** Sum (post − pre) raw token amounts for mint + owner across all ATAs in the tx. */
function mintOwnerRawDelta(meta: Record<string, unknown>, mint: string, owner: string): bigint {
  const pre = (meta.preTokenBalances ?? []) as TokenBalRow[];
  const post = (meta.postTokenBalances ?? []) as TokenBalRow[];
  const byIdx = new Map<number, { pre: bigint; post: bigint }>();
  for (const r of pre) {
    if (r.mint !== mint || r.owner !== owner) continue;
    const ix = r.accountIndex;
    const cur = byIdx.get(ix) ?? { pre: 0n, post: 0n };
    cur.pre = rawFromRow(r);
    byIdx.set(ix, cur);
  }
  for (const r of post) {
    if (r.mint !== mint || r.owner !== owner) continue;
    const ix = r.accountIndex;
    const cur = byIdx.get(ix) ?? { pre: 0n, post: 0n };
    cur.post = rawFromRow(r);
    byIdx.set(ix, cur);
  }
  let sum = 0n;
  for (const v of byIdx.values()) sum += v.post - v.pre;
  return sum;
}

function signerIndex(accountKeys: unknown[], wallet: string): number {
  for (let i = 0; i < accountKeys.length; i++) {
    const k = accountKeys[i] as string | { pubkey?: string };
    const pk = typeof k === 'string' ? k : k?.pubkey;
    if (pk === wallet) return i;
  }
  return -1;
}

/** Gross SOL credited by swap path: native Δ + fee + WSOL token Δ (lamports). */
function solProceedsLamports(meta: Record<string, unknown>, walletPk: string, signerIdx: number): bigint {
  const preB = (meta.preBalances ?? []) as number[];
  const postB = (meta.postBalances ?? []) as number[];
  const fee = BigInt(typeof meta.fee === 'number' && meta.fee >= 0 ? meta.fee : 0);
  let native = 0n;
  if (signerIdx >= 0 && signerIdx < preB.length && signerIdx < postB.length) {
    native = BigInt(postB[signerIdx] ?? 0) - BigInt(preB[signerIdx] ?? 0);
  }
  const wsolDelta = mintOwnerRawDelta(meta, WRAPPED_SOL_MINT, walletPk);
  return native + fee + wsolDelta;
}

function qnReadOpts(cfg: LiveOscarConfig) {
  return {
    feature: 'sim' as const,
    creditsPerCall: cfg.liveSimCreditsPerCall,
    timeoutMs: cfg.liveSimTimeoutMs,
    httpUrl: cfg.liveRpcHttpUrl,
  };
}

async function fetchTransactionOk(
  cfg: LiveOscarConfig,
  signature: string,
): Promise<{ meta: Record<string, unknown>; message: Record<string, unknown> } | null> {
  const res = await qnCall<unknown>(
    'getTransaction',
    [
      signature,
      {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
        commitment: cfg.liveConfirmCommitment,
      },
    ],
    qnReadOpts(cfg),
  );
  if (!res.ok) return null;
  const tx = res.value as {
    meta?: Record<string, unknown>;
    transaction?: { message?: Record<string, unknown> };
  } | null;
  if (tx == null || typeof tx !== 'object') return null;
  const err = tx.meta?.err;
  if (err != null && err !== false) return null;
  if (!tx.meta || typeof tx.meta !== 'object') return null;
  const msg = tx.transaction?.message;
  if (!msg || typeof msg !== 'object') return null;
  return { meta: tx.meta, message: msg };
}

function readJournalLines(storePath: string, maxFileBytes: number): { lines: string[]; truncated: boolean } {
  if (!storePath?.trim() || !fs.existsSync(storePath)) return { lines: [], truncated: false };
  const st = fs.statSync(storePath);
  if (st.size <= maxFileBytes) {
    return { lines: fs.readFileSync(storePath, 'utf-8').split('\n').filter((l) => l.trim().length > 0), truncated: false };
  }
  const { lines, truncated } = readLiveJournalLinesBounded(storePath, maxFileBytes);
  return { lines: lines.filter((l) => l.trim().length > 0), truncated };
}

export interface SwapSlipRow {
  intentId: string;
  side: 'buy' | 'sell';
  mint: string;
  signature: string;
  attemptTs: number;
  /** Positive = worse than quote (received less tokens or less SOL). */
  slipOutPctApprox: number | null;
  slipUsdApprox: number | null;
  quoteOutRaw: string | null;
  actualOutRaw: string | null;
  note?: string;
}

export interface LiveSlippageReport {
  walletPk: string;
  journalTruncated: boolean;
  solUsdUsed: number;
  rpcFailures: number;
  legacyMissingQuoteAmounts: number;
  rows: SwapSlipRow[];
  totalSlipUsdApprox: number;
}

export function resolveLiveWalletPk(cfg: LiveOscarConfig): string {
  const exp = cfg.liveWalletPubkeyExpected?.trim();
  if (exp) return exp;
  const sec = cfg.walletSecret?.trim();
  if (!sec) throw new Error('Need LIVE_WALLET_PUBKEY or LIVE_WALLET_SECRET for slippage report');
  return loadLiveKeypairFromSecretEnv(sec).publicKey.toBase58();
}

/** Pair execution_attempt with execution_result per intentId (same scan as repair-missed). */
function pairExecutionRows(
  lines: string[],
  strategyId: string,
): Map<string, { attempt?: Record<string, unknown>; result?: Record<string, unknown> }> {
  const byIntent = new Map<string, { attempt?: Record<string, unknown>; result?: Record<string, unknown> }>();
  for (const ln of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(row.strategyId ?? '') !== strategyId) continue;
    if (!lineMatchesChannel(row)) continue;
    const intentId = row.intentId != null ? String(row.intentId) : '';
    if (!intentId) continue;
    const kind = String(row.kind ?? '');
    const cur = byIntent.get(intentId) ?? {};
    if (kind === 'execution_attempt') {
      cur.attempt = row;
      byIntent.set(intentId, cur);
    } else if (kind === 'execution_result') {
      cur.result = row;
      byIntent.set(intentId, cur);
    }
  }
  return byIntent;
}

export async function aggregateConfirmedSwapSlippage(
  cfg: LiveOscarConfig,
  opts?: { solUsd?: number; maxFileBytesOverride?: number },
): Promise<LiveSlippageReport> {
  const walletPk = resolveLiveWalletPk(cfg);
  const solUsd =
    typeof opts?.solUsd === 'number' && Number.isFinite(opts.solUsd) && opts.solUsd > 0 ? opts.solUsd : 0;

  const maxB = opts?.maxFileBytesOverride ?? cfg.liveReplayMaxFileBytes;
  const { lines, truncated } = readJournalLines(cfg.liveTradesPath, maxB);

  const pairs = pairExecutionRows(lines, cfg.strategyId);
  const rows: SwapSlipRow[] = [];
  let rpcFailures = 0;
  let legacyMissingQuoteAmounts = 0;
  let totalSlipUsd = 0;

  for (const [intentId, pair] of pairs) {
    const att = pair.attempt;
    const res = pair.result;
    if (!att || !res) continue;
    if (String(res.status ?? '') !== 'confirmed') continue;
    const sigRaw = res.txSignature;
    const signature = typeof sigRaw === 'string' && sigRaw.length > 8 ? sigRaw : '';
    if (!signature) continue;

    const side = String(att.side ?? '');
    if (side !== 'buy' && side !== 'sell') continue;

    const mint = String(att.mint ?? '');
    if (!mint) continue;

    const snap =
      att.quoteSnapshot && typeof att.quoteSnapshot === 'object'
        ? (att.quoteSnapshot as Record<string, unknown>)
        : {};

    const qOut = snap.quoteOutAmount;
    const quoteOutStr = typeof qOut === 'string' && /^\d+$/.test(qOut) ? qOut : null;
    const qIn = snap.quoteInAmount;
    const quoteInStr = typeof qIn === 'string' && /^\d+$/.test(qIn) ? qIn : null;

    const attemptTs = typeof att.ts === 'number' && Number.isFinite(att.ts) ? att.ts : 0;

    if (!quoteOutStr) {
      legacyMissingQuoteAmounts += 1;
      const loadedLegacy = await fetchTransactionOk(cfg, signature);
      if (!loadedLegacy) {
        rpcFailures += 1;
        rows.push({
          intentId,
          side,
          mint,
          signature,
          attemptTs,
          slipOutPctApprox: null,
          slipUsdApprox: null,
          quoteOutRaw: null,
          actualOutRaw: null,
          note: 'legacy_journal_missing_quoteOutAmount+rpc_fail',
        });
        continue;
      }
      const keysL = (loadedLegacy.message.accountKeys ?? []) as unknown[];
      const ixL = signerIndex(keysL, walletPk);
      let actualLegacy: string | null = null;
      if (side === 'buy') {
        actualLegacy = mintOwnerRawDelta(loadedLegacy.meta, mint, walletPk).toString();
      } else {
        actualLegacy = solProceedsLamports(loadedLegacy.meta, walletPk, ixL).toString();
      }
      rows.push({
        intentId,
        side,
        mint,
        signature,
        attemptTs,
        slipOutPctApprox: null,
        slipUsdApprox: null,
        quoteOutRaw: null,
        actualOutRaw: actualLegacy,
        note:
          'legacy_journal_missing_quoteOutAmount — slip vs Jupiter quote не восстановить из журнала; новые сделки получат quoteOutAmount в snapshot',
      });
      continue;
    }

    const quoteOutBn = BigInt(quoteOutStr);

    const loaded = await fetchTransactionOk(cfg, signature);
    if (!loaded) {
      rpcFailures += 1;
      rows.push({
        intentId,
        side,
        mint,
        signature,
        attemptTs,
        slipOutPctApprox: null,
        slipUsdApprox: null,
        quoteOutRaw: quoteOutStr,
        actualOutRaw: null,
        note: 'rpc_or_tx_unavailable',
      });
      continue;
    }

    const keys = (loaded.message.accountKeys ?? []) as unknown[];

    if (side === 'buy') {
      const actualBn = mintOwnerRawDelta(loaded.meta, mint, walletPk);
      if (actualBn <= 0n) {
        rows.push({
          intentId,
          side,
          mint,
          signature,
          attemptTs,
          slipOutPctApprox: null,
          slipUsdApprox: null,
          quoteOutRaw: quoteOutStr,
          actualOutRaw: actualBn.toString(),
          note: 'unexpected_nonpositive_token_delta',
        });
        continue;
      }
      const shortfall = quoteOutBn > actualBn ? quoteOutBn - actualBn : 0n;
      const slipPct = quoteOutBn > 0n ? Number(shortfall) / Number(quoteOutBn) * 100 : 0;
      let slipUsd = 0;
      if (shortfall > 0n && quoteInStr && solUsd > 0) {
        const quoteInBn = BigInt(quoteInStr);
        slipUsd = (Number(shortfall) / Number(quoteOutBn)) * (Number(quoteInBn) / 1e9) * solUsd;
      }
      totalSlipUsd += slipUsd;
      rows.push({
        intentId,
        side,
        mint,
        signature,
        attemptTs,
        slipOutPctApprox: slipPct,
        slipUsdApprox: slipUsd > 0 ? slipUsd : null,
        quoteOutRaw: quoteOutStr,
        actualOutRaw: actualBn.toString(),
        note: quoteInStr ? undefined : 'missing_quoteInAmount_usd_skipped',
      });
    } else {
      const ix = signerIndex(keys, walletPk);
      const actualSol = solProceedsLamports(loaded.meta, walletPk, ix);
      const quoteSolBn = quoteOutBn;
      const shortfall = quoteSolBn > actualSol ? quoteSolBn - actualSol : 0n;
      const slipPct = quoteSolBn > 0n ? Number(shortfall) / Number(quoteSolBn) * 100 : 0;
      const slipUsd = shortfall > 0n && solUsd > 0 ? (Number(shortfall) / 1e9) * solUsd : 0;
      totalSlipUsd += slipUsd;
      rows.push({
        intentId,
        side,
        mint,
        signature,
        attemptTs,
        slipOutPctApprox: slipPct,
        slipUsdApprox: slipUsd > 0 ? slipUsd : null,
        quoteOutRaw: quoteOutStr,
        actualOutRaw: actualSol.toString(),
      });
    }
  }

  rows.sort((a, b) => a.attemptTs - b.attemptTs || a.signature.localeCompare(b.signature));

  return {
    walletPk,
    journalTruncated: truncated,
    solUsdUsed: solUsd,
    rpcFailures,
    legacyMissingQuoteAmounts,
    rows,
    totalSlipUsdApprox: totalSlipUsd,
  };
}
