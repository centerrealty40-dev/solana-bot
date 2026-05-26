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

const BUY_MARKERS = ['buyexactquotein', 'swaptob', 'order_id:'];

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readState(): WatchState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as WatchState;
    if (parsed && parsed.lastByWallet && typeof parsed.lastByWallet === 'object') return parsed;
  } catch {
    // ignore
  }
  return { lastByWallet: {} };
}

function writeState(next: WatchState): void {
  const p = statePath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, p);
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
};

function classifyTx(tx: any): Classified {
  const instructions = tx?.transaction?.message?.instructions || [];
  const logsArr = tx?.meta?.logMessages || [];
  const logs = Array.isArray(logsArr) ? logsArr.join('\n') : '';
  const logsLower = logs.toLowerCase();

  const programs: string[] = [];
  for (const ins of instructions) {
    const pid = ins?.programId || ins?.program;
    if (typeof pid === 'string' && WATCH_PROGRAMS.has(pid) && !programs.includes(pid)) programs.push(pid);
  }

  const hasBuy = BUY_MARKERS.some((m) => logsLower.includes(m));
  const hasSetup = instructions.some((ins: any) =>
    ['createAccountWithSeed', 'createIdempotent', 'syncNative'].includes(ins?.parsed?.type),
  );
  const hasClose = instructions.some((ins: any) => ins?.parsed?.type === 'closeAccount');

  const { amountInRaw, amountOutRaw } = extractAmountInOut(logs);
  const orderId = extractOrderId(logs);

  if (hasBuy) return { kind: 'BUY_EXEC', programs, orderId, amountInRaw, amountOutRaw, blockTime: tx?.blockTime };
  if (hasSetup) return { kind: 'SETUP', programs, orderId, amountInRaw, amountOutRaw, blockTime: tx?.blockTime };
  if (hasClose) return { kind: 'CLOSE', programs, orderId, amountInRaw, amountOutRaw, blockTime: tx?.blockTime };
  return { kind: 'OTHER', programs, orderId, amountInRaw, amountOutRaw, blockTime: tx?.blockTime };
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

    const cls = classifyTx(tx);
    if (cls.kind === 'OTHER') continue;

    const ts = cls.blockTime
      ? new Date(cls.blockTime * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z')
      : 'n/a';
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
    parts.push(`https://solscan.io/tx/${row.signature}`);

    await sendTelegramAlert(parts.join('\n'));
    await sleep(150);
  }
}

async function cycle(st: WatchState): Promise<void> {
  for (const w of wallets()) {
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
