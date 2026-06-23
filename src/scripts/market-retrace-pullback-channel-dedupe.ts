/**
 * Общий дедуп для канала pullback + retrace (один chat_id, два PM2-процесса).
 * Ключ: mint + bucket пика (по умолчанию 15 мин) — meteora/pumpswap с пиком 14:37 и 14:38 = одно событие.
 * Запись в store под file-lock — без гонки pullback vs retrace.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEDUPE_REL = 'data/live/telegram-retrace-pullback-dedupe.json';
const LOCK_REL = 'data/live/telegram-retrace-pullback-dedupe.lock';
const STORE_TTL_MS = 6 * 60 * 60_000;

/** Окно пика (мин): разные DEX часто дают пик ±1 мин — один алерт на mint. */
const PEAK_BUCKET_MINUTES = Math.max(
  1,
  Math.min(
    60,
    Math.floor(
      Number(process.env.RETRACE_PULLBACK_CHANNEL_DEDUPE_PEAK_BUCKET_MIN ?? '15') || 15,
    ),
  ),
);

export type RetracePullbackChannelDedupeEntry = {
  peakBucket: number;
  sentAtMs: number;
  source: 'pullback' | 'retrace';
};

type DedupeStore = Record<string, RetracePullbackChannelDedupeEntry>;

function dedupeFilePath(): string {
  return path.join(process.cwd(), DEDUPE_REL);
}

function lockFilePath(): string {
  return path.join(process.cwd(), LOCK_REL);
}

export function peakBucketIndex(peakTs: Date): number {
  return Math.floor(peakTs.getTime() / (PEAK_BUCKET_MINUTES * 60_000));
}

/** Один откат на mint в пределах PEAK_BUCKET_MINUTES. */
export function retracePullbackChannelEventKey(mint: string, peakTs: Date): string {
  return `${mint.trim()}|${peakBucketIndex(peakTs)}`;
}

function pruneStore(store: DedupeStore, nowMs: number): void {
  const cut = nowMs - STORE_TTL_MS;
  for (const [k, v] of Object.entries(store)) {
    if (v.sentAtMs < cut) delete store[k];
  }
}

function readStoreSync(): DedupeStore {
  try {
    const raw = fs.readFileSync(dedupeFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as DedupeStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Read-only snapshot of channel send dedupe (pullback + retrace watchers). */
export function readRetracePullbackChannelStore(): Record<string, RetracePullbackChannelDedupeEntry> {
  return readStoreSync();
}

function writeStoreSync(store: DedupeStore): void {
  const file = dedupeFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  pruneStore(store, Date.now());
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function spinMs(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* short busy wait between lock attempts */
  }
}

function withDedupeFileLock<T>(fn: () => T): T {
  const lockDir = `${lockFilePath()}.d`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        spinMs(20);
        continue;
      }
      throw e;
    }
  }
  if (!acquired) throw new Error('retrace-pullback channel dedupe lock timeout');
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Атомарно занять слот перед отправкой в TG. false = уже слали (другой DEX / другой watcher).
 */
export function reserveRetracePullbackChannelSlot(
  mint: string,
  peakTs: Date,
  source: 'pullback' | 'retrace',
): boolean {
  const key = retracePullbackChannelEventKey(mint, peakTs);
  return withDedupeFileLock(() => {
    const store = readStoreSync();
    if (store[key] != null) return false;
    store[key] = {
      peakBucket: peakBucketIndex(peakTs),
      sentAtMs: Date.now(),
      source,
    };
    writeStoreSync(store);
    return true;
  });
}

/** @deprecated используйте reserveRetracePullbackChannelSlot */
export async function isRetracePullbackChannelDuplicate(
  mint: string,
  peakTs: Date,
): Promise<boolean> {
  const key = retracePullbackChannelEventKey(mint, peakTs);
  const store = readStoreSync();
  return store[key] != null;
}

/** @deprecated слот резервируется в reserveRetracePullbackChannelSlot */
export async function recordRetracePullbackChannelSent(
  mint: string,
  peakTs: Date,
  source: 'pullback' | 'retrace',
): Promise<void> {
  void mint;
  void peakTs;
  void source;
}
