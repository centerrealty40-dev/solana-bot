type JsonRpcResponse<T> = {
  result?: T;
  error?: { code?: number; message?: string };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type SignatureRow = {
  signature: string;
  blockTime?: number;
  err?: unknown;
};

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
      if (res.status === 429 || body.error?.code === 429 || body.error?.code === -32005) {
        await sleep(wait);
        wait = Math.min(wait * 2, 8000);
        continue;
      }
      if (!res.ok || body.error) return null;
      return body.result ?? null;
    } catch {
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
  return null;
}

export async function fetchWalletSignatures(
  rpcUrl: string,
  wallet: string,
  limit: number,
): Promise<SignatureRow[]> {
  const rows =
    (await rpcCall<SignatureRow[]>(
      rpcUrl,
      'getSignaturesForAddress',
      [wallet, { limit }],
      5,
    )) ?? [];
  return rows.filter((r) => r && typeof r.signature === 'string' && !r.err);
}

export async function fetchParsedTransaction(rpcUrl: string, signature: string): Promise<unknown | null> {
  return rpcCall(
    rpcUrl,
    'getTransaction',
    [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    6,
  );
}
