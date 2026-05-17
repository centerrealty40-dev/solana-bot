/**
 * Общий дедуп для канала pullback + retrace (один chat_id, два PM2-процесса).
 * Ключ: mint + минута пика — не дублировать meteora/pumpswap и [MARKET] vs [RETRACE].
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DEDUPE_REL = 'data/live/telegram-retrace-pullback-dedupe.json';
const STORE_TTL_MS = 6 * 60 * 60_000;

type DedupeEntry = {
  peakMin: number;
  sentAtMs: number;
  source: 'pullback' | 'retrace';
};

type DedupeStore = Record<string, DedupeEntry>;

function dedupeFilePath(): string {
  return path.join(process.cwd(), DEDUPE_REL);
}

/** Один откат на mint: пик в пределах одной минуты = то же событие. */
export function retracePullbackChannelEventKey(mint: string, peakTs: Date): string {
  const peakMin = Math.floor(peakTs.getTime() / 60_000);
  return `${mint.trim()}|${peakMin}`;
}

function pruneStore(store: DedupeStore, nowMs: number): void {
  const cut = nowMs - STORE_TTL_MS;
  for (const [k, v] of Object.entries(store)) {
    if (v.sentAtMs < cut) delete store[k];
  }
}

async function readStore(): Promise<DedupeStore> {
  try {
    const raw = await fs.readFile(dedupeFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as DedupeStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStore(store: DedupeStore): Promise<void> {
  const file = dedupeFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  pruneStore(store, Date.now());
  await fs.writeFile(file, `${JSON.stringify(store)}\n`, 'utf8');
}

export async function isRetracePullbackChannelDuplicate(
  mint: string,
  peakTs: Date,
): Promise<boolean> {
  const key = retracePullbackChannelEventKey(mint, peakTs);
  const store = await readStore();
  return store[key] != null;
}

export async function recordRetracePullbackChannelSent(
  mint: string,
  peakTs: Date,
  source: 'pullback' | 'retrace',
): Promise<void> {
  const key = retracePullbackChannelEventKey(mint, peakTs);
  const store = await readStore();
  store[key] = {
    peakMin: Math.floor(peakTs.getTime() / 60_000),
    sentAtMs: Date.now(),
    source,
  };
  await writeStore(store);
}
