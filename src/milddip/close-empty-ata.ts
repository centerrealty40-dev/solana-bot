/**
 * Reclaim SPL / Token-2022 ATA rent after a full sell leaves amount=0.
 * On $5 clips the ~0.002 SOL rent (~3%+) dominates round-trip drag.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import { rpcCall } from '../copytrader/rpc.js';

export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SPL_TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** Never close quote / native wrap ATAs. */
const PROTECTED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'So11111111111111111111111111111111111111112', // WSOL
]);

const CLOSE_ACCOUNT_IX = 9;
/** Max close ixs per tx (each is tiny; stay well under tx size). */
const MAX_CLOSE_PER_TX = 8;

export type EmptyAtaRow = {
  pubkey: string;
  mint: string;
  programId: string;
  lamports: number;
};

export function buildCloseAccountInstruction(args: {
  tokenAccount: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.tokenAccount, isSigner: false, isWritable: true },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT_IX]),
  });
}

type TokenAccountRpcRow = {
  pubkey: string;
  account: {
    lamports?: number;
    owner?: string;
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: { amount?: string };
        };
      };
    };
  };
};

function parseEmptyRows(value: unknown[]): EmptyAtaRow[] {
  const out: EmptyAtaRow[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const r = row as TokenAccountRpcRow;
    const info = r.account?.data?.parsed?.info;
    const mint = info?.mint;
    const amount = info?.tokenAmount?.amount;
    const programId = r.account?.owner;
    if (!mint || !programId || typeof r.pubkey !== 'string') continue;
    if (PROTECTED_MINTS.has(mint)) continue;
    if (amount !== '0') continue;
    out.push({
      pubkey: r.pubkey,
      mint,
      programId,
      lamports: Number(r.account?.lamports ?? 0),
    });
  }
  return out;
}

export async function listEmptyTokenAccounts(args: {
  rpcUrl: string;
  owner: string;
  /** If set, only this mint; otherwise all empty non-protected ATAs. */
  mint?: string;
}): Promise<EmptyAtaRow[]> {
  const rows: EmptyAtaRow[] = [];

  if (args.mint) {
    const byMint = await rpcCall<{ value?: unknown[] }>(
      args.rpcUrl,
      'getTokenAccountsByOwner',
      [args.owner, { mint: args.mint }, { encoding: 'jsonParsed' }],
      4,
    );
    rows.push(...parseEmptyRows(byMint?.value ?? []));
  } else {
    const classic = await rpcCall<{ value?: unknown[] }>(
      args.rpcUrl,
      'getTokenAccountsByOwner',
      [args.owner, { programId: SPL_TOKEN_PROGRAM_ID.toBase58() }, { encoding: 'jsonParsed' }],
      4,
    );
    rows.push(...parseEmptyRows(classic?.value ?? []));
    const t22 = await rpcCall<{ value?: unknown[] }>(
      args.rpcUrl,
      'getTokenAccountsByOwner',
      [
        args.owner,
        { programId: SPL_TOKEN_2022_PROGRAM_ID.toBase58() },
        { encoding: 'jsonParsed' },
      ],
      4,
    );
    rows.push(...parseEmptyRows(t22?.value ?? []));
  }

  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.pubkey)) return false;
    seen.add(r.pubkey);
    return true;
  });
}

export type CloseEmptyAtaResult = {
  closed: number;
  reclaimedLamports: number;
  signatures: string[];
  errors: string[];
};

async function sendCloseBatch(args: {
  connection: Connection;
  signer: Keypair;
  rows: EmptyAtaRow[];
}): Promise<{ signature?: string; reclaimedLamports: number; error?: string }> {
  const { rows } = args;
  if (rows.length === 0) return { reclaimedLamports: 0 };
  const dest = args.signer.publicKey;
  const tx = new Transaction();
  let reclaimed = 0;
  for (const row of rows) {
    let programId: PublicKey;
    try {
      programId = new PublicKey(row.programId);
    } catch {
      continue;
    }
    if (
      !programId.equals(SPL_TOKEN_PROGRAM_ID) &&
      !programId.equals(SPL_TOKEN_2022_PROGRAM_ID)
    ) {
      continue;
    }
    tx.add(
      buildCloseAccountInstruction({
        tokenAccount: new PublicKey(row.pubkey),
        destination: dest,
        owner: dest,
        programId,
      }),
    );
    reclaimed += row.lamports > 0 ? row.lamports : 0;
  }
  if (tx.instructions.length === 0) return { reclaimedLamports: 0 };
  try {
    const signature = await sendAndConfirmTransaction(args.connection, tx, [args.signer], {
      commitment: 'confirmed',
      maxRetries: 3,
    });
    return { signature, reclaimedLamports: reclaimed };
  } catch (err) {
    return {
      reclaimedLamports: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Close empty ATAs for one mint (post-sell) or all empty junk ATAs (startup sweep).
 */
export async function closeEmptyAtas(args: {
  rpcUrl: string;
  walletSecret: string;
  mint?: string;
}): Promise<CloseEmptyAtaResult> {
  const signer = loadLiveKeypairFromSecretEnv(args.walletSecret);
  const owner = signer.publicKey.toBase58();
  // Brief settle — sell just confirmed; ATA amount may lag one poll.
  await new Promise((r) => setTimeout(r, 400));
  const empty = await listEmptyTokenAccounts({
    rpcUrl: args.rpcUrl,
    owner,
    mint: args.mint,
  });
  if (empty.length === 0) {
    return { closed: 0, reclaimedLamports: 0, signatures: [], errors: [] };
  }

  const connection = new Connection(args.rpcUrl, 'confirmed');
  const signatures: string[] = [];
  const errors: string[] = [];
  let closed = 0;
  let reclaimedLamports = 0;

  for (let i = 0; i < empty.length; i += MAX_CLOSE_PER_TX) {
    const batch = empty.slice(i, i + MAX_CLOSE_PER_TX);
    const sent = await sendCloseBatch({ connection, signer, rows: batch });
    if (sent.signature) {
      signatures.push(sent.signature);
      closed += batch.length;
      reclaimedLamports += sent.reclaimedLamports;
    } else if (sent.error) {
      errors.push(sent.error);
      // Retry one-by-one so one bad account does not block the rest.
      for (const row of batch) {
        const one = await sendCloseBatch({ connection, signer, rows: [row] });
        if (one.signature) {
          signatures.push(one.signature);
          closed += 1;
          reclaimedLamports += one.reclaimedLamports;
        } else if (one.error) {
          errors.push(`${row.pubkey.slice(0, 8)}…: ${one.error}`);
        }
      }
    }
  }

  return { closed, reclaimedLamports, signatures, errors };
}
