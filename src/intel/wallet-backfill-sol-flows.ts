/**
 * W6.12 S02 — извлечение нативных SOL transfers из jsonParsed tx для `money_flows`.
 */
import type { TxJsonParsed } from '../parser/rpc-http.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

type ParsedIx = {
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
};

function collectInstructions(tx: TxJsonParsed): ParsedIx[] {
  const msg = tx.transaction?.message as Record<string, unknown> | undefined;
  const top = (msg?.instructions ?? []) as unknown[];
  const out: ParsedIx[] = [];
  for (const ix of top) {
    if (ix && typeof ix === 'object') out.push(ix as ParsedIx);
  }
  const meta = tx.meta as Record<string, unknown> | null | undefined;
  const inner = meta?.innerInstructions;
  if (!Array.isArray(inner)) return out;
  for (const block of inner) {
    const list = (block as { instructions?: unknown }).instructions;
    if (!Array.isArray(list)) continue;
    for (const ix of list) {
      if (ix && typeof ix === 'object') out.push(ix as ParsedIx);
    }
  }
  return out;
}

export type SolTransferLeg = {
  sourceWallet: string;
  targetWallet: string;
  amount: number;
};

/**
 * Лампорты → SOL float (грубое деление на 1e9; для scam-farm sync_fund достаточно).
 */
export function extractNativeSolTransfers(tx: TxJsonParsed | null | undefined): SolTransferLeg[] {
  if (!tx?.meta || tx.meta.err != null) return [];
  const sig = tx.transaction?.signatures?.[0];
  if (typeof sig !== 'string') return [];

  const legs: SolTransferLeg[] = [];
  const seen = new Set<string>();

  for (const ix of collectInstructions(tx)) {
    const pid = ix.programId;
    if (pid !== SYSTEM_PROGRAM) continue;
    const t = ix.parsed?.type;
    if (t !== 'transfer') continue;
    const info = ix.parsed?.info;
    if (!info || typeof info !== 'object') continue;
    const src = info.source;
    const dst = info.destination;
    const lam = info.lamports;
    if (typeof src !== 'string' || typeof dst !== 'string') continue;
    if (src === dst) continue;
    let lamports = 0;
    if (typeof lam === 'number' && Number.isFinite(lam)) lamports = lam;
    else if (typeof lam === 'string' && /^\d+$/.test(lam)) lamports = Number(lam);
    if (lamports <= 0) continue;
    const amount = lamports / 1e9;
    const key = `${src}|${dst}|${lamports}`;
    if (seen.has(key)) continue;
    seen.add(key);
    legs.push({ sourceWallet: src, targetWallet: dst, amount });
  }

  return legs;
}
