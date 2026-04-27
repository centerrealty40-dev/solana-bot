import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { heliusFetch, HeliusGuardError } from '../core/helius-guard.js';
import { QUOTE_MINTS } from '../core/constants.js';
import type { HeliusEnhancedTx, HeliusTokenTransfer } from './normalizer.js';

const log = child('wallet-transfers');

const HELIUS_API = 'https://api.helius.xyz';

/**
 * One observed value-transfer leg involving the wallet of interest.
 *
 * Direction:
 *   - 'out' = wallet SENT value (we use this to find recipients = rotation candidates)
 *   - 'in'  = wallet RECEIVED value (we use this to find funders = parent operator)
 */
export interface TransferEvent {
  /** the wallet whose history we paginated */
  wallet: string;
  /** counterparty (recipient if out, sender if in) */
  counterparty: string;
  /** 'out' | 'in' direction relative to `wallet` */
  direction: 'in' | 'out';
  /** native SOL amount transferred (always populated; equivalent computed for USDC/USDT) */
  amountSol: number;
  /** USD-equivalent amount; native SOL converted via solPriceUsd */
  amountUsd: number;
  /** original mint that was transferred (SOL, USDC, or USDT only — others ignored) */
  mint: string;
  /** unix epoch seconds */
  ts: number;
  /** tx signature for traceability */
  signature: string;
}

const ROTATION_QUOTES: ReadonlySet<string> = new Set([
  QUOTE_MINTS.SOL,
  QUOTE_MINTS.USDC,
  QUOTE_MINTS.USDT,
]);

/**
 * Pull recent TRANSFER-type enhanced transactions for a wallet and reduce
 * them to per-leg TransferEvent rows.
 *
 * Cost: ~100 credits per page of up to 100 transactions.
 *
 * @param wallet  wallet address to scan
 * @param pages   pages of 100 (default 2 = up to 200 transfers)
 * @param solPriceUsd current SOL price in USD (provide once)
 * @param opts    { direction?: 'in' | 'out' | 'both', minAmountSol?: number }
 */
export async function getWalletTransfers(
  wallet: string,
  pages = 2,
  solPriceUsd = 0,
  opts: { direction?: 'in' | 'out' | 'both'; minAmountSol?: number } = {},
): Promise<TransferEvent[]> {
  if (config.heliusMode === 'off') {
    log.debug({ wallet }, 'HELIUS_MODE=off; returning empty');
    return [];
  }

  const direction = opts.direction ?? 'out';
  const minAmountSol = opts.minAmountSol ?? 0;
  const out: TransferEvent[] = [];
  let before: string | undefined;

  for (let p = 0; p < pages; p++) {
    const url =
      `${HELIUS_API}/v0/addresses/${wallet}/transactions` +
      `?api-key=${config.heliusApiKey}&type=TRANSFER&limit=100` +
      (before ? `&before=${before}` : '');

    let txs: HeliusEnhancedTx[] = [];
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await heliusFetch({
          url,
          kind: 'wallet_history',
          note: `transfers:${wallet.slice(0, 6)} p${p}${attempt > 0 ? ` retry${attempt}` : ''}`,
        });
        lastStatus = res.statusCode;
        if (res.statusCode === 200) {
          txs = (await res.body.json()) as HeliusEnhancedTx[];
          break;
        }
        if (res.statusCode >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      } catch (err) {
        if (err instanceof HeliusGuardError) {
          log.warn({ wallet, reason: err.reason }, `guard blocked transfers: ${err.message}`);
          return out;
        }
        log.warn({ err: String(err), wallet, attempt }, 'helius transfers fetch failed');
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    if (txs.length === 0 && lastStatus !== 200) {
      log.warn({ wallet, status: lastStatus, page: p }, 'helius transfers gave up after retries');
      break;
    }
    if (txs.length === 0) break;

    for (const tx of txs) {
      const events = parseTransferEvents(tx, wallet, solPriceUsd, direction, minAmountSol);
      out.push(...events);
    }

    before = txs[txs.length - 1]?.signature;
    if (!before) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  return out;
}

/**
 * Reduce one Helius enhanced TRANSFER tx to TransferEvent rows.
 *
 * We consider:
 *   - Native SOL transfers (via accountData.nativeBalanceChange) — most common signal
 *   - SPL token transfers in USDC/USDT (other tokens ignored — they're rarely
 *     a "funding" event; tokens are TRADED, not TRANSFERRED for capital deployment)
 *
 * We deduplicate at the (counterparty, mint) level inside one tx so that a
 * complex multi-instruction transfer doesn't produce 5 rows.
 */
function parseTransferEvents(
  tx: HeliusEnhancedTx,
  wallet: string,
  solPriceUsd: number,
  direction: 'in' | 'out' | 'both',
  minAmountSol: number,
): TransferEvent[] {
  const out: TransferEvent[] = [];
  const seen = new Set<string>();

  // SPL token side: filter to ROTATION_QUOTES only.
  const tts = (tx.tokenTransfers ?? []).filter((t) => ROTATION_QUOTES.has(t.mint));
  for (const t of tts) {
    const ev = parseTokenTransferLeg(t, wallet, solPriceUsd, tx.timestamp, tx.signature);
    if (!ev) continue;
    if (direction !== 'both' && ev.direction !== direction) continue;
    if (ev.amountSol < minAmountSol) continue;
    const key = `${ev.direction}:${ev.mint}:${ev.counterparty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }

  // Native SOL side: read accountData[].nativeBalanceChange for `wallet` as the
  // amount sent/received, and find the counterparty by inspecting the *other*
  // account with an opposite-sign change. Helius gives lamports directly.
  const data = tx.accountData ?? [];
  const ourLeg = data.find((d) => d.account === wallet);
  if (ourLeg && Math.abs(ourLeg.nativeBalanceChange) > 0) {
    const lamports = ourLeg.nativeBalanceChange;
    // Negative = sent, positive = received. Note this includes fees, so for
    // tiny outflows ~5000 lamports we'd see noise — `minAmountSol` filters it.
    const dir: 'in' | 'out' = lamports < 0 ? 'out' : 'in';
    const amountSol = Math.abs(lamports) / 1e9;
    if ((direction === 'both' || direction === dir) && amountSol >= minAmountSol) {
      // Counterparty: largest opposite-sign change (excluding ourselves).
      const candidates = data
        .filter((d) => d.account !== wallet)
        .map((d) => ({
          account: d.account,
          delta: d.nativeBalanceChange,
        }))
        .filter((c) => (dir === 'out' ? c.delta > 0 : c.delta < 0));
      if (candidates.length > 0) {
        candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        const cp = candidates[0]!;
        const key = `${dir}:${QUOTE_MINTS.SOL}:${cp.account}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            wallet,
            counterparty: cp.account,
            direction: dir,
            amountSol,
            amountUsd: amountSol * solPriceUsd,
            mint: QUOTE_MINTS.SOL,
            ts: tx.timestamp,
            signature: tx.signature,
          });
        }
      }
    }
  }

  return out;
}

function parseTokenTransferLeg(
  t: HeliusTokenTransfer,
  wallet: string,
  solPriceUsd: number,
  ts: number,
  signature: string,
): TransferEvent | null {
  if (!t.fromUserAccount || !t.toUserAccount) return null;
  if (t.tokenAmount <= 0) return null;

  let direction: 'in' | 'out' | null = null;
  let counterparty: string | null = null;
  if (t.fromUserAccount === wallet) {
    direction = 'out';
    counterparty = t.toUserAccount;
  } else if (t.toUserAccount === wallet) {
    direction = 'in';
    counterparty = t.fromUserAccount;
  } else {
    return null;
  }

  // For USDC/USDT, amount is already a human number; treat 1:1 USD.
  // For SOL token leg (rare in TRANSFER endpoint, usually goes through accountData),
  // tokenAmount is human SOL.
  let amountUsd: number;
  let amountSol: number;
  if (t.mint === QUOTE_MINTS.USDC || t.mint === QUOTE_MINTS.USDT) {
    amountUsd = t.tokenAmount;
    amountSol = solPriceUsd > 0 ? t.tokenAmount / solPriceUsd : 0;
  } else if (t.mint === QUOTE_MINTS.SOL) {
    amountSol = t.tokenAmount;
    amountUsd = t.tokenAmount * solPriceUsd;
  } else {
    return null;
  }

  return {
    wallet,
    counterparty,
    direction,
    amountSol,
    amountUsd,
    mint: t.mint,
    ts,
    signature,
  };
}
