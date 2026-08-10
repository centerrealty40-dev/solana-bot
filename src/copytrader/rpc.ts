import { creditsPerStandardSolanaRpc, recordSolanaRpcCredits } from '../core/rpc/solana-rpc-meter.js';

type JsonRpcResponse<T> = {
  result?: T;
  error?: { code?: number; message?: string };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type SignatureRow = {
  signature: string;
  blockTime?: number;
  err?: unknown;
  /** Set by ingest path: poll backup vs Helius stream. */
  ingressSource?: 'poll' | 'stream';
};

/** Hard capacity / plan exhaustion — retrying only burns remaining credits. */
export function isRpcCapacityError(status: number, message?: string): boolean {
  const msg = String(message || '').toLowerCase();
  if (msg.includes('max usage') || msg.includes('capacity limit') || msg.includes('monthly capacity')) {
    return true;
  }
  if (status === 429 && (msg.includes('capacity') || msg.includes('max usage') || msg.includes('credit'))) {
    return true;
  }
  return false;
}

export async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  retries = 5,
): Promise<T | null> {
  let wait = 600;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = (await res.json()) as JsonRpcResponse<T>;
      const errMsg = body.error?.message;
      if (isRpcCapacityError(res.status, errMsg) || (typeof errMsg === 'string' && /max usage/i.test(errMsg))) {
        return null;
      }
      if (res.status === 429 || body.error?.code === 429 || body.error?.code === -32005) {
        await sleep(wait);
        wait = Math.min(wait * 2, 8000);
        continue;
      }
      if (!res.ok || body.error) return null;
      void recordSolanaRpcCredits(creditsPerStandardSolanaRpc());
      return body.result ?? null;
    } catch {
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
  return null;
}

export type WalletSignaturesResult = {
  rows: SignatureRow[];
  /** True when RPC failed after retries (distinct from an empty wallet history). */
  rpcFailed: boolean;
};

export async function fetchWalletSignatures(
  rpcUrl: string,
  wallet: string,
  limit: number,
): Promise<WalletSignaturesResult> {
  const raw = await rpcCall<SignatureRow[]>(
    rpcUrl,
    'getSignaturesForAddress',
    [wallet, { limit }],
    5,
  );
  if (raw === null) return { rows: [], rpcFailed: true };
  const rows = raw.filter((r) => r && typeof r.signature === 'string' && !r.err);
  return { rows, rpcFailed: false };
}

export async function fetchParsedTransaction(rpcUrl: string, signature: string): Promise<unknown | null> {
  return rpcCall(
    rpcUrl,
    'getTransaction',
    [
      signature,
      {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      },
    ],
    6,
  );
}

export async function fetchWalletMintBalanceRaw(
  rpcUrl: string,
  wallet: string,
  mint: string,
): Promise<bigint> {
  const rows = await rpcCall<{ value?: unknown[] }>(
    rpcUrl,
    'getTokenAccountsByOwner',
    [wallet, { mint }, { encoding: 'jsonParsed' }],
    5,
  );
  const value = rows?.value ?? [];
  let total = 0n;
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const account = (row as { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } })
      .account;
    const amt = account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amt === 'string' && /^\d+$/.test(amt)) total += BigInt(amt);
  }
  return total;
}
