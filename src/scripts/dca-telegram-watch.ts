import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

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
};

function loadEnv(): void {
  const candidates = ['.env', '.env.local'];
  for (const file of candidates) {
    const abs = path.resolve(process.cwd(), file);
    if (fs.existsSync(abs)) dotenv.config({ path: abs, override: false });
  }
}

const WATCH_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
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
  const csv =
    process.env.DCA_WATCH_WALLETS?.trim() ||
    'trfb53BmkHNeoqaa3REgqnrbwUZqAFYdjTkivkJ6aWg,G5ZGRWwFRYUi5PL1fXXTktfdysRxTaYeDeoG4UM5jMba';
  return Array.from(new Set(csv.split(',').map((s) => s.trim()).filter(Boolean)));
}

function discoveryEnabled(): boolean {
  return process.env.DCA_WATCH_DISCOVERY_ENABLED === '1';
}

function maxDiscoveredWallets(): number {
  const n = Number(process.env.DCA_WATCH_MAX_DISCOVERED_WALLETS || 50);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

function discoveryPrograms(): string[] {
  const csv =
    process.env.DCA_WATCH_DISCOVERY_PROGRAMS?.trim() ||
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4,proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u,DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH';
  return Array.from(new Set(csv.split(',').map((s) => s.trim()).filter(Boolean)));
}

function discoverySigLimit(): number {
  const n = Number(process.env.DCA_WATCH_DISCOVERY_SIGNATURE_LIMIT || 25);
  if (!Number.isFinite(n)) return 25;
  return Math.max(10, Math.min(100, Math.floor(n)));
}

function discoveredWalletTtlMs(): number {
  const n = Number(process.env.DCA_WATCH_DISCOVERED_WALLET_TTL_MS || 7 * 24 * 3600 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 7 * 24 * 3600 * 1000;
}

function seenSigTtlMs(): number {
  const n = Number(process.env.DCA_WATCH_SEEN_SIG_TTL_MS || 24 * 3600 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 24 * 3600 * 1000;
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
        discoveredWallets: parsed.discoveredWallets || {},
        buySeries: parsed.buySeries || {},
      };
    }
  } catch {
    // ignore
  }
  return { lastByWallet: {}, lastByProgram: {}, seenSignatures: {}, discoveredWallets: {}, buySeries: {} };
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

  for (const [sig, ts] of Object.entries(st.seenSignatures)) {
    if (!Number.isFinite(ts) || ts < sigCutoff) delete st.seenSignatures[sig];
  }
  for (const [w, ts] of Object.entries(st.discoveredWallets)) {
    if (!Number.isFinite(ts) || ts < walletCutoff) delete st.discoveredWallets[w];
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
  programs: string[];
  orderId: string;
  amountInRaw: string;
  amountOutRaw: string;
  blockTime?: number;
  mint?: string;
  walletTokenDelta?: number;
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

function isDcaSetup(tx: any, logsLower: string): boolean {
  const types = instructionTypes(tx);
  const hasSeedVault = types.includes('createAccountWithSeed');
  const hasSyncNative = types.includes('syncNative');
  const hasOrder = logsLower.includes('order_id:');
  // Real DCA open = seed vault + WSOL sync; order_id is a strong extra signal.
  return hasSeedVault && hasSyncNative && (hasOrder || types.includes('createIdempotent'));
}

function isDcaBuyExec(logsLower: string, orderId: string): boolean {
  // Regular Jupiter swaps often log order_id/SwapTob; DCA buy cycles use BuyExactQuoteIn + order_id.
  return Boolean(orderId) && logsLower.includes('buyexactquotein');
}

function isDcaClose(tx: any, logsLower: string, orderId: string): boolean {
  const types = instructionTypes(tx);
  return types.includes('closeAccount') && Boolean(orderId || logsLower.includes('order_id:'));
}

function classifyTx(tx: any): Classified {
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

  if (isDcaSetup(tx, logsLower)) return { kind: 'SETUP', ...base };
  if (isDcaBuyExec(logsLower, orderId)) return { kind: 'BUY_EXEC', ...base };
  if (isDcaClose(tx, logsLower, orderId)) return { kind: 'CLOSE', ...base };
  return { kind: 'OTHER', ...base };
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

async function sendTelegramAlert(text: string): Promise<void> {
  const token = tgToken();
  const chatId = tgChatId();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: `[ALERT][dca_watch]\n${text}`,
    disable_web_page_preview: true,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[dca-watch] telegram non-2xx', res.status, body.slice(0, 300));
    }
  } catch (e) {
    console.warn('[dca-watch] telegram send failed', e instanceof Error ? e.message : String(e));
  }
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

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

async function fetchDexInfo(mint?: string): Promise<DexInfo | null> {
  if (!mint) return null;
  const now = Date.now();
  const cached = dexCache.get(mint);
  if (cached && now - cached.at < 90_000) return cached.val;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!r.ok) {
      dexCache.set(mint, { at: now, val: null });
      return null;
    }
    const j = (await r.json()) as { pairs?: any[] };
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    if (pairs.length === 0) {
      dexCache.set(mint, { at: now, val: null });
      return null;
    }
    let best = pairs[0];
    let bestLiq = toNum(best?.liquidity?.usd);
    for (const p of pairs) {
      const liq = toNum(p?.liquidity?.usd);
      if (liq > bestLiq) {
        best = p;
        bestLiq = liq;
      }
    }
    const info: DexInfo = {
      symbol: String(best?.baseToken?.symbol || '').toUpperCase() || mint.slice(0, 6),
      name: String(best?.baseToken?.name || ''),
      priceUsd: toNum(best?.priceUsd),
      marketCap: toNum(best?.marketCap || best?.fdv),
      liquidityUsd: toNum(best?.liquidity?.usd),
      volume24h: toNum(best?.volume?.h24),
      volume1h: toNum(best?.volume?.h1),
    };
    dexCache.set(mint, { at: now, val: info });
    return info;
  } catch {
    dexCache.set(mint, { at: now, val: null });
    return null;
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

function shortTag(v: string): string {
  return v.length > 10 ? v.slice(-10) : v;
}

function buildFuturesLinks(symbol: string): string {
  const s = symbol.toUpperCase();
  return `MEXC (https://futures.mexc.com/exchange/${s}_USDT?inviteCode=1RTNH) Bitget (https://www.bitget.com/futures/usdt/${s}USDT) Gate (https://www.gate.io/futures/USDT/${s}_USDT?ref=VLMQUL9YCA)`;
}

function buildTradeBotsLinks(ca: string): string {
  return [
    `BLX (https://bullx.io/terminal?chainId=1399811149&address=${ca}&r=60VRMB61VY9)`,
    `PHO (https://photon-sol.tinyastro.io/en/r/@DCATracker/${ca})`,
    `PEP (https://t.me/pepeboost_sol_bot?start=ref_08lk65_ca_${ca})`,
    `STB (https://t.me/SolTradingBot?start=${ca}-FVkcHcHsU)`,
    `TRO (https://t.me/paris_trojanbot?start=d-clear_account-${ca})`,
    `BLO (https://t.me/BloomSolana_bot?start=ref_KA81EL4RQE_ca_${ca})`,
    `BNK (https://t.me/furiosa_bonkbot?start=ref_3n3v3_ca_${ca})`,
  ].join(' - ');
}

function estimateBuyUsd(amountInRaw: string, dex: DexInfo | null): number {
  const raw = Number(amountInRaw || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const sol = raw / 1_000_000_000;
  const solUsd = Number(process.env.DCA_WATCH_SOL_USD || 165);
  if (dex?.symbol === 'SOL' && dex.priceUsd > 0) return sol * dex.priceUsd;
  return sol * solUsd;
}

function buildBuyStyleAlert(
  st: WatchState,
  wallet: string,
  rowSig: string,
  cls: Classified,
  dex: DexInfo | null,
  tsIso: string,
): string {
  const ca = cls.mint || 'unknown';
  const symbol = dex?.symbol || (ca !== 'unknown' ? ca.slice(0, 6) : 'TOKEN');
  const buyUsd = estimateBuyUsd(cls.amountInRaw, dex);
  const liq = dex?.liquidityUsd || 0;
  const impact = liq > 0 && buyUsd > 0 ? (buyUsd / liq) * 100 : NaN;
  const perCycle = Number.isFinite(impact) ? impact / 100 : NaN;
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
  const targetCycles = Number(process.env.DCA_WATCH_TARGET_CYCLES || 100);
  const etaSec = Number.isFinite(observedFreqSec) && targetCycles > cycles ? (targetCycles - cycles) * observedFreqSec : Number.NaN;

  return [
    `${fmtMoney(buyUsd)} buying ${symbol} 🟩`,
    '',
    `Frequency: ${fmtMoney(buyUsd)} every ${Number.isFinite(observedFreqSec) ? observedFreqSec : 'n/a'} seconds (${cycles} cycles${order !== 'n/a' ? `, order ${order}` : ''})`,
    `ETA: ${fmtDuration(etaSec)}`,
    `Scores: 👍`,
    `Potential price change: ${fmtPct(impact)} (${fmtPct(perCycle)} per cycle)`,
    '',
    `MC: ${fmtMoney(dex?.marketCap || 0)} → LQ: ${fmtMoney(dex?.liquidityUsd || 0)}`,
    `V24h: ${fmtMoney(dex?.volume24h || 0)} → V1h: ${fmtMoney(dex?.volume1h || 0)} → VI1h: ${fmtPct(vi1h)}`,
    `Price: ${dex?.priceUsd ? `$${dex.priceUsd.toFixed(6)}` : 'n/a'}`,
    '',
    `Futures: ${buildFuturesLinks(symbol)}`,
    '',
    `Trade bots: ${ca !== 'unknown' ? buildTradeBotsLinks(ca) : 'n/a'}`,
    '',
    `CA: ${ca}`,
    `#${ca !== 'unknown' ? shortTag(ca) : 'unknown'}`,
    '',
    `User: ${wallet}`,
    `#${shortTag(wallet)}`,
    '',
    `Period: ${fmtGmt(firstTsMs)} - ${fmtGmt(lastTsMs)}`,
    `Observed: ${period}`,
    `Tx: https://solscan.io/tx/${rowSig}`,
  ].join('\n');
}

function activeWallets(_st: WatchState): string[] {
  // Poll only explicit watchlist wallets. Discovery alerts on SETUP via program stream.
  return wallets();
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

async function handleTransaction(
  st: WatchState,
  wallet: string,
  row: SignatureRow,
  tx: any,
): Promise<void> {
  if (isSeen(st, row.signature)) return;

  const cls = classifyTx(tx);
  if (cls.kind === 'OTHER') {
    markSeen(st, row.signature);
    return;
  }
  if (!shouldAlert(cls.kind, wallet)) {
    markSeen(st, row.signature);
    return;
  }

  const ts = cls.blockTime
    ? new Date(cls.blockTime * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z')
    : 'n/a';

  let alertText = '';
  if (cls.kind === 'BUY_EXEC') {
    const dex = await fetchDexInfo(cls.mint);
    alertText = buildBuyStyleAlert(st, wallet, row.signature, cls, dex, ts);
  } else {
    const programTag = cls.programs.length > 0 ? cls.programs.map(shortAddr).join(',') : 'none';
    const parts = [
      `${kindEmoji(cls.kind)} DCA ${cls.kind}`,
      `wallet: ${shortAddr(wallet)}`,
      `time: ${ts}`,
      `sig: ${row.signature}`,
      `programs: ${programTag}`,
    ];
    if (cls.orderId) parts.push(`order_id: ${cls.orderId}`);
    if (cls.amountInRaw) parts.push(`amount_in_raw: ${cls.amountInRaw}`);
    if (cls.amountOutRaw) parts.push(`amount_out_raw: ${cls.amountOutRaw}`);
    if (cls.mint) parts.push(`mint: ${cls.mint}`);
    parts.push(`https://solscan.io/tx/${row.signature}`);
    alertText = parts.join('\n');
  }
  await sendTelegramAlert(alertText);
  markSeen(st, row.signature);
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

    await handleTransaction(st, wallet, row, tx);
    await sleep(150);
  }
}

async function processProgram(program: string, st: WatchState): Promise<void> {
  const rows =
    (await rpcCall<SignatureRow[]>('getSignaturesForAddress', [program, { limit: discoverySigLimit() }], 5)) || [];
  if (rows.length === 0) return;

  const latest = rows[0]?.signature;
  if (!latest) return;

  const prevSeen = st.lastByProgram[program];
  if (!prevSeen) {
    st.lastByProgram[program] = latest;
    return;
  }

  const newRows: SignatureRow[] = [];
  for (const row of rows) {
    if (row.signature === prevSeen) break;
    newRows.push(row);
  }
  st.lastByProgram[program] = latest;

  newRows.reverse();
  for (const row of newRows) {
    if (isSeen(st, row.signature)) continue;
    const tx = await rpcCall<any>(
      'getTransaction',
      [row.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      6,
    );
    if (!tx) continue;
    const cls = classifyTx(tx);
    if (cls.kind !== 'SETUP') {
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
  const st = readState();
  await cycle(st);
  writeState(st);
  if (once) return;

  console.log('[dca-watch] started', { wallets: wallets().length, pollMs: pollMs() });
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
