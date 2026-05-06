/**
 * Сравнение «открытых позиций» Live Oscar после replay журнала и реальных SPL-балансов кошелька.
 *
 * На VPS (как у live-oscar):
 *   cd /opt/solana-alpha && DIAG_DOTENV=.env DIAG_WORKDIR=. sudo -E -u salpha npx tsx scripts-tmp/report-live-opens-vs-wallet.ts
 *
 * Флаги:
 *   --trust-ghost — то же, что trustGhostPositions в replay (покажет строки без якоря подписей).
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { replayLiveStrategyJournal } from '../src/live/replay-strategy-journal.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function loadDotenv(): void {
  const p = process.env.DIAG_DOTENV?.trim();
  if (p) {
    dotenv.config({ path: path.isAbsolute(p) ? p : path.resolve(process.cwd(), p) });
    return;
  }
  for (const cand of ['.env', '.env.local']) {
    const abs = path.resolve(process.cwd(), cand);
    if (fs.existsSync(abs)) dotenv.config({ path: abs });
  }
}

function applyWorkdir(): void {
  const w = process.env.DIAG_WORKDIR?.trim();
  if (w) process.chdir(path.isAbsolute(w) ? w : path.resolve(process.cwd(), w));
}

function rpcUrl(): string {
  return (
    process.env.SA_RPC_HTTP_URL?.trim() ||
    process.env.QUICKNODE_HTTP_URL?.trim() ||
    process.env.SA_RPC_URL?.trim() ||
    ''
  );
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await res.json()) as { error?: unknown; result?: T };
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result as T;
}

interface ParsedAcct {
  mint: string;
  uiAmount: number;
}

function extractParsed(accts: unknown[]): ParsedAcct[] {
  const out: ParsedAcct[] = [];
  if (!Array.isArray(accts)) return out;
  for (const row of accts) {
    const acc = row as { account?: { data?: { parsed?: { info?: Record<string, unknown> } } } };
    const info = acc.account?.data?.parsed?.info;
    if (!info || typeof info !== 'object') continue;
    const mint = info.mint != null ? String(info.mint) : '';
    if (!mint) continue;
    const ta = info.tokenAmount as Record<string, unknown> | undefined;
    let ui = 0;
    if (ta && typeof ta.uiAmount === 'number' && Number.isFinite(ta.uiAmount)) ui = ta.uiAmount;
    else if (ta && typeof ta.uiAmountString === 'string') ui = Number(ta.uiAmountString);
    if (!Number.isFinite(ui) || ui <= 0) continue;
    out.push({ mint, uiAmount: ui });
  }
  return out;
}

async function walletNonZeroMints(url: string, owner: string): Promise<Map<string, number>> {
  const merged = new Map<string, number>();
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await rpc<{ value: unknown[] }>(url, 'getTokenAccountsByOwner', [
      owner,
      { programId },
      { encoding: 'jsonParsed' },
    ]);
    for (const { mint, uiAmount } of extractParsed(res.value ?? [])) {
      merged.set(mint, (merged.get(mint) ?? 0) + uiAmount);
    }
  }
  return merged;
}

function main(): void {
  applyWorkdir();
  loadDotenv();

  const argv = new Set(process.argv.slice(2));
  const trustGhost = argv.has('--trust-ghost');

  const url = rpcUrl();
  const storePath = (process.env.LIVE_TRADES_PATH || '').trim();
  const wallet = (process.env.LIVE_WALLET_PUBKEY || '').trim();
  const strategyId = (process.env.LIVE_STRATEGY_ID || 'live-oscar').trim();
  const maxBRaw = process.env.LIVE_REPLAY_MAX_FILE_BYTES?.trim();
  const maxFileBytes =
    maxBRaw && maxBRaw.length > 0 ? Number(maxBRaw) : 26_214_400;

  if (!url) {
    console.error(JSON.stringify({ ok: false, err: 'no RPC URL (SA_RPC_HTTP_URL / QUICKNODE_HTTP_URL)' }));
    process.exit(1);
  }
  if (!storePath || !fs.existsSync(storePath)) {
    console.error(JSON.stringify({ ok: false, err: 'LIVE_TRADES_PATH missing or file not found', storePath }));
    process.exit(1);
  }
  if (!wallet) {
    console.error(JSON.stringify({ ok: false, err: 'LIVE_WALLET_PUBKEY missing' }));
    process.exit(1);
  }

  void (async () => {
    const replay = replayLiveStrategyJournal({
      storePath,
      strategyId,
      maxFileBytes: Number.isFinite(maxFileBytes) ? maxFileBytes : 26_214_400,
      trustGhostPositions: trustGhost,
    });

    const strategyMints = new Set(replay.open.keys());
    const walletMap = await walletNonZeroMints(url, wallet);
    const walletMints = new Set(walletMap.keys());

    const onlyStrategy = [...strategyMints].filter((m) => !walletMints.has(m));
    const onlyWallet = [...walletMints].filter((m) => !strategyMints.has(m));

    const report = {
      ok: true,
      cwd: process.cwd(),
      strategyId,
      trustGhostPositions: trustGhost,
      journalTruncated: replay.journalTruncated === true,
      liveTradesPath: storePath,
      walletPubkey: wallet,
      strategyOpenCount: strategyMints.size,
      strategyOpenMints: [...strategyMints].sort(),
      walletNonZeroSplMints: [...walletMints].sort(),
      onlyStrategyNotInWallet: onlyStrategy.sort(),
      onlyWalletNotInStrategy: onlyWallet.sort(),
      walletBalancesUiSample: Object.fromEntries(
        [...onlyWallet, ...[...strategyMints].filter((m) => walletMints.has(m))]
          .sort()
          .map((m) => [m, walletMap.get(m)]),
      ),
    };

    console.log(JSON.stringify(report, null, 2));
  })().catch((e) => {
    console.error(JSON.stringify({ ok: false, err: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  });
}

main();
