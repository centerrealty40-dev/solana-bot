import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import {
  ensureDcaOperatorTables,
  fetchDcaOperatorStats,
  formatOperatorTrustLine,
  recordDcaClose,
  recordDcaFill,
  recordDcaOpen,
} from './dca-operator-tracker.js';

type JsonRpcResponse<T> = {
  result?: T;
  error?: { code?: number; message?: string };
};

type SignatureRow = {
  signature: string;
  blockTime?: number;
};

type WatchState = {
  lastByWallet: Record<string, string>;
  lastByProgram: Record<string, string>;
  seenSignatures: Record<string, number>;
  knownOrderIds: Record<string, number>;
  discoveredWallets: Record<string, number>;
  buySeries: Record<
    string,
    {
      firstTsMs: number;
      lastTsMs: number;
      cycles: number;
      totalUsd: number;
    }
  >;
  /**
   * Alt pipeline: keyed by `tokenRecipient|mint` (the stable buyer vault that accumulates the coin,
   * e.g. En9UYdeQ|prelode). The keeper (gasBid) signs but only pays fees; SOL is debited from a
   * funding vault. We only alert after observing a real repeated series.
   */
  swapExecSeries: Record<
    string,
    {
      tokenRecipient: string;
      mint: string;
      executor: string;
      solVault: string;
      firstTsMs: number;
      lastTsMs: number;
      cycles: number;
      totalUsd: number;
      lastCycleUsd: number;
      freqSec: number;
      tsHistory: number[];
      alerted: boolean;
      /** Lazily resolved initiating (open) tx data via the SOL funding vault. */
      openResolved?: boolean;
      openConfirmed?: boolean;
      openSig?: string;
      orderPda?: string;
      buyer?: string;
      depositSol?: number;
      depositUsd?: number;
      plannedCycles?: number;
      openTsMs?: number;
    }
  >;
};

function loadEnv(): void {
  const candidates = ['.env', '.env.local'];
  for (const file of candidates) {
    const abs = path.resolve(process.cwd(), file);
    if (fs.existsSync(abs)) dotenv.config({ path: abs, override: false });
  }
}

/** Official Jupiter recurring-DCA program (network-wide new opens). */
const JUPITER_DCA_PROGRAM = 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M';
/** Jupiter swap aggregator — alt DCA pipeline executes periodic buys via Route/SharedAccountsRoute. */
const JUPITER_SWAP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const OPEN_DCA_V2_DISC = Buffer.from('8e772b6da2340bb1', 'hex');

type DcaOpenPlan = {
  inputMint: string;
  outputMint: string;
  inAmountRaw: bigint;
  inAmountPerCycleRaw: bigint;
  cycleFrequencySec: number;
  cycles: number;
  cycleUsd: number;
  totalUsd: number;
  etaSec: number;
};

const WATCH_PROGRAMS = new Set([
  JUPITER_DCA_PROGRAM,
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u',
  'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH',
]);

/** Non-Jupiter bot-style DCA executors (seed vault + order_id pattern). */
const BOT_DCA_PROGRAMS = new Set([
  'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u',
  'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH',
]);

const EXPLICIT_WALLETS = () => new Set(wallets());

function rpcUrl(): string {
  return (
    process.env.DCA_WATCH_RPC_URL?.trim() ||
    process.env.SA_RPC_HTTP_URL?.trim() ||
    process.env.SA_RPC_URL?.trim() ||
    ''
  );
}

function pollMs(): number {
  const n = Number(process.env.DCA_WATCH_POLL_INTERVAL_MS || 15000);
  return Number.isFinite(n) && n >= 2000 ? n : 15000;
}

function sigLimit(): number {
  const n = Number(process.env.DCA_WATCH_SIGNATURE_LIMIT || 20);
  if (!Number.isFinite(n)) return 20;
  return Math.max(5, Math.min(50, Math.floor(n)));
}

function statePath(): string {
  return process.env.DCA_WATCH_STATE_PATH || path.join('data', 'dca-watch-state.json');
}

function tgToken(): string {
  return process.env.DCA_WATCH_TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
}

function tgChatId(): string {
  return process.env.DCA_WATCH_TELEGRAM_CHAT_ID?.trim() || process.env.TELEGRAM_CHAT_ID?.trim() || '';
}

function wallets(): string[] {
  const csv = process.env.DCA_WATCH_WALLETS?.trim() || '';
  if (!csv) return [];
  return Array.from(new Set(csv.split(',').map((s) => s.trim()).filter(Boolean)));
}

function discoveryEnabled(): boolean {
  return process.env.DCA_WATCH_DISCOVERY_ENABLED !== '0';
}

function defaultDiscoveryPrograms(): string[] {
  const base = [JUPITER_DCA_PROGRAM, ...BOT_DCA_PROGRAMS];
  if (swapExecPipelineEnabled()) base.push(JUPITER_SWAP_PROGRAM);
  return base;
}

function swapExecPipelineEnabled(): boolean {
  return process.env.DCA_WATCH_SWAP_EXEC_ENABLED !== '0';
}

function swapExecMinCycleUsd(): number {
  const n = Number(process.env.DCA_WATCH_SWAP_EXEC_MIN_CYCLE_USD ?? 50);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function swapExecDefaultFreqSec(): number {
  const n = Number(process.env.DCA_WATCH_SWAP_EXEC_DEFAULT_FREQ_SEC ?? 60);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

/** Projection-only: estimated total cycles a DCA might run (NOT used to inflate observed deposit). */
function swapExecEstCycles(): number {
  const n = Number(process.env.DCA_WATCH_SWAP_EXEC_EST_CYCLES ?? 60);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 60;
}

function maxDiscoveredWallets(): number {
  const n = Number(process.env.DCA_WATCH_MAX_DISCOVERED_WALLETS || 50);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

function discoveryPrograms(): string[] {
  const csv = process.env.DCA_WATCH_DISCOVERY_PROGRAMS?.trim() || defaultDiscoveryPrograms().join(',');
  return Array.from(new Set(csv.split(',').map((s) => s.trim()).filter(Boolean)));
}

function discoverySigLimit(): number {
  const n = Number(process.env.DCA_WATCH_DISCOVERY_SIGNATURE_LIMIT || 100);
  if (!Number.isFinite(n)) return 100;
  return Math.max(10, Math.min(100, Math.floor(n)));
}

function discoveryMaxPages(): number {
  const n = Number(process.env.DCA_WATCH_DISCOVERY_MAX_PAGES || 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

function discoveredWalletTtlMs(): number {
  const n = Number(process.env.DCA_WATCH_DISCOVERED_WALLET_TTL_MS || 7 * 24 * 3600 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 7 * 24 * 3600 * 1000;
}

function seenSigTtlMs(): number {
  const n = Number(process.env.DCA_WATCH_SEEN_SIG_TTL_MS || 24 * 3600 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 24 * 3600 * 1000;
}

function setupMinUsd(): number {
  const n = Number(process.env.DCA_WATCH_SETUP_MIN_USD ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function cycleTierSmallUsd(): number {
  const n = Number(process.env.DCA_WATCH_CYCLE_TIER_SMALL_USD ?? 200);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

function cycleTierSmallMinCycles(): number {
  const n = Number(process.env.DCA_WATCH_CYCLE_TIER_SMALL_MIN_CYCLES ?? 5);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 5;
}

function cycleTierLargeUsd(): number {
  const n = Number(process.env.DCA_WATCH_CYCLE_TIER_LARGE_USD ?? 2000);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

function cycleTierLargeMinCycles(): number {
  const n = Number(process.env.DCA_WATCH_CYCLE_TIER_LARGE_MIN_CYCLES ?? 2);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 2;
}

function defaultCycleSec(): number {
  const n = Number(process.env.DCA_WATCH_DEFAULT_CYCLE_SEC || 120);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120;
}

function defaultTargetCycles(): number {
  const n = Number(process.env.DCA_WATCH_TARGET_CYCLES || 100);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readState(): WatchState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as WatchState;
    if (parsed && parsed.lastByWallet && typeof parsed.lastByWallet === 'object') {
      return {
        lastByWallet: parsed.lastByWallet || {},
        lastByProgram: parsed.lastByProgram || {},
        seenSignatures: parsed.seenSignatures || {},
        knownOrderIds: parsed.knownOrderIds || {},
        discoveredWallets: parsed.discoveredWallets || {},
        buySeries: parsed.buySeries || {},
        swapExecSeries: parsed.swapExecSeries || {},
      };
    }
  } catch {
    // ignore
  }
  return {
    lastByWallet: {},
    lastByProgram: {},
    seenSignatures: {},
    knownOrderIds: {},
    discoveredWallets: {},
    buySeries: {},
    swapExecSeries: {},
  };
}

function writeState(next: WatchState): void {
  const p = statePath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function gcState(st: WatchState): void {
  const now = Date.now();
  const sigCutoff = now - seenSigTtlMs();
  const walletCutoff = now - discoveredWalletTtlMs();
  const orderCutoff = now - 30 * 24 * 3600 * 1000;

  for (const [sig, ts] of Object.entries(st.seenSignatures)) {
    if (!Number.isFinite(ts) || ts < sigCutoff) delete st.seenSignatures[sig];
  }
  for (const [w, ts] of Object.entries(st.discoveredWallets)) {
    if (!Number.isFinite(ts) || ts < walletCutoff) delete st.discoveredWallets[w];
  }
  for (const [orderId, ts] of Object.entries(st.knownOrderIds || {})) {
    if (!Number.isFinite(ts) || ts < orderCutoff) delete st.knownOrderIds[orderId];
  }
  const seriesCutoff = now - 14 * 24 * 3600 * 1000;
  for (const [k, s] of Object.entries(st.swapExecSeries || {})) {
    if (!s?.lastTsMs || s.lastTsMs < seriesCutoff) delete st.swapExecSeries[k];
  }
}

function markSeen(st: WatchState, signature: string): void {
  st.seenSignatures[signature] = Date.now();
}

function isSeen(st: WatchState, signature: string): boolean {
  return Boolean(st.seenSignatures[signature]);
}

async function rpcCall<T>(method: string, params: unknown[], retries = 6): Promise<T | null> {
  const url = rpcUrl();
  if (!url) return null;
  let wait = 700;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
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

function extractOrderId(logs: string): string {
  const m = logs.match(/order_id:\s*(\d+)/i);
  return m ? m[1] : '';
}

function extractAmountInOut(logs: string): { amountInRaw: string; amountOutRaw: string } {
  const pair = logs.match(/amount_in:\s*(\d+).*amount_out:\s*(\d+)/i);
  if (pair) return { amountInRaw: pair[1], amountOutRaw: pair[2] };
  const one = logs.match(/amount_in:\s*(\d+)/i);
  return { amountInRaw: one ? one[1] : '', amountOutRaw: '' };
}

type Classified = {
  kind: 'BUY_EXEC' | 'SETUP' | 'CLOSE' | 'OTHER';
  setupSource?: 'jupiter_dca' | 'bot_dca' | 'swap_exec_dca';
  programs: string[];
  orderId: string;
  amountInRaw: string;
  amountOutRaw: string;
  blockTime?: number;
  mint?: string;
  walletTokenDelta?: number;
  swapExec?: {
    executor: string;
    orderAccount: string;
    tokenRecipient: string;
    /** Resolved from the on-chain initiating (open) tx, when found. */
    openConfirmed?: boolean;
    openSig?: string;
    orderPda?: string;
    buyer?: string;
    depositSol?: number;
    depositUsd?: number;
    plannedCycles?: number;
  };
};

function instructionTypes(tx: any): string[] {
  const instructions = tx?.transaction?.message?.instructions || [];
  const types: string[] = [];
  for (const ins of instructions) {
    const t = ins?.parsed?.type;
    if (typeof t === 'string' && !types.includes(t)) types.push(t);
  }
  return types;
}

function txLogs(tx: any): { logs: string; logsLower: string } {
  const logsArr = tx?.meta?.logMessages || [];
  const logs = Array.isArray(logsArr) ? logsArr.join('\n') : '';
  return { logs, logsLower: logs.toLowerCase() };
}

function txProgramIds(tx: any): string[] {
  const instructions = tx?.transaction?.message?.instructions || [];
  const ids: string[] = [];
  for (const ins of instructions) {
    const pid = ins?.programId || ins?.program;
    if (typeof pid === 'string' && !ids.includes(pid)) ids.push(pid);
  }
  return ids;
}

function isJupiterDcaOpen(logsLower: string): boolean {
  return logsLower.includes('instruction: opendca');
}

function isJupiterDcaClose(logsLower: string): boolean {
  return logsLower.includes('instruction: closedca');
}

function isJupiterDcaFill(logsLower: string): boolean {
  return logsLower.includes('instruction: initiateflashfill') || logsLower.includes('instruction: fulfillflashfill');
}

function isJupiterSwapRoute(logsLower: string): boolean {
  return logsLower.includes('instruction: route') || logsLower.includes('sharedaccountsroute');
}

function txAccountKeys(tx: any): string[] {
  return (tx?.transaction?.message?.accountKeys || []).map((k: any) =>
    typeof k === 'string' ? k : String(k?.pubkey || ''),
  );
}

/** Per-account net SOL (lamport) deltas for the tx. */
function lamportDeltas(tx: any): { pubkey: string; deltaSol: number }[] {
  const keys = txAccountKeys(tx);
  const pre = tx?.meta?.preBalances || [];
  const post = tx?.meta?.postBalances || [];
  return keys.map((pubkey, i) => ({
    pubkey,
    deltaSol: (Number(post[i] || 0) - Number(pre[i] || 0)) / 1_000_000_000,
  }));
}

/** Net token delta per owner+mint. */
function tokenDeltaRows(tx: any): { owner: string; mint: string; delta: number }[] {
  const keys = txAccountKeys(tx);
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const map = new Map<string, { owner: string; mint: string; delta: number }>();
  for (const b of pre) {
    const owner = String(b?.owner || keys[b?.accountIndex] || '');
    const mint = String(b?.mint || '');
    if (!owner || !mint) continue;
    const k = `${owner}|${mint}`;
    map.set(k, { owner, mint, delta: -Number(b?.uiTokenAmount?.uiAmount || 0) });
  }
  for (const b of post) {
    const owner = String(b?.owner || keys[b?.accountIndex] || '');
    const mint = String(b?.mint || '');
    if (!owner || !mint) continue;
    const k = `${owner}|${mint}`;
    const cur = map.get(k);
    if (cur) cur.delta += Number(b?.uiTokenAmount?.uiAmount || 0);
    else map.set(k, { owner, mint, delta: Number(b?.uiTokenAmount?.uiAmount || 0) });
  }
  return [...map.values()];
}

export type SwapExecBuy = {
  mint: string;
  recipient: string;
  solVault: string;
  cycleSol: number;
  cycleUsd: number;
  signerIsKeeper: boolean;
};

/**
 * Identify a real "buy of a meme coin" inside a Jupiter route:
 *  - a non-stable mint with a POSITIVE delta to some owner (the buyer/recipient vault)
 *    AND a NEGATIVE delta of the same mint elsewhere (the AMM pool counterparty) — this proves
 *    a genuine swap output, not just any token movement;
 *  - the cycle cost = the largest SOL outflow in the tx (the funding vault), or stable-coin outflow.
 * Returns null if the tx is not a clean single-coin accumulation.
 */
function analyzeSwapExecBuy(tx: any, signer: string, dex: DexInfo | null): SwapExecBuy | null {
  const rows = tokenDeltaRows(tx);
  const byMint = new Map<string, { pos: { owner: string; delta: number }[]; neg: number }>();
  for (const r of rows) {
    if (!r.mint || STABLE_MINTS.has(r.mint) || !looksLikeMintAddress(r.mint)) continue;
    const e = byMint.get(r.mint) || { pos: [], neg: 0 };
    if (r.delta > 0) e.pos.push({ owner: r.owner, delta: r.delta });
    else if (r.delta < 0) e.neg += -r.delta;
    byMint.set(r.mint, e);
  }

  // Candidate buy: mint with both a positive recipient and a negative (pool) counterparty.
  let best: { mint: string; recipient: string; qty: number } | null = null;
  for (const [mint, e] of byMint.entries()) {
    if (e.neg <= 0 || e.pos.length === 0) continue;
    const top = e.pos.sort((a, b) => b.delta - a.delta)[0];
    if (!top) continue;
    if (!best || top.delta > best.qty) best = { mint, recipient: top.owner, qty: top.delta };
  }
  if (!best) return null;

  // Funding side: the largest SOL outflow account (vault). For keeper DCAs the signer only pays fee.
  const lam = lamportDeltas(tx).sort((a, b) => a.deltaSol - b.deltaSol);
  const vault = lam[0];
  const cycleSol = vault && vault.deltaSol < 0 ? -vault.deltaSol : 0;

  let cycleUsd = 0;
  let solVault = vault?.pubkey || '';
  if (cycleSol > 0.0005) {
    cycleUsd = cycleSol * solUsdPrice(dex);
  } else {
    // Stable-coin funded DCA: sum negative stable deltas (USDC/USDT leaving a vault).
    let stableOut = 0;
    for (const r of rows) {
      if (r.delta < 0 && (r.mint === USDC_MINT || r.mint === USDT_MINT)) stableOut += -r.delta;
    }
    cycleUsd = stableOut;
  }

  const signerDelta = lamportDeltas(tx).find((l) => l.pubkey === signer)?.deltaSol ?? 0;
  const signerIsKeeper = Math.abs(signerDelta) < 0.01;

  return {
    mint: best.mint,
    recipient: best.recipient,
    solVault,
    cycleSol,
    cycleUsd,
    signerIsKeeper,
  };
}

function swapExecSeriesKey(tokenRecipient: string, mint: string): string {
  return `${tokenRecipient}|${mint}`;
}

function medianFreqSec(tsHistory: number[]): number {
  if (tsHistory.length < 2) return 0;
  const sorted = [...tsHistory].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 1000);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const m = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(1, Math.floor(m));
}

/**
 * Plan from observed cycles, enriched with the real on-chain open when resolved:
 *  - cycleUsd = last observed per-buy spend (real),
 *  - cycles   = executed buys so far (on-chain fill count when known),
 *  - totalUsd = real deposit when the open is confirmed, else observed sum,
 *  - freq     = observed/vault median cadence.
 */
function planFromSwapExecSeries(series: WatchState['swapExecSeries'][string]): DcaOpenPlan {
  const cycleUsd = series.lastCycleUsd > 0
    ? series.lastCycleUsd
    : series.cycles > 0
      ? series.totalUsd / series.cycles
      : 0;
  const cycles = Math.max(1, series.cycles);
  const freq = series.freqSec > 0 ? series.freqSec : medianFreqSec(series.tsHistory) || swapExecDefaultFreqSec();
  const totalUsd = series.openConfirmed && (series.depositUsd ?? 0) > 0 ? (series.depositUsd as number) : series.totalUsd;
  const plannedCycles = series.plannedCycles && series.plannedCycles > cycles ? series.plannedCycles : cycles;
  const remaining = Math.max(0, plannedCycles - cycles);
  const etaSec = remaining > 0 ? remaining * freq : freq;
  return {
    inputMint: SOL_MINT,
    outputMint: series.mint,
    inAmountRaw: 0n,
    inAmountPerCycleRaw: 0n,
    cycleFrequencySec: freq,
    cycles,
    cycleUsd,
    totalUsd,
    etaSec,
  };
}

type SwapExecOpenInfo = {
  openSig: string;
  openTsMs: number;
  depositSol: number;
  targetMint: string;
  orderPda: string;
  buyer: string;
  fillCount: number;
  medianFreqSec: number;
  /** SOL spent per cycle, sampled from the most recent executed fill (0 if no fills yet). */
  cycleSol: number;
};

/** Cache per SOL funding vault: the resolved initiating (open) tx, or null if not an open pattern. */
const swapExecOpenCache = new Map<string, SwapExecOpenInfo | null>();

function minOpenDepositSol(): number {
  const n = Number(process.env.DCA_WATCH_SWAP_EXEC_MIN_OPEN_SOL ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Bot operator co-signer keys whose feeds we poll to catch DCA opens in real time (e.g. gasBid family). */
function dcaOperators(): string[] {
  const csv = process.env.DCA_WATCH_DCA_OPERATORS?.trim() || 'trfb53BmkHNeoqaa3REgqnrbwUZqAFYdjTkivkJ6aWg';
  return Array.from(new Set(csv.split(',').map((s) => s.trim()).filter((s) => s.length >= 32)));
}

export type DcaOpenDetect = {
  vault: string;
  orderPda: string;
  depositSol: number;
  targetMint: string;
  buyer: string;
  signers: string[];
};

/**
 * Recognize the INITIATING (open) tx of an alt-pipeline DCA by its on-chain structure:
 *   createAccountWithSeed (PDA-seeded WSOL vault) + initializeAccount3 + a large SOL transfer
 *   into that vault + syncNative, plus an ATA created for the target (non-stable) coin.
 * This is the structure of the real opens (3 signers incl. the bot operator, e.g. trfb53),
 * and is distinct from one-off Jupiter route swaps. Returns null otherwise.
 */
function detectDcaOpen(tx: any): DcaOpenDetect | null {
  const types = instructionTypes(tx);
  if (!types.includes('createAccountWithSeed') || !types.includes('syncNative')) return null;
  const ix = tx?.transaction?.message?.instructions || [];

  let vault = '';
  let orderPda = '';
  let targetMint = '';
  for (const i of ix) {
    const info = i?.parsed?.info;
    const t = i?.parsed?.type;
    if (t === 'createAccountWithSeed' && info?.newAccount) {
      vault = String(info.newAccount);
      orderPda = String(info.base || '');
    }
    if (t === 'createIdempotent' && info?.mint && info.mint !== SOL_MINT && !STABLE_MINTS.has(info.mint)) {
      targetMint = String(info.mint);
    }
  }
  if (!vault) return null;

  let depositLamports = 0;
  for (const i of ix) {
    const info = i?.parsed?.info;
    if (i?.parsed?.type === 'transfer' && info?.destination === vault && info?.lamports) {
      depositLamports += Number(info.lamports);
    }
  }
  const depositSol = depositLamports / 1_000_000_000;
  if (depositSol < minOpenDepositSol()) return null;

  const signers: string[] = (tx?.transaction?.message?.accountKeys || [])
    .map((k: any) => (typeof k === 'string' ? null : k?.signer ? String(k.pubkey) : null))
    .filter((s: string | null): s is string => !!s);
  // Real opens are co-signed (funder + order PDA + operator). One-off wraps are single-signer.
  if (signers.length < 2) return null;

  // Buyer/opener = the signer whose lamports dropped by ~deposit (the funder).
  const lam = lamportDeltas(tx);
  let buyer = signers[0] || '';
  let worst = 0;
  for (const l of lam) {
    if (signers.includes(l.pubkey) && l.deltaSol < worst) {
      worst = l.deltaSol;
      buyer = l.pubkey;
    }
  }

  return { vault, orderPda, depositSol, targetMint, buyer, signers };
}

/**
 * Follow the on-chain link fill → SOL funding vault → the vault's OLDEST tx (its creation),
 * which is the initiating DCA open. Extract the real deposit, target coin, order PDA and buyer.
 * Returns null when the vault's first tx is not a recognizable open (graceful).
 */
async function resolveSwapExecOpen(solVault: string): Promise<SwapExecOpenInfo | null> {
  if (!solVault || solVault.length < 32) return null;
  if (swapExecOpenCache.has(solVault)) return swapExecOpenCache.get(solVault) ?? null;

  // A dedicated per-order WSOL vault has a small history (deposit + N fills). One page suffices;
  // if it returns a full page the account is "hot" (shared/whale) and not a per-DCA vault → bail.
  const all = (await rpcCall<SignatureRow[]>('getSignaturesForAddress', [solVault, { limit: 1000 }], 5)) || [];
  if (all.length === 0 || all.length >= 1000) {
    swapExecOpenCache.set(solVault, null);
    return null;
  }

  // Cadence = median gap between FILLS only (exclude the open→first-fill setup latency). Needs >=2 fills.
  const times = all.map((r) => Number(r.blockTime || 0)).filter((t) => t > 0).sort((a, b) => a - b);
  const fillTimes = times.slice(1);
  const gaps: number[] = [];
  for (let i = 1; i < fillTimes.length; i++) gaps.push(fillTimes[i] - fillTimes[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianFreqSec = gaps.length ? Math.max(1, Math.floor(gaps[Math.floor(gaps.length / 2)])) : 0;

  const oldest = all[all.length - 1];
  const tx = await rpcCall<any>(
    'getTransaction',
    [oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    5,
  );
  const open = tx ? detectDcaOpen(tx) : null;
  if (!open || open.vault !== solVault) {
    swapExecOpenCache.set(solVault, null);
    return null;
  }

  // Sample the SOL spent per cycle from the most recent executed fill (newest sig that is not the open).
  let cycleSol = 0;
  const newest = all[0];
  if (newest && newest.signature !== oldest.signature) {
    const fillTx = await rpcCall<any>(
      'getTransaction',
      [newest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      5,
    );
    const fillSigner = fillTx ? extractSignerWallet(fillTx) : null;
    if (fillTx && fillSigner) {
      const buy = analyzeSwapExecBuy(fillTx, fillSigner, null);
      if (buy && buy.mint === open.targetMint && buy.cycleSol > 0) cycleSol = buy.cycleSol;
    }
  }

  const info: SwapExecOpenInfo = {
    openSig: oldest.signature,
    openTsMs: Number(oldest.blockTime || 0) * 1000,
    depositSol: open.depositSol,
    targetMint: open.targetMint || '',
    orderPda: open.orderPda || '',
    buyer: open.buyer,
    fillCount: Math.max(0, all.length - 1),
    medianFreqSec,
    cycleSol,
  };
  swapExecOpenCache.set(solVault, info);
  return info;
}

async function processSwapExecTx(st: WatchState, row: SignatureRow, tx: any): Promise<boolean> {
  const { logsLower } = txLogs(tx);
  if (!isJupiterSwapRoute(logsLower)) return false;

  const signer = extractSignerWallet(tx);
  if (!signer) {
    markSeen(st, row.signature);
    return true;
  }

  // Resolve the meme buy by matching a positive recipient delta against a pool counterparty.
  const buy = analyzeSwapExecBuy(tx, signer, null);
  if (!buy || !looksLikeMintAddress(buy.mint)) {
    markSeen(st, row.signature);
    return true;
  }

  // Price the cycle with the live SOL price for this coin's quote.
  const dex = await fetchDexInfo(buy.mint);
  const cycleUsd = buy.cycleSol > 0.0005 ? buy.cycleSol * solUsdPrice(dex) : buy.cycleUsd;
  if (cycleUsd <= 0) {
    markSeen(st, row.signature);
    return true;
  }

  // The SOL funding vault links fills to the open; skip cycles we cannot anchor to a vault.
  const solVaultEarly = buy.solVault || '';
  if (!solVaultEarly || solVaultEarly.length < 32) {
    markSeen(st, row.signature);
    return true;
  }

  const tsMs = row.blockTime ? row.blockTime * 1000 : Date.now();
  // Stable key = the SOL funding vault (shared by the open tx and every fill) + the mint.
  const sKey = swapExecSeriesKey(solVaultEarly, buy.mint);
  const prev = st.swapExecSeries[sKey];
  const cycles = (prev?.cycles || 0) + 1;
  const firstTsMs = prev?.firstTsMs ?? tsMs;
  const tsHistory = [...(prev?.tsHistory || []), tsMs].slice(-50);
  const freqSec = medianFreqSec(tsHistory);

  const solVault = solVaultEarly || prev?.solVault || '';
  st.swapExecSeries[sKey] = {
    tokenRecipient: buy.recipient,
    mint: buy.mint,
    executor: signer,
    solVault,
    firstTsMs,
    lastTsMs: tsMs,
    cycles,
    totalUsd: (prev?.totalUsd || 0) + cycleUsd,
    lastCycleUsd: cycleUsd,
    freqSec,
    tsHistory,
    alerted: prev?.alerted ?? false,
    openResolved: prev?.openResolved,
    openConfirmed: prev?.openConfirmed,
    openSig: prev?.openSig,
    orderPda: prev?.orderPda,
    buyer: prev?.buyer,
    depositSol: prev?.depositSol,
    depositUsd: prev?.depositUsd,
    plannedCycles: prev?.plannedCycles,
    openTsMs: prev?.openTsMs,
  };

  await recordDcaFill({
    operatorWallet: prev?.buyer || buy.recipient,
    mint: buy.mint,
    seriesKey: sKey,
    fillUsd: cycleUsd,
    eventTsMs: tsMs,
  });

  const series = st.swapExecSeries[sKey];
  if (series.alerted) {
    markSeen(st, row.signature);
    return true;
  }

  // Resolve the on-chain initiating (open) tx via the SOL funding vault — once per vault.
  if (!series.openResolved && solVault) {
    const openInfo = await resolveSwapExecOpen(solVault);
    series.openResolved = true;
    if (openInfo) {
      const solPx = solUsdPrice(dex);
      series.openConfirmed = true;
      series.openSig = openInfo.openSig;
      series.openTsMs = openInfo.openTsMs;
      series.orderPda = openInfo.orderPda;
      series.buyer = openInfo.buyer;
      series.depositSol = openInfo.depositSol;
      series.depositUsd = openInfo.depositSol * solPx;
      series.plannedCycles =
        cycleUsd > 0 ? Math.max(series.cycles, Math.round(series.depositUsd / cycleUsd)) : series.cycles;
      if ((!series.freqSec || series.freqSec <= 0) && openInfo.medianFreqSec > 0) {
        series.freqSec = openInfo.medianFreqSec;
      }
      if (openInfo.fillCount > series.cycles) series.cycles = openInfo.fillCount;
    }
  }

  // Alert ONLY when the on-chain funded open is confirmed (real seed-vault DCA). We no longer
  // alert on a bare "N recurring buys" heuristic — that matched pools/sells and produced garbage.
  const openConfirmed = !!series.openConfirmed && (series.depositUsd ?? 0) > 0;
  if (!openConfirmed) {
    console.log('[dca-watch] swap_exec tracking (no confirmed open)', {
      sig: row.signature.slice(0, 12),
      mint: buy.mint.slice(0, 8),
      vault: shortAddr(solVault),
      cycles: series.cycles,
      cycleUsd: Math.round(cycleUsd),
      openResolved: series.openResolved,
    });
    markSeen(st, row.signature);
    return true;
  }

  const plan = planFromSwapExecSeries(series);

  const cls: Classified = {
    kind: 'SETUP',
    setupSource: 'swap_exec_dca',
    programs: [JUPITER_SWAP_PROGRAM],
    orderId: '',
    amountInRaw: '',
    amountOutRaw: '',
    blockTime: row.blockTime,
    mint: buy.mint,
    swapExec: {
      executor: signer,
      orderAccount: solVault || buy.recipient,
      tokenRecipient: buy.recipient,
      openConfirmed,
      openSig: series.openSig,
      orderPda: series.orderPda,
      buyer: series.buyer,
      depositSol: series.depositSol,
      depositUsd: series.depositUsd,
      plannedCycles: series.plannedCycles,
    },
  };

  registerDiscoveredWallet(st, buy.recipient);
  registerDiscoveredWallet(st, signer);
  // Track the buyer vault (the real accumulator), not the shared keeper.
  const sent = await handleTransaction(st, buy.recipient, row, tx, {
    classified: cls,
    setupPlan: plan,
    setupDepositUsd: plan.totalUsd,
  });
  if (sent) {
    st.swapExecSeries[sKey].alerted = true;
    const s = st.swapExecSeries[sKey];
    await recordDcaOpen({
      operatorWallet: buy.recipient,
      mint: buy.mint,
      source: 'swap_exec_dca',
      openSig: s.openSig || row.signature,
      openTsMs: s.openTsMs || s.firstTsMs,
      plannedCycles: s.plannedCycles || s.cycles,
      plannedCycleUsd: s.totalUsd / Math.max(1, s.cycles),
      plannedTotalUsd: s.depositUsd || s.totalUsd,
      cycleFreqSec: s.freqSec,
      seriesKey: sKey,
    });
  }
  return true;
}

function isBotDcaSetupWallet(tx: any): boolean {
  const types = instructionTypes(tx);
  const hasSeedVault = types.includes('createAccountWithSeed');
  const hasSyncNative = types.includes('syncNative');
  return hasSeedVault && hasSyncNative;
}

function isBotDcaSetupOnProgram(tx: any, logsLower: string): boolean {
  const programIds = txProgramIds(tx);
  if (!programIds.some((p) => BOT_DCA_PROGRAMS.has(p))) return false;
  return isBotDcaSetupWallet(tx) && logsLower.includes('order_id:');
}

function rememberOrderId(st: WatchState, orderId: string): boolean {
  if (!orderId) return false;
  if (st.knownOrderIds[orderId]) return false;
  st.knownOrderIds[orderId] = Date.now();
  return true;
}

function isDcaBuyExec(logsLower: string, orderId: string): boolean {
  // Regular Jupiter swaps often log order_id/SwapTob; DCA buy cycles use BuyExactQuoteIn + order_id.
  return Boolean(orderId) && logsLower.includes('buyexactquotein');
}

function isDcaClose(tx: any, logsLower: string, orderId: string): boolean {
  const types = instructionTypes(tx);
  return types.includes('closeAccount') && Boolean(orderId || logsLower.includes('order_id:'));
}

function classifyTx(tx: any, opts?: { walletScoped?: boolean }): Classified {
  const instructions = tx?.transaction?.message?.instructions || [];
  const { logs, logsLower } = txLogs(tx);

  const programs: string[] = [];
  for (const ins of instructions) {
    const pid = ins?.programId || ins?.program;
    if (typeof pid === 'string' && WATCH_PROGRAMS.has(pid) && !programs.includes(pid)) programs.push(pid);
  }

  const { amountInRaw, amountOutRaw } = extractAmountInOut(logs);
  const orderId = extractOrderId(logs);
  const mintInfo = detectWalletMintDelta(tx);
  const base = {
    programs,
    orderId,
    amountInRaw,
    amountOutRaw,
    blockTime: tx?.blockTime,
    mint: mintInfo?.mint,
    walletTokenDelta: mintInfo?.delta,
  };

  if (isJupiterDcaOpen(logsLower)) {
    const plan = parseJupiterOpenDcaV2(tx, null);
    return {
      kind: 'SETUP',
      setupSource: 'jupiter_dca',
      ...base,
      mint: plan?.outputMint || base.mint,
    };
  }
  if (isBotDcaSetupOnProgram(tx, logsLower)) {
    return { kind: 'SETUP', setupSource: 'bot_dca', ...base };
  }
  if (opts?.walletScoped && isBotDcaSetupWallet(tx)) {
    return { kind: 'SETUP', setupSource: 'bot_dca', ...base };
  }
  if (isJupiterDcaFill(logsLower)) return { kind: 'OTHER', ...base };
  if (isDcaBuyExec(logsLower, orderId)) return { kind: 'BUY_EXEC', ...base };
  if (isJupiterDcaClose(logsLower)) return { kind: 'CLOSE', ...base };
  if (isDcaClose(tx, logsLower, orderId)) return { kind: 'CLOSE', ...base };
  return { kind: 'OTHER', ...base };
}

function classifyProgramTx(program: string, tx: any, st: WatchState): Classified {
  const cls = classifyTx(tx);
  if (cls.kind === 'SETUP') return cls;
  if (cls.kind !== 'BUY_EXEC' || !cls.orderId || !BOT_DCA_PROGRAMS.has(program)) return cls;
  if (!rememberOrderId(st, cls.orderId)) return { ...cls, kind: 'OTHER' };
  return { ...cls, kind: 'SETUP', setupSource: 'bot_dca' };
}

function shouldAlert(kind: Classified['kind'], wallet: string): boolean {
  if (kind === 'OTHER') return false;
  if (kind === 'SETUP') return true;
  return EXPLICIT_WALLETS().has(wallet);
}

function registerDiscoveredWallet(st: WatchState, wallet: string): void {
  if (EXPLICIT_WALLETS().has(wallet)) return;
  const keys = Object.keys(st.discoveredWallets);
  if (keys.length >= maxDiscoveredWallets() && !(wallet in st.discoveredWallets)) return;
  st.discoveredWallets[wallet] = Date.now();
}

function shortAddr(v: string): string {
  if (v.length <= 12) return v;
  return `${v.slice(0, 6)}...${v.slice(-6)}`;
}

function kindEmoji(kind: Classified['kind']): string {
  if (kind === 'BUY_EXEC') return '🟢';
  if (kind === 'SETUP') return '🟡';
  if (kind === 'CLOSE') return '🔴';
  return '⚪';
}

async function sendTelegramAlert(text: string): Promise<boolean> {
  const token = tgToken();
  const chatId = tgChatId();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: `[ALERT][dca_watch]\n${text}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
      const body = await res.text().catch(() => '');
      if (res.status === 429) {
        const retrySec = Number(body.match(/retry after (\d+)/i)?.[1] || 15);
        console.warn('[dca-watch] telegram 429, retry after', retrySec, 's');
        await sleep(Math.min(retrySec * 1000 + 500, 60_000));
        continue;
      }
      console.warn('[dca-watch] telegram non-2xx', res.status, body.slice(0, 300));
      return false;
    } catch (e) {
      console.warn('[dca-watch] telegram send failed', e instanceof Error ? e.message : String(e));
      await sleep(2000);
    }
  }
  return false;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const STABLE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/** OpenDcaV2 account layout: [3]=inputMint, [4]=outputMint (Jupiter DCA program). */
const OPEN_DCA_V2_INPUT_MINT_IDX = 3;
const OPEN_DCA_V2_OUTPUT_MINT_IDX = 4;

const KNOWN_MINT_META: Record<string, { symbol: string; name: string }> = {
  [SOL_MINT]: { symbol: 'SOL', name: 'Solana' },
  [USDC_MINT]: { symbol: 'USDC', name: 'USD Coin' },
  [USDT_MINT]: { symbol: 'USDT', name: 'Tether USD' },
};

function detectWalletMintDelta(tx: any): { mint: string; delta: number } | null {
  const meta = tx?.meta || {};
  const pre = meta?.preTokenBalances || [];
  const post = meta?.postTokenBalances || [];
  if (!Array.isArray(pre) || !Array.isArray(post)) return null;

  const map = new Map<string, number>();
  for (const b of pre) {
    const owner = String(b?.owner || '');
    const mint = String(b?.mint || '');
    const amount = Number(b?.uiTokenAmount?.uiAmount || 0);
    map.set(`${owner}|${mint}`, (map.get(`${owner}|${mint}`) || 0) - amount);
  }
  for (const b of post) {
    const owner = String(b?.owner || '');
    const mint = String(b?.mint || '');
    const amount = Number(b?.uiTokenAmount?.uiAmount || 0);
    map.set(`${owner}|${mint}`, (map.get(`${owner}|${mint}`) || 0) + amount);
  }

  let best: { mint: string; delta: number } | null = null;
  for (const [k, delta] of map.entries()) {
    if (delta <= 0) continue;
    const [, mint] = k.split('|');
    if (!mint || mint === SOL_MINT) continue;
    if (!best || delta > best.delta) best = { mint, delta };
  }
  return best;
}

type DexInfo = {
  symbol: string;
  name: string;
  priceUsd: number;
  marketCap: number;
  liquidityUsd: number;
  volume24h: number;
  volume1h: number;
};

const dexCache = new Map<string, { at: number; val: DexInfo | null }>();

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function looksLikeMintAddress(v: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

function pickDexPairForMint(pairs: any[], mint: string): any | null {
  let best: any = null;
  let bestLiq = 0;
  for (const p of pairs) {
    const base = String(p?.baseToken?.address || '');
    const quote = String(p?.quoteToken?.address || '');
    if (base !== mint && quote !== mint) continue;
    const liq = toNum(p?.liquidity?.usd);
    if (liq >= bestLiq) {
      best = p;
      bestLiq = liq;
    }
  }
  return best;
}

function dexInfoFromPair(pair: any, mint: string): DexInfo {
  const base = pair?.baseToken || {};
  const quote = pair?.quoteToken || {};
  const token = String(base.address || '') === mint ? base : quote;
  const known = KNOWN_MINT_META[mint];
  const symbolRaw = String(token?.symbol || known?.symbol || '').trim();
  const nameRaw = String(token?.name || known?.name || '').trim();
  return {
    symbol: symbolRaw ? symbolRaw.toUpperCase() : known?.symbol || '',
    name: nameRaw || known?.name || '',
    priceUsd: toNum(pair?.priceUsd),
    marketCap: toNum(pair?.marketCap || pair?.fdv),
    liquidityUsd: toNum(pair?.liquidity?.usd),
    volume24h: toNum(pair?.volume?.h24),
    volume1h: toNum(pair?.volume?.h1),
  };
}

function dexInfoFromKnownMint(mint: string): DexInfo | null {
  const known = KNOWN_MINT_META[mint];
  if (!known) return null;
  return {
    symbol: known.symbol,
    name: known.name,
    priceUsd: mint === SOL_MINT ? solUsdPrice(null) : 1,
    marketCap: 0,
    liquidityUsd: 0,
    volume24h: 0,
    volume1h: 0,
  };
}

async function fetchDexInfo(mint?: string): Promise<DexInfo | null> {
  if (!mint || !looksLikeMintAddress(mint)) return null;
  const now = Date.now();
  const cached = dexCache.get(mint);
  if (cached && now - cached.at < 90_000) return cached.val;

  const knownOnly = dexInfoFromKnownMint(mint);
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) {
      const fallback = knownOnly;
      dexCache.set(mint, { at: now, val: fallback });
      return fallback;
    }
    const j = (await r.json()) as { pairs?: any[] };
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    const best = pickDexPairForMint(pairs, mint);
    if (!best) {
      const fallback = knownOnly;
      dexCache.set(mint, { at: now, val: fallback });
      return fallback;
    }
    const info = dexInfoFromPair(best, mint);
    if (!info.symbol && knownOnly) {
      info.symbol = knownOnly.symbol;
      info.name = info.name || knownOnly.name;
    }
    dexCache.set(mint, { at: now, val: info });
    return info;
  } catch {
    const fallback = knownOnly;
    dexCache.set(mint, { at: now, val: fallback });
    return fallback;
  }
}

function fmtMoney(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return 'n/a';
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v.toFixed(3)}%`;
}

function fmtPctSigned(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v > 0 ? '+' : ''}${v.toFixed(3)}%`;
}

function fmtDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return 'n/a';
  const sec = Math.floor(totalSec % 60);
  const min = Math.floor((totalSec / 60) % 60);
  const hrs = Math.floor(totalSec / 3600);
  if (hrs > 0) return `${hrs}h, ${min}m`;
  if (min > 0) return `${min}m, ${sec}s`;
  return `${sec}s`;
}

function fmtGmt(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${da} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mo) - 1]} ${y} ${hh}:${mm}:${ss} GMT`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tgLink(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/** Tap-to-copy in Telegram (tg://copy). */
function tgCopyLink(label: string, copyText: string): string {
  return tgLink(label, `tg://copy?text=${encodeURIComponent(copyText)}`);
}

function addrCopyLine(label: string, address: string): string {
  if (!address || address === 'unknown' || address === 'n/a') return `${label}: n/a`;
  const display = address.length > 16 ? shortAddr(address) : address;
  return `${label}: ${tgCopyLink(display, address)}`;
}

function gmgnSolTokenUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint.trim())}`;
}

function tokenHeadlineLabel(dex: DexInfo | null, mint: string): string {
  const sym = (dex?.symbol || KNOWN_MINT_META[mint]?.symbol || '').trim();
  const name = (dex?.name || KNOWN_MINT_META[mint]?.name || '').trim();
  if (sym && name && name.toUpperCase() !== sym.toUpperCase()) return `${sym} — ${name}`;
  if (sym) return sym;
  if (name) return name;
  return shortAddr(mint);
}

function setupHeadlineHtml(dex: DexInfo | null, mint: string): string {
  const label = tokenHeadlineLabel(dex, mint);
  if (looksLikeMintAddress(mint)) return tgLink(label, gmgnSolTokenUrl(mint));
  return escapeHtml(label);
}

function buildFuturesLinks(symbol: string): string {
  const s = symbol.toUpperCase();
  return [
    tgLink('MEXC', `https://futures.mexc.com/exchange/${s}_USDT?inviteCode=1RTNH`),
    tgLink('Bitget', `https://www.bitget.com/futures/usdt/${s}USDT`),
    tgLink('Gate', `https://www.gate.io/futures/USDT/${s}_USDT?ref=VLMQUL9YCA`),
  ].join(' ');
}

function buildTradeBotsLinks(ca: string): string {
  return [
    tgLink('BLX', `https://bullx.io/terminal?chainId=1399811149&address=${ca}&r=60VRMB61VY9`),
    tgLink('PHO', `https://photon-sol.tinyastro.io/en/r/@DCATracker/${ca}`),
    tgLink('PEP', `https://t.me/pepeboost_sol_bot?start=ref_08lk65_ca_${ca}`),
    tgLink('STB', `https://t.me/SolTradingBot?start=${ca}-FVkcHcHsU`),
    tgLink('TRO', `https://t.me/paris_trojanbot?start=d-clear_account-${ca}`),
    tgLink('BLO', `https://t.me/BloomSolana_bot?start=ref_KA81EL4RQE_ca_${ca}`),
    tgLink('BNK', `https://t.me/furiosa_bonkbot?start=ref_3n3v3_ca_${ca}`),
  ].join(' - ');
}

function buildSolscanLink(sig: string): string {
  return tgLink('Solscan', `https://solscan.io/tx/${sig}`);
}

/** Live SOL/USD, refreshed each poll cycle; falls back to env/static when unavailable. */
let liveSolUsd = 0;

async function refreshSolUsd(): Promise<void> {
  try {
    const info = await fetchDexInfo(SOL_MINT);
    if (info && info.priceUsd > 0) liveSolUsd = info.priceUsd;
  } catch {
    /* keep previous / fallback */
  }
}

function solUsdPrice(dex: DexInfo | null): number {
  if (dex?.symbol === 'SOL' && dex.priceUsd > 0) return dex.priceUsd;
  if (liveSolUsd > 0) return liveSolUsd;
  const n = Number(process.env.DCA_WATCH_SOL_USD || 165);
  return Number.isFinite(n) && n > 0 ? n : 165;
}

function estimateBuyUsd(amountInRaw: string, dex: DexInfo | null): number {
  const raw = Number(amountInRaw || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const sol = raw / 1_000_000_000;
  return sol * solUsdPrice(dex);
}

function extractSignerDepositUsd(tx: any, wallet: string, dex: DexInfo | null): number {
  const solPx = solUsdPrice(dex);
  let totalUsd = 0;

  const allIns: any[] = [...(tx?.transaction?.message?.instructions || [])];
  for (const grp of tx?.meta?.innerInstructions || []) {
    allIns.push(...(grp.instructions || []));
  }
  for (const ins of allIns) {
    const parsed = ins?.parsed;
    if (parsed?.type === 'transfer' && parsed.info?.source === wallet && parsed.info?.lamports) {
      totalUsd += (Number(parsed.info.lamports) / 1_000_000_000) * solPx;
    }
  }

  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const deltaByMint = new Map<string, number>();
  for (const b of pre) {
    if (String(b?.owner) !== wallet) continue;
    const mint = String(b?.mint || '');
    deltaByMint.set(mint, (deltaByMint.get(mint) || 0) - Number(b?.uiTokenAmount?.uiAmount || 0));
  }
  for (const b of post) {
    if (String(b?.owner) !== wallet) continue;
    const mint = String(b?.mint || '');
    deltaByMint.set(mint, (deltaByMint.get(mint) || 0) + Number(b?.uiTokenAmount?.uiAmount || 0));
  }
  for (const [mint, delta] of deltaByMint.entries()) {
    if (delta >= -0.000001) continue;
    const out = Math.abs(delta);
    if (mint === USDC_MINT || mint === USDT_MINT) totalUsd += out;
    else if (mint === SOL_MINT) totalUsd += out * solPx;
  }

  return totalUsd;
}

function estimateSetupDepositUsd(tx: any, wallet: string, cls: Classified, dex: DexInfo | null): number {
  const fromTx = extractSignerDepositUsd(tx, wallet, dex);
  if (fromTx > 0) return fromTx;
  return estimateBuyUsd(cls.amountInRaw, dex);
}

function readU64LE(buf: Buffer, off: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(buf[off + i] ?? 0) << BigInt(8 * i);
  return v;
}

function instructionAccounts(ins: any, tx: any): string[] {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const raw = ins?.accounts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry?.pubkey) return String(entry.pubkey);
      const idx = Number(entry);
      if (Number.isInteger(idx) && keys[idx]) return String(keys[idx]?.pubkey || keys[idx]);
      return '';
    })
    .filter(Boolean);
}

function mintRawToUsd(raw: bigint, mint: string, dex: DexInfo | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (mint === USDC_MINT || mint === USDT_MINT) return n / 1e6;
  if (mint === SOL_MINT) return (n / 1e9) * solUsdPrice(dex);
  return 0;
}

function parseJupiterOpenDcaV2(tx: any, dex: DexInfo | null): DcaOpenPlan | null {
  const instructions = tx?.transaction?.message?.instructions || [];
  for (const ins of instructions) {
    const pid = ins?.programId || ins?.program;
    if (pid !== JUPITER_DCA_PROGRAM) continue;
    const dataB58 = ins?.data;
    if (typeof dataB58 !== 'string' || !dataB58) continue;
    let data: Buffer;
    try {
      data = Buffer.from(bs58.decode(dataB58));
    } catch {
      continue;
    }
    if (data.length < 40 || !data.subarray(0, 8).equals(OPEN_DCA_V2_DISC)) continue;

    const inAmountRaw = readU64LE(data, 16);
    const inAmountPerCycleRaw = readU64LE(data, 24);
    const cycleFrequencySec = Number(readU64LE(data, 32));
    if (inAmountPerCycleRaw <= 0n || !Number.isFinite(cycleFrequencySec) || cycleFrequencySec <= 0) continue;

    const accounts = instructionAccounts(ins, tx);
    const { inputMint, outputMint } = parseOpenDcaV2Mints(accounts);
    if (!outputMint || !looksLikeMintAddress(outputMint)) continue;

    const cycles = Math.max(1, Number(inAmountRaw / inAmountPerCycleRaw));
    const cycleUsd = mintRawToUsd(inAmountPerCycleRaw, inputMint, dex);
    const totalUsd = mintRawToUsd(inAmountRaw, inputMint, dex) || cycleUsd * cycles;
    return {
      inputMint,
      outputMint,
      inAmountRaw,
      inAmountPerCycleRaw,
      cycleFrequencySec,
      cycles,
      cycleUsd,
      totalUsd,
      etaSec: cycleFrequencySec * cycles,
    };
  }
  return null;
}

function parseOpenDcaV2Mints(accounts: string[]): { inputMint: string; outputMint: string } {
  const inputMint = accounts[OPEN_DCA_V2_INPUT_MINT_IDX] || '';
  const outputMint = accounts[OPEN_DCA_V2_OUTPUT_MINT_IDX] || '';
  return { inputMint, outputMint };
}

/** Prefer output mint from OpenDcaV2; never use signer wallet as token CA. */
function resolveAlertMint(cls: Classified, plan: DcaOpenPlan | null): string {
  if (plan?.outputMint && looksLikeMintAddress(plan.outputMint)) return plan.outputMint;
  if (cls.mint && looksLikeMintAddress(cls.mint) && !STABLE_MINTS.has(cls.mint)) return cls.mint;
  if (cls.mint && looksLikeMintAddress(cls.mint) && STABLE_MINTS.has(cls.mint)) return cls.mint;
  return cls.mint || 'unknown';
}

function parseFallbackSetupPlan(depositUsd: number, cls: Classified, dex: DexInfo | null): DcaOpenPlan | null {
  const freq = defaultCycleSec();
  const buyUsd = estimateBuyUsd(cls.amountInRaw, dex);
  let cycleUsd = buyUsd;
  let cycles = defaultTargetCycles();

  if (cycleUsd > 0 && depositUsd > 0) {
    cycles = Math.max(1, Math.round(depositUsd / cycleUsd));
  } else if (depositUsd > 0) {
    cycles = defaultTargetCycles();
    cycleUsd = depositUsd / cycles;
  } else if (cycleUsd > 0) {
    cycles = defaultTargetCycles();
  } else {
    return null;
  }

  if (!(cycleUsd > 0 && cycles > 0)) return null;
  const totalUsd = cycleUsd * cycles;
  return {
    inputMint: '',
    outputMint: cls.mint || '',
    inAmountRaw: 0n,
    inAmountPerCycleRaw: 0n,
    cycleFrequencySec: freq,
    cycles,
    cycleUsd,
    totalUsd,
    etaSec: freq * cycles,
  };
}

function resolveSetupPlan(
  tx: any,
  cls: Classified,
  dex: DexInfo | null,
  depositUsd: number,
): DcaOpenPlan | null {
  const jup = parseJupiterOpenDcaV2(tx, dex);
  if (jup && jup.cycleUsd > 0 && jup.cycles > 0) return jup;
  if (jup && jup.cycles > 0 && jup.cycleFrequencySec > 0) {
    const cycleUsd = jup.totalUsd > 0 ? jup.totalUsd / jup.cycles : depositUsd / jup.cycles;
    if (cycleUsd > 0) return { ...jup, cycleUsd, totalUsd: cycleUsd * jup.cycles };
  }
  return parseFallbackSetupPlan(depositUsd, cls, dex);
}

function planCycleUsd(plan: DcaOpenPlan): number {
  if (plan.cycleUsd > 0) return plan.cycleUsd;
  if (plan.cycles > 0 && plan.totalUsd > 0) return plan.totalUsd / plan.cycles;
  return 0;
}

/** Alert if ≥5 cycles at ≥$200/cycle, or 2–4 cycles with ≥$2000 total deposit. */
function setupPassesCycleInterestFilter(plan: DcaOpenPlan | null): boolean {
  if (!plan || plan.cycles < cycleTierLargeMinCycles()) return false;
  const cycleUsd = planCycleUsd(plan);
  const totalUsd = plan.totalUsd > 0 ? plan.totalUsd : cycleUsd * plan.cycles;
  if (!(cycleUsd > 0 || totalUsd > 0)) return false;

  const smallUsd = cycleTierSmallUsd();
  const smallMinCycles = cycleTierSmallMinCycles();
  const largeUsd = cycleTierLargeUsd();
  const largeMinCycles = cycleTierLargeMinCycles();

  if (cycleUsd >= smallUsd && plan.cycles >= smallMinCycles) return true;
  if (
    plan.cycles >= largeMinCycles &&
    plan.cycles < smallMinCycles &&
    totalUsd >= largeUsd
  ) {
    return true;
  }
  return false;
}

function computePriceImpactEst(
  cycleUsd: number,
  cycles: number,
  liqUsd: number,
): { perCyclePct: number; totalPct: number } {
  if (!(cycleUsd > 0 && cycles > 0 && liqUsd > 0)) return { perCyclePct: NaN, totalPct: NaN };
  const perCyclePct = (cycleUsd / liqUsd) * 100;
  return { perCyclePct, totalPct: perCyclePct * cycles };
}

function buildBuyStyleAlert(
  st: WatchState,
  wallet: string,
  rowSig: string,
  cls: Classified,
  dex: DexInfo | null,
  tsIso: string,
): string {
  const ca = resolveAlertMint(cls, null);
  const symbol = dex?.symbol || KNOWN_MINT_META[ca]?.symbol || (ca !== 'unknown' ? shortAddr(ca) : 'TOKEN');
  const buyUsd = estimateBuyUsd(cls.amountInRaw, dex);
  const liq = dex?.liquidityUsd || 0;
  const targetCycles = defaultTargetCycles();
  const defaultFreq = defaultCycleSec();
  const perCyclePct = liq > 0 && buyUsd > 0 ? (buyUsd / liq) * 100 : NaN;
  const vi1h = dex && dex.volume24h > 0 ? (dex.volume1h / dex.volume24h) * 100 * 24 : NaN;

  const period = tsIso.replace('T', ' ').replace('Z', ' GMT');
  const order = cls.orderId || 'n/a';
  const mintKey = cls.mint || 'unknown';
  const tsMs = cls.blockTime ? cls.blockTime * 1000 : Date.now();
  const seriesKey = `${wallet}|${mintKey}`;
  const prev = st.buySeries[seriesKey];
  const cycles = prev ? prev.cycles + 1 : 1;
  const firstTsMs = prev ? prev.firstTsMs : tsMs;
  const lastTsMs = tsMs;
  const totalUsd = (prev?.totalUsd || 0) + (buyUsd || 0);
  st.buySeries[seriesKey] = { firstTsMs, lastTsMs, cycles, totalUsd };

  const observedFreqSec =
    cycles >= 2 ? Math.max(1, Math.floor((lastTsMs - firstTsMs) / 1000 / (cycles - 1))) : Number.NaN;
  const displayFreqSec = Number.isFinite(observedFreqSec) ? observedFreqSec : defaultFreq;
  const displayCycles = Number.isFinite(observedFreqSec) ? cycles : targetCycles;
  const etaSec = Number.isFinite(observedFreqSec)
    ? targetCycles > cycles
      ? (targetCycles - cycles) * observedFreqSec
      : Number.NaN
    : defaultFreq * targetCycles;
  const totalPct = Number.isFinite(perCyclePct) ? perCyclePct * displayCycles : NaN;

  return [
    `${fmtMoney(buyUsd)} buying ${escapeHtml(symbol)} 🟩`,
    '',
    `Frequency: ${fmtMoney(buyUsd)} every ${displayFreqSec} seconds (${displayCycles} cycles${order !== 'n/a' ? `, order ${escapeHtml(order)}` : ''})`,
    `ETA: ${fmtDuration(etaSec)}`,
    `Scores: 👍`,
    `Potential price change: ${fmtPctSigned(totalPct)} (${fmtPctSigned(perCyclePct)} per cycle)`,
    '',
    `MC: ${fmtMoney(dex?.marketCap || 0)} → LQ: ${fmtMoney(dex?.liquidityUsd || 0)}`,
    `V24h: ${fmtMoney(dex?.volume24h || 0)} → V1h: ${fmtMoney(dex?.volume1h || 0)} → VI1h: ${fmtPct(vi1h)}`,
    `Price: ${dex?.priceUsd ? `$${dex.priceUsd.toFixed(6)}` : 'n/a'}`,
    '',
    `Futures: ${buildFuturesLinks(symbol)}`,
    '',
    `Trade bots: ${ca !== 'unknown' ? buildTradeBotsLinks(ca) : 'n/a'}`,
    '',
    addrCopyLine('CA', ca),
    '',
    addrCopyLine('User', wallet),
    '',
    `Period: ${escapeHtml(fmtGmt(firstTsMs))} - ${escapeHtml(fmtGmt(lastTsMs))}`,
    `Observed: ${escapeHtml(period)}`,
    `Tx: ${buildSolscanLink(rowSig)}`,
  ].join('\n');
}

function buildSetupStyleAlert(
  wallet: string,
  rowSig: string,
  cls: Classified,
  dex: DexInfo | null,
  tsIso: string,
  depositUsd: number,
  plan: DcaOpenPlan | null,
  operatorTrustLine: string | null,
): string {
  const ca = resolveAlertMint(cls, plan);
  const symbol = dex?.symbol || KNOWN_MINT_META[ca]?.symbol || (ca !== 'unknown' ? shortAddr(ca) : 'TOKEN');
  const isSwapExec = cls.setupSource === 'swap_exec_dca';
  const source =
    cls.setupSource === 'jupiter_dca'
      ? 'Jupiter DCA (OpenDcaV2)'
      : cls.setupSource === 'bot_dca'
        ? 'Bot DCA vault'
        : isSwapExec
          ? '⚡ Alt pipeline — Jupiter keeper DCA (NOT OpenDcaV2)'
          : 'DCA';
  const period = tsIso.replace('T', ' ').replace('Z', ' GMT');

  const swapOpen = isSwapExec && cls.swapExec?.openConfirmed;
  const headEmoji = swapOpen ? '🟢' : '🟡';
  const headSuffix = swapOpen ? ' (initiating tx detected)' : '';
  const lines = [
    `${headEmoji} NEW DCA OPEN${headSuffix} — ${setupHeadlineHtml(dex, ca)}`,
    '',
    `Source: ${escapeHtml(source)}`,
  ];

  if (isSwapExec && cls.swapExec && plan) {
    const cyc = plan.cycles;
    const cycleUsd = plan.cycleUsd > 0 ? plan.cycleUsd : plan.totalUsd / Math.max(1, cyc);
    const freq = plan.cycleFrequencySec;
    const se = cls.swapExec;
    lines.push(`Pipeline: <code>swap_exec_dca</code> (keeper-signed Jupiter route)`);

    if (swapOpen) {
      const hasFills = cyc > 0 && cycleUsd > 0;
      lines.push('', `FUNDED AT OPEN (real, on-chain):`);
      lines.push(
        `• Deposit: ${(se.depositSol ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL (~${fmtMoney(se.depositUsd ?? 0)})`,
      );
      if (hasFills) {
        const planned = se.plannedCycles && se.plannedCycles > cyc ? se.plannedCycles : cyc;
        const { perCyclePct, totalPct } = computePriceImpactEst(cycleUsd, planned, dex?.liquidityUsd || 0);
        const cadence = freq > 0 ? `every ~${freq}s` : `(interval forming)`;
        const eta = plan.etaSec > 0 ? ` · ETA ${fmtDuration(plan.etaSec)}` : '';
        lines.push(
          `• Buys ~${fmtMoney(cycleUsd)} per cycle ${cadence}`,
          `• Plan: ~${planned} cycles total · executed so far: ${cyc}${eta}`,
          `• Potential price change: ${fmtPctSigned(totalPct)} (${fmtPctSigned(perCyclePct)} per cycle)`,
        );
      } else {
        lines.push(`• Status: DCA just funded — buys starting (cadence pending first fills)`);
      }
      lines.push(`• Initiating tx: ${se.openSig ? buildSolscanLink(se.openSig) : 'n/a'}`);
      lines.push(
        '',
        addrCopyLine('Buyer (opener)', se.buyer || cls.swapExec.tokenRecipient),
        addrCopyLine('Order PDA', se.orderPda || 'n/a'),
        addrCopyLine('SOL funding vault', cls.swapExec.orderAccount),
        addrCopyLine('Executor / operator (signs)', cls.swapExec.executor),
      );
    } else {
      const { perCyclePct, totalPct } = computePriceImpactEst(cycleUsd, cyc, dex?.liquidityUsd || 0);
      lines.push(
        '',
        `OBSERVED (real, on-chain):`,
        `• ${cyc} buys × ~${fmtMoney(cycleUsd)} every ~${freq}s`,
        `• Accumulated so far: ${fmtMoney(plan.totalUsd)} over ${fmtDuration(plan.etaSec)}`,
        `• Price impact so far: ${fmtPctSigned(totalPct)} (${fmtPctSigned(perCyclePct)} per cycle)`,
        '',
        addrCopyLine('Buyer vault (accumulates coin)', cls.swapExec.tokenRecipient),
        addrCopyLine('SOL funding vault', cls.swapExec.orderAccount),
        addrCopyLine('Executor / keeper (signs)', cls.swapExec.executor),
      );
      const projCycles = swapExecEstCycles();
      if (projCycles > cyc) {
        lines.push(
          '',
          `<i>Projection if it keeps this pace (${projCycles} cycles est.): ` +
            `${fmtMoney(cycleUsd * projCycles)} total, ${fmtPctSigned(perCyclePct * projCycles)} impact</i>`,
        );
      }
    }
  } else {
    lines.push(`Deposit est.: ${fmtMoney(depositUsd)}`);
    if (plan && plan.cycles > 0 && plan.cycleFrequencySec > 0) {
      const cycleUsd = plan.cycleUsd > 0 ? plan.cycleUsd : plan.totalUsd / plan.cycles;
      const { perCyclePct, totalPct } = computePriceImpactEst(cycleUsd, plan.cycles, dex?.liquidityUsd || 0);
      lines.push(
        `Frequency: ${fmtMoney(cycleUsd)} every ${plan.cycleFrequencySec} seconds (${plan.cycles} cycles)`,
        `ETA: ${fmtDuration(plan.etaSec)}`,
        `Potential price change: ${fmtPctSigned(totalPct)} (${fmtPctSigned(perCyclePct)} per cycle)`,
      );
    }
  }

  if (operatorTrustLine) {
    lines.push('', operatorTrustLine);
  }
  if (isSwapExec) {
    lines.push('<i>Tap address to copy</i>');
  }

  lines.push(
    `Scores: 👍`,
    '',
    `MC: ${fmtMoney(dex?.marketCap || 0)} → LQ: ${fmtMoney(dex?.liquidityUsd || 0)}`,
    `V24h: ${fmtMoney(dex?.volume24h || 0)} → V1h: ${fmtMoney(dex?.volume1h || 0)}`,
    `Price: ${dex?.priceUsd ? `$${dex.priceUsd.toFixed(6)}` : 'n/a'}`,
    '',
    `Futures: ${buildFuturesLinks(symbol)}`,
    '',
    `Trade bots: ${ca !== 'unknown' ? buildTradeBotsLinks(ca) : 'n/a'}`,
    '',
    addrCopyLine('CA', ca),
  );

  // For swap_exec the buyer vault + keeper are already shown above; avoid a misleading "User" line.
  if (!isSwapExec) {
    lines.push('', addrCopyLine('User', wallet));
  }

  lines.push(
    '',
    `Observed: ${escapeHtml(period)}`,
    `Tx: ${buildSolscanLink(rowSig)}`,
  );

  return lines.join('\n');
}

function activeWallets(_st: WatchState): string[] {
  // Poll only explicit watchlist wallets. Discovery alerts on SETUP via program stream.
  return wallets();
}

/**
 * Poll bot operator co-signer feeds (e.g. trfb53) to catch DCA OPENS in real time.
 * DCA opens never touch the Jupiter swap program (only System/Token/ATA), so they are invisible
 * to the program-discovery stream; the operator co-signer is the only reliable real-time anchor.
 */
async function processOperatorOpens(operator: string, st: WatchState): Promise<void> {
  const rows = (await rpcCall<SignatureRow[]>('getSignaturesForAddress', [operator, { limit: discoverySigLimit() }], 5)) || [];
  if (rows.length === 0) return;
  const cursorKey = `op:${operator}`;
  const prevSeen = st.lastByWallet[cursorKey];
  const newest = rows[0]?.signature;

  for (const row of rows) {
    if (prevSeen && row.signature === prevSeen) break;
    if (isSeen(st, row.signature)) continue;

    const tx = await rpcCall<any>(
      'getTransaction',
      [row.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      5,
    );
    if (!tx) continue;

    const open = detectDcaOpen(tx);
    if (!open || !looksLikeMintAddress(open.targetMint)) {
      markSeen(st, row.signature);
      continue;
    }

    const sKey = swapExecSeriesKey(open.vault, open.targetMint);
    if (st.swapExecSeries[sKey]?.alerted) {
      markSeen(st, row.signature);
      continue;
    }

    const tsMs = row.blockTime ? row.blockTime * 1000 : Date.now();
    const dex = await fetchDexInfo(open.targetMint);
    const solPx = solUsdPrice(dex);
    const depositUsd = open.depositSol * solPx;

    // Measure the real cadence + per-cycle size from fills already executed on this vault.
    const vaultInfo = await resolveSwapExecOpen(open.vault);
    const cycleUsd = vaultInfo && vaultInfo.cycleSol > 0 ? vaultInfo.cycleSol * solPx : 0;
    const freqSec = vaultInfo?.medianFreqSec || 0;
    const fillsDone = vaultInfo?.fillCount || 0;
    const plannedCycles = cycleUsd > 0 ? Math.max(fillsDone, Math.round(depositUsd / cycleUsd)) : 0;
    const etaSec = freqSec > 0 && plannedCycles > 0 ? freqSec * Math.max(0, plannedCycles - fillsDone) : 0;

    const cls: Classified = {
      kind: 'SETUP',
      setupSource: 'swap_exec_dca',
      programs: [],
      orderId: '',
      amountInRaw: '',
      amountOutRaw: '',
      blockTime: row.blockTime,
      mint: open.targetMint,
      swapExec: {
        executor: operator,
        orderAccount: open.vault,
        tokenRecipient: open.buyer,
        openConfirmed: true,
        openSig: row.signature,
        orderPda: open.orderPda,
        buyer: open.buyer,
        depositSol: open.depositSol,
        depositUsd,
        plannedCycles: plannedCycles || undefined,
      },
    };
    const plan: DcaOpenPlan = {
      inputMint: SOL_MINT,
      outputMint: open.targetMint,
      inAmountRaw: 0n,
      inAmountPerCycleRaw: 0n,
      cycleFrequencySec: freqSec,
      cycles: fillsDone,
      cycleUsd,
      totalUsd: depositUsd,
      etaSec,
    };
    const ts = row.blockTime
      ? new Date(row.blockTime * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z')
      : 'n/a';
    const operatorStats = formatOperatorTrustLine(await fetchDcaOperatorStats(open.buyer));
    const text = buildSetupStyleAlert(open.buyer, row.signature, cls, dex, ts, depositUsd, plan, operatorStats);

    const sent = await sendTelegramAlert(text);
    if (sent) {
      st.swapExecSeries[sKey] = {
        tokenRecipient: open.buyer,
        mint: open.targetMint,
        executor: operator,
        solVault: open.vault,
        firstTsMs: tsMs,
        lastTsMs: tsMs,
        cycles: fillsDone,
        totalUsd: cycleUsd * fillsDone,
        lastCycleUsd: cycleUsd,
        freqSec,
        tsHistory: [],
        alerted: true,
        openResolved: true,
        openConfirmed: true,
        openSig: row.signature,
        orderPda: open.orderPda,
        buyer: open.buyer,
        depositSol: open.depositSol,
        depositUsd,
        plannedCycles: plannedCycles || undefined,
        openTsMs: tsMs,
      };
      registerDiscoveredWallet(st, open.buyer);
      await recordDcaOpen({
        operatorWallet: open.buyer,
        mint: open.targetMint,
        source: 'swap_exec_dca',
        openSig: row.signature,
        openTsMs: tsMs,
        plannedCycles,
        plannedCycleUsd: cycleUsd,
        plannedTotalUsd: depositUsd,
        cycleFreqSec: freqSec,
        seriesKey: sKey,
      });
      console.log('[dca-watch] alert sent', { kind: 'OPEN', source: 'operator_open', sig: row.signature.slice(0, 12) });
    }
    markSeen(st, row.signature);
  }

  if (newest) st.lastByWallet[cursorKey] = newest;
}

function extractSignerWallet(tx: any): string | null {
  const keys = tx?.transaction?.message?.accountKeys || [];
  for (const k of keys) {
    const signer = Boolean(k?.signer);
    const pubkey = String(k?.pubkey || '');
    if (signer && pubkey.length > 20) return pubkey;
  }
  return null;
}

function resolveOperatorWallet(cls: Classified, wallet: string): string {
  if (cls.setupSource === 'swap_exec_dca' && cls.swapExec?.executor) return cls.swapExec.executor;
  return wallet;
}

function swapExecSeriesKeyFromCls(cls: Classified, mint: string): string | undefined {
  if (!cls.swapExec) return undefined;
  return `${cls.swapExec.tokenRecipient}|${mint}`;
}

async function ingestDcaOperatorEvent(
  cls: Classified,
  row: SignatureRow,
  wallet: string,
  plan: DcaOpenPlan | null,
  extras?: { seriesKey?: string; fillUsd?: number },
): Promise<void> {
  const operator = resolveOperatorWallet(cls, wallet);
  if (!operator) return;
  const tsMs = row.blockTime ? row.blockTime * 1000 : Date.now();
  const mint = resolveAlertMint(cls, plan);
  const source = cls.setupSource || 'unknown';

  if (cls.kind === 'SETUP' && plan && looksLikeMintAddress(mint)) {
    await recordDcaOpen({
      operatorWallet: operator,
      mint,
      source,
      openSig: row.signature,
      openTsMs: tsMs,
      plannedCycles: plan.cycles,
      plannedCycleUsd: planCycleUsd(plan),
      plannedTotalUsd: plan.totalUsd,
      cycleFreqSec: plan.cycleFrequencySec,
      orderId: cls.orderId || undefined,
      seriesKey: extras?.seriesKey || swapExecSeriesKeyFromCls(cls, mint),
    });
    return;
  }

  if (cls.kind === 'BUY_EXEC') {
    await recordDcaFill({
      operatorWallet: operator,
      mint: looksLikeMintAddress(mint) ? mint : cls.mint,
      orderId: cls.orderId || undefined,
      seriesKey: extras?.seriesKey,
      fillUsd: extras?.fillUsd ?? estimateBuyUsd(cls.amountInRaw, null),
      eventTsMs: tsMs,
    });
    return;
  }

  if (cls.kind === 'CLOSE') {
    await recordDcaClose({
      operatorWallet: operator,
      mint: looksLikeMintAddress(mint) ? mint : cls.mint,
      orderId: cls.orderId || undefined,
      seriesKey: extras?.seriesKey,
      closeSig: row.signature,
      eventTsMs: tsMs,
    });
  }
}

async function trackProgramOperatorTx(tx: any, row: SignatureRow): Promise<void> {
  const rawCls = classifyTx(tx);
  if (rawCls.kind === 'OTHER') return;
  const signer = extractSignerWallet(tx);
  if (!signer) return;

  let plan: DcaOpenPlan | null = null;
  if (rawCls.kind === 'SETUP') {
    plan = parseJupiterOpenDcaV2(tx, null);
    if (!plan) plan = resolveSetupPlan(tx, rawCls, null, 0);
  }
  await ingestDcaOperatorEvent(rawCls, row, signer, plan);
}

async function handleTransaction(
  st: WatchState,
  wallet: string,
  row: SignatureRow,
  tx: any,
  opts?: { walletScoped?: boolean; classified?: Classified; setupPlan?: DcaOpenPlan | null; setupDepositUsd?: number },
): Promise<boolean> {
  if (isSeen(st, row.signature)) return false;

  const cls = opts?.classified ?? classifyTx(tx, { walletScoped: opts?.walletScoped });
  if (cls.kind === 'OTHER') {
    markSeen(st, row.signature);
    return false;
  }
  if (!shouldAlert(cls.kind, wallet)) {
    markSeen(st, row.signature);
    return false;
  }

  const minSetupUsd = setupMinUsd();
  let setupDex: DexInfo | null = null;
  let setupDepositUsd = 0;
  let setupPlan: DcaOpenPlan | null = null;
  if (cls.kind === 'SETUP') {
    const planPreview = parseJupiterOpenDcaV2(tx, null);
    const alertMint = planPreview?.outputMint || resolveAlertMint(cls, planPreview);
    setupDex = await fetchDexInfo(alertMint);
    setupDepositUsd = opts?.setupDepositUsd ?? estimateSetupDepositUsd(tx, wallet, cls, setupDex);
    setupPlan = opts?.setupPlan ?? resolveSetupPlan(tx, cls, setupDex, setupDepositUsd);
    if (!setupPassesCycleInterestFilter(setupPlan)) {
      const cycleUsd = setupPlan ? planCycleUsd(setupPlan) : 0;
      console.log('[dca-watch] skip SETUP cycle_filter', {
        sig: row.signature.slice(0, 12),
        cycleUsd: cycleUsd > 0 ? Math.round(cycleUsd) : 0,
        totalUsd: setupPlan?.totalUsd ? Math.round(setupPlan.totalUsd) : 0,
        cycles: setupPlan?.cycles || 0,
        source: cls.setupSource || 'unknown',
      });
      markSeen(st, row.signature);
      return false;
    }
    const filterUsd = Math.max(setupDepositUsd, setupPlan?.totalUsd || 0);
    if (minSetupUsd > 0 && filterUsd < minSetupUsd) {
      markSeen(st, row.signature);
      return false;
    }
    if (cls.setupSource !== 'swap_exec_dca') {
      await ingestDcaOperatorEvent(cls, row, wallet, setupPlan);
    }
  } else if (cls.kind === 'BUY_EXEC' || cls.kind === 'CLOSE') {
    await ingestDcaOperatorEvent(cls, row, wallet, null);
  }

  const operatorWallet = resolveOperatorWallet(cls, wallet);
  const operatorStats =
    cls.kind === 'SETUP' ? formatOperatorTrustLine(await fetchDcaOperatorStats(operatorWallet)) : null;

  const ts = cls.blockTime
    ? new Date(cls.blockTime * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z')
    : 'n/a';

  let alertText = '';
  if (cls.kind === 'BUY_EXEC') {
    const dex = await fetchDexInfo(resolveAlertMint(cls, null));
    alertText = buildBuyStyleAlert(st, wallet, row.signature, cls, dex, ts);
  } else if (cls.kind === 'SETUP') {
    alertText = buildSetupStyleAlert(
      wallet,
      row.signature,
      cls,
      setupDex,
      ts,
      setupDepositUsd,
      setupPlan,
      operatorStats,
    );
  } else {
    const programTag = cls.programs.length > 0 ? cls.programs.map(shortAddr).join(',') : 'none';
    const parts = [
      `${kindEmoji(cls.kind)} DCA ${cls.kind}`,
      addrCopyLine('wallet', wallet),
      `time: ${escapeHtml(ts)}`,
      addrCopyLine('sig', row.signature),
      `programs: ${escapeHtml(programTag)}`,
    ];
    if (cls.orderId) parts.push(`order_id: ${tgCopyLink(cls.orderId, cls.orderId)}`);
    if (cls.amountInRaw) parts.push(`amount_in_raw: ${escapeHtml(cls.amountInRaw)}`);
    if (cls.amountOutRaw) parts.push(`amount_out_raw: ${escapeHtml(cls.amountOutRaw)}`);
    if (cls.mint) parts.push(addrCopyLine('mint', cls.mint));
    parts.push(buildSolscanLink(row.signature));
    alertText = parts.join('\n');
  }
  const sent = await sendTelegramAlert(alertText);
  if (sent) {
    console.log('[dca-watch] alert sent', {
      kind: cls.kind,
      sig: row.signature.slice(0, 12),
      wallet: shortAddr(wallet),
      source: cls.setupSource || 'unknown',
    });
    markSeen(st, row.signature);
    return true;
  }
  console.warn('[dca-watch] alert NOT sent (will retry)', { kind: cls.kind, sig: row.signature.slice(0, 12) });
  return false;
}

async function processWallet(wallet: string, st: WatchState): Promise<void> {
  const rows =
    (await rpcCall<SignatureRow[]>('getSignaturesForAddress', [wallet, { limit: sigLimit() }], 5)) || [];
  if (rows.length === 0) return;

  const latest = rows[0]?.signature;
  if (!latest) return;

  const prevSeen = st.lastByWallet[wallet];
  if (!prevSeen) {
    st.lastByWallet[wallet] = latest;
    console.log('[dca-watch] bootstrap cursor for', wallet);
    return;
  }

  const newRows: SignatureRow[] = [];
  for (const row of rows) {
    if (row.signature === prevSeen) break;
    newRows.push(row);
  }
  st.lastByWallet[wallet] = latest;

  // oldest first
  newRows.reverse();
  for (const row of newRows) {
    const tx = await rpcCall<any>(
      'getTransaction',
      [row.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      6,
    );
    if (!tx) continue;

    await handleTransaction(st, wallet, row, tx, { walletScoped: true });
    await sleep(150);
  }
}

async function fetchProgramSignatureBatch(
  program: string,
  prevSeen: string | undefined,
): Promise<{ latest: string | undefined; newRows: SignatureRow[]; cursorGap: boolean }> {
  const pageLimit = discoverySigLimit();
  const newRows: SignatureRow[] = [];
  let latest: string | undefined;
  let before: string | undefined;
  let cursorGap = false;

  for (let page = 0; page < discoveryMaxPages(); page++) {
    const opts: Record<string, unknown> = { limit: pageLimit };
    if (before) opts.before = before;
    const rows = (await rpcCall<SignatureRow[]>('getSignaturesForAddress', [program, opts], 5)) || [];
    if (rows.length === 0) break;
    if (!latest) latest = rows[0]?.signature;

    for (const row of rows) {
      if (prevSeen && row.signature === prevSeen) {
        return { latest, newRows, cursorGap: false };
      }
      newRows.push(row);
    }

    if (rows.length < pageLimit) break;
    before = rows[rows.length - 1]?.signature;
  }

  if (prevSeen && newRows.length > 0) {
    cursorGap = true;
    console.warn('[dca-watch] program cursor gap', { program: shortAddr(program), missedWindow: newRows.length });
  }
  return { latest, newRows, cursorGap };
}

async function processProgram(program: string, st: WatchState): Promise<void> {
  const prevSeen = st.lastByProgram[program];
  const { latest, newRows, cursorGap } = await fetchProgramSignatureBatch(program, prevSeen);
  if (!latest || newRows.length === 0) {
    if (!prevSeen) st.lastByProgram[program] = latest || prevSeen;
    return;
  }

  st.lastByProgram[program] = latest;
  if (cursorGap) {
    // Avoid re-alerting a huge backlog; only scan recent SETUP candidates.
    newRows.splice(0, Math.max(0, newRows.length - discoverySigLimit()));
  }

  newRows.reverse();
  for (const row of newRows) {
    if (isSeen(st, row.signature)) continue;
    const tx = await rpcCall<any>(
      'getTransaction',
      [row.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      6,
    );
    if (!tx) continue;

    const skipGenericTrack = program === JUPITER_SWAP_PROGRAM && swapExecPipelineEnabled();
    if (!skipGenericTrack) {
      await trackProgramOperatorTx(tx, row);
    }

    if (program === JUPITER_SWAP_PROGRAM && swapExecPipelineEnabled()) {
      const handled = await processSwapExecTx(st, row, tx);
      if (handled) {
        await sleep(250);
        continue;
      }
    }

    const cls = classifyProgramTx(program, tx, st);
    if (cls.kind !== 'SETUP') {
      markSeen(st, row.signature);
      continue;
    }
    if (cls.setupSource === 'jupiter_dca' && cls.orderId && !rememberOrderId(st, cls.orderId)) {
      markSeen(st, row.signature);
      continue;
    }
    const signer = extractSignerWallet(tx);
    if (!signer) {
      markSeen(st, row.signature);
      continue;
    }
    registerDiscoveredWallet(st, signer);
    await handleTransaction(st, signer, row, tx);
    await sleep(250);
  }
}

async function cycle(st: WatchState): Promise<void> {
  gcState(st);
  await refreshSolUsd();
  if (swapExecPipelineEnabled()) {
    for (const op of dcaOperators()) {
      await processOperatorOpens(op, st);
      await sleep(120);
    }
  }
  if (discoveryEnabled()) {
    for (const p of discoveryPrograms()) {
      await processProgram(p, st);
      await sleep(120);
    }
  }
  for (const w of activeWallets(st)) {
    await processWallet(w, st);
    await sleep(120);
  }
}

async function main(): Promise<void> {
  loadEnv();
  if (!rpcUrl()) {
    throw new Error('DCA watcher: set DCA_WATCH_RPC_URL or SA_RPC_HTTP_URL/SA_RPC_URL');
  }
  if (!tgToken() || !tgChatId()) {
    throw new Error('DCA watcher: set DCA_WATCH_TELEGRAM_BOT_TOKEN/CHAT_ID or TELEGRAM_BOT_TOKEN/CHAT_ID');
  }

  const once = process.argv.includes('--once');
  await ensureDcaOperatorTables();
  const st = readState();
  await cycle(st);
  writeState(st);
  if (once) return;

  console.log('[dca-watch] started', {
    mode: discoveryEnabled() ? 'network-discovery' : 'wallet-only',
    discoveryPrograms: discoveryPrograms().length,
    optionalWallets: wallets().length,
    swapExecPipeline: swapExecPipelineEnabled(),
    swapExecMinCycleUsd: swapExecMinCycleUsd(),
    cycleFilter: {
      smallUsd: cycleTierSmallUsd(),
      smallMinCycles: cycleTierSmallMinCycles(),
      largeUsd: cycleTierLargeUsd(),
      largeMinCycles: cycleTierLargeMinCycles(),
      largeMaxCycles: cycleTierSmallMinCycles() - 1,
    },
    pollMs: pollMs(),
    discoverySigLimit: discoverySigLimit(),
    discoveryMaxPages: discoveryMaxPages(),
  });
  while (true) {
    await sleep(pollMs());
    await cycle(st);
    writeState(st);
  }
}

main().catch((e) => {
  console.error('[dca-watch] failed:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
