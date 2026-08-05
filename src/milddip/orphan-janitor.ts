/**
 * Clear junk/orphan token accounts on the mild-dip wallet:
 * burn remaining raw (owner-initiated SPL burn) then close ATA to reclaim rent.
 *
 * Never touches protected stables/WSOL or mints listed in `protectMints`
 * (current mild-dip open positions, etc.).
 */
import fs from 'node:fs';
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
import {
  SPL_TOKEN_2022_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  buildCloseAccountInstruction,
} from './close-empty-ata.js';

const BURN_IX = 8;

const PROTECTED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  'So11111111111111111111111111111111111111112',
]);

export type OrphanAtaRow = {
  pubkey: string;
  mint: string;
  programId: string;
  amountRaw: string;
  lamports: number;
  decimals: number;
  uiAmount: number | null;
};

export function buildBurnInstruction(args: {
  tokenAccount: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
  amountRaw: bigint;
  programId: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = BURN_IX;
  data.writeBigUInt64LE(args.amountRaw, 1);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.tokenAccount, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
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
          tokenAmount?: { amount?: string; decimals?: number; uiAmount?: number | null };
        };
      };
    };
  };
};

function parseNonZeroRows(value: unknown[], protectMints: Set<string>): OrphanAtaRow[] {
  const out: OrphanAtaRow[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const r = row as TokenAccountRpcRow;
    const info = r.account?.data?.parsed?.info;
    const mint = info?.mint;
    const amount = info?.tokenAmount?.amount;
    const programId = r.account?.owner;
    if (!mint || !programId || typeof r.pubkey !== 'string' || !amount) continue;
    if (PROTECTED_MINTS.has(mint) || protectMints.has(mint)) continue;
    if (amount === '0') continue;
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) continue;
    out.push({
      pubkey: r.pubkey,
      mint,
      programId,
      amountRaw: amount,
      lamports: Number(r.account?.lamports ?? 0),
      decimals: Number(info?.tokenAmount?.decimals ?? 0),
      uiAmount: info?.tokenAmount?.uiAmount ?? null,
    });
  }
  return out;
}

export async function listOrphanTokenAccounts(args: {
  rpcUrl: string;
  owner: string;
  protectMints?: Iterable<string>;
}): Promise<OrphanAtaRow[]> {
  const protect = new Set(args.protectMints ?? []);
  const classic = await rpcCall<{ value?: unknown[] }>(
    args.rpcUrl,
    'getTokenAccountsByOwner',
    [args.owner, { programId: SPL_TOKEN_PROGRAM_ID.toBase58() }, { encoding: 'jsonParsed' }],
    4,
  );
  const t22 = await rpcCall<{ value?: unknown[] }>(
    args.rpcUrl,
    'getTokenAccountsByOwner',
    [args.owner, { programId: SPL_TOKEN_2022_PROGRAM_ID.toBase58() }, { encoding: 'jsonParsed' }],
    4,
  );
  const rows = [
    ...parseNonZeroRows(classic?.value ?? [], protect),
    ...parseNonZeroRows(t22?.value ?? [], protect),
  ];
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.pubkey)) return false;
    seen.add(r.pubkey);
    return true;
  });
}

export type OrphanJanitorResult = {
  candidates: number;
  burnedClosed: number;
  skipped: number;
  reclaimedLamports: number;
  signatures: string[];
  errors: string[];
};

async function burnAndCloseOne(args: {
  connection: Connection;
  signer: Keypair;
  row: OrphanAtaRow;
}): Promise<{ signature?: string; reclaimedLamports: number; error?: string }> {
  let programId: PublicKey;
  try {
    programId = new PublicKey(args.row.programId);
  } catch {
    return { reclaimedLamports: 0, error: 'bad_program' };
  }
  if (!programId.equals(SPL_TOKEN_PROGRAM_ID) && !programId.equals(SPL_TOKEN_2022_PROGRAM_ID)) {
    return { reclaimedLamports: 0, error: 'unsupported_program' };
  }
  const owner = args.signer.publicKey;
  const tx = new Transaction().add(
    buildBurnInstruction({
      tokenAccount: new PublicKey(args.row.pubkey),
      mint: new PublicKey(args.row.mint),
      owner,
      amountRaw: BigInt(args.row.amountRaw),
      programId,
    }),
    buildCloseAccountInstruction({
      tokenAccount: new PublicKey(args.row.pubkey),
      destination: owner,
      owner,
      programId,
    }),
  );
  try {
    const signature = await sendAndConfirmTransaction(args.connection, tx, [args.signer], {
      commitment: 'confirmed',
      maxRetries: 3,
    });
    return { signature, reclaimedLamports: args.row.lamports };
  } catch (err) {
    return {
      reclaimedLamports: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runOrphanJanitor(args: {
  rpcUrl: string;
  walletSecret: string;
  protectMints?: Iterable<string>;
  /** If false, only list candidates. */
  execute?: boolean;
  limit?: number;
}): Promise<OrphanJanitorResult> {
  const signer = loadLiveKeypairFromSecretEnv(args.walletSecret);
  const owner = signer.publicKey.toBase58();
  let rows = await listOrphanTokenAccounts({
    rpcUrl: args.rpcUrl,
    owner,
    protectMints: args.protectMints,
  });
  if (args.limit != null && args.limit > 0) rows = rows.slice(0, args.limit);

  const result: OrphanJanitorResult = {
    candidates: rows.length,
    burnedClosed: 0,
    skipped: 0,
    reclaimedLamports: 0,
    signatures: [],
    errors: [],
  };
  if (!args.execute || rows.length === 0) return result;

  const connection = new Connection(args.rpcUrl, 'confirmed');
  for (const row of rows) {
    const one = await burnAndCloseOne({ connection, signer, row });
    if (one.signature) {
      result.burnedClosed += 1;
      result.reclaimedLamports += one.reclaimedLamports;
      result.signatures.push(one.signature);
    } else {
      result.skipped += 1;
      if (one.error) {
        result.errors.push(`${row.mint.slice(0, 8)}…: ${one.error.slice(0, 160)}`);
      }
    }
  }
  return result;
}

/** Load currently open mild-dip mints so we never burn live inventory. */
export function protectMintsFromMildDipState(statePath: string): string[] {
  try {
    if (!fs.existsSync(statePath)) return [];
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { open?: Record<string, unknown> };
    return Object.keys(raw.open ?? {});
  } catch {
    return [];
  }
}
