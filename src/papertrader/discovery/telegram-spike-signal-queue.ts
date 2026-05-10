/**
 * Очередь JSONL: `market-spike-telegram-watch` дописывает mint при успешной отправке пролива в Telegram;
 * discovery (напр. live-oscar-risky) читает свежие строки и подмешивает mint в eval наравне с PG-кандидатами.
 */
import fs from 'node:fs';
import path from 'node:path';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export type TelegramSpikeQueueRecord = {
  ts: number;
  mint: string;
  kind: string;
};

export function appendSpikeDumpToTelegramSignalQueue(absPath: string, mint: string): void {
  const m = mint.trim();
  if (!ADDR_RE.test(m)) return;
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const rec: TelegramSpikeQueueRecord = { ts: Date.now(), mint: m, kind: 'spike_dump' };
  fs.appendFileSync(absPath, `${JSON.stringify(rec)}\n`, 'utf8');
}

/**
 * Последние `maxTailLines` строк файла: mint с kind spike_dump и возрастом ≤ maxAgeMs.
 * На один mint оставляем самую свежую запись.
 */
export function readRecentSpikeDumpMintsFromQueue(
  absPath: string,
  maxAgeMs: number,
  maxTailLines = 2500,
): string[] {
  if (!absPath.trim() || !fs.existsSync(absPath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split(/\n/).filter((l) => l.trim().length > 0);
  const tail = lines.length > maxTailLines ? lines.slice(-maxTailLines) : lines;
  const now = Date.now();
  const latestTsByMint = new Map<string, number>();
  for (const line of tail) {
    try {
      const j = JSON.parse(line) as TelegramSpikeQueueRecord;
      if (j.kind !== 'spike_dump') continue;
      const m = typeof j.mint === 'string' ? j.mint.trim() : '';
      if (!ADDR_RE.test(m)) continue;
      const ts = Number(j.ts);
      if (!Number.isFinite(ts) || now - ts > maxAgeMs) continue;
      const prev = latestTsByMint.get(m) ?? 0;
      if (ts >= prev) latestTsByMint.set(m, ts);
    } catch {
      /* skip bad line */
    }
  }
  return [...latestTsByMint.keys()];
}
