import { child } from '../core/logger.js';

const log = child('sa-parser-rpc');

export type JsonRpcReq = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
};

export type JsonRpcResp<T = unknown> = {
  jsonrpc?: string;
  id?: number;
  result?: T;
  error?: { code?: number; message?: string };
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hostOnly(httpUrl: string): string {
  try {
    return new URL(httpUrl).host;
  } catch {
    return '?';
  }
}

export async function jsonRpcBatch<T = unknown>(
  rpcHttpUrl: string,
  requests: JsonRpcReq[],
  timeoutMs: number,
): Promise<JsonRpcResp<T>[]> {
  if (requests.length === 0) return [];

  let attempt = 0;
  let backoff = 200;
  const maxRetries = 3;

  while (true) {
    attempt += 1;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(rpcHttpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requests),
        signal: ac.signal,
      });
      clearTimeout(to);

      if (res.status === 429 || res.status >= 500) {
        if (attempt <= maxRetries) {
          await sleep(Math.min(3000, backoff));
          backoff = Math.min(3000, Math.round(backoff * 1.8));
          continue;
        }
        log.warn({ status: res.status, host: hostOnly(rpcHttpUrl) }, 'rpc batch HTTP error');
        return requests.map((r) => ({
          jsonrpc: '2.0',
          id: r.id,
          error: { message: `http ${res.status}` },
        }));
      }

      const body = (await res.json()) as JsonRpcResp<T>[] | JsonRpcResp<T>;
      if (Array.isArray(body)) {
        return body;
      }
      return [body];
    } catch (e) {
      clearTimeout(to);
      if (attempt <= maxRetries) {
        await sleep(Math.min(3000, backoff));
        backoff = Math.min(3000, Math.round(backoff * 1.8));
        continue;
      }
      log.warn({ err: String(e), host: hostOnly(rpcHttpUrl) }, 'rpc batch failed');
      return requests.map((r) => ({
        jsonrpc: '2.0',
        id: r.id,
        error: { message: String(e) },
      }));
    }
  }
}

export type TxJsonParsed = {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown | null;
    logMessages?: string[] | null;
    preTokenBalances?: TokenBal[] | null;
    postTokenBalances?: TokenBal[] | null;
  } | null;
  transaction?: {
    signatures?: string[];
    message?: Record<string, unknown>;
  };
};

export type TokenBal = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    decimals?: number;
    amount?: string;
    uiAmount?: number | null;
  };
};

export async function getTransactionsParsed(
  rpcHttpUrl: string,
  signatures: string[],
  rpcBatch: number,
  rpcTimeoutMs: number,
  maxInflight: number,
): Promise<Map<string, TxJsonParsed | null>> {
  const out = new Map<string, TxJsonParsed | null>();
  if (signatures.length === 0) return out;

  const chunks: string[][] = [];
  for (let i = 0; i < signatures.length; i += rpcBatch) {
    chunks.push(signatures.slice(i, i + rpcBatch));
  }

  let nextId = 1;

  const runChunk = async (sigChunk: string[], idBase: number) => {
    const reqs: JsonRpcReq[] = sigChunk.map((signature, j) => ({
      jsonrpc: '2.0',
      id: idBase + j,
      method: 'getTransaction',
      params: [
        signature,
        {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        },
      ],
    }));

    const resps = await jsonRpcBatch<TxJsonParsed | null>(rpcHttpUrl, reqs, rpcTimeoutMs);
    const byId = new Map<number, JsonRpcResp<TxJsonParsed | null>>();
    for (const r of resps) {
      if (typeof r.id === 'number') byId.set(r.id, r);
    }

    for (let i = 0; i < sigChunk.length; i++) {
      const sig = sigChunk[i]!;
      const resp = byId.get(reqs[i]!.id);
      if (!resp || resp.error) {
        out.set(sig, null);
        continue;
      }
      out.set(sig, resp.result ?? null);
    }
  };

  for (let i = 0; i < chunks.length; i += maxInflight) {
    const slice = chunks.slice(i, i + maxInflight);
    await Promise.all(
      slice.map((sigChunk) => {
        const base = nextId;
        nextId += sigChunk.length;
        return runChunk(sigChunk, base);
      }),
    );
  }

  return out;
}
