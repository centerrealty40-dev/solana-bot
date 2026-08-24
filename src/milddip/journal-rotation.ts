import fs from 'node:fs';
const trackedBytes = new Map<string, { bytes: number; lastStatAtMs: number }>();

export function rotateMildDipJournal(
  filePath: string,
  maxBytes: number,
  appendedBytes = 0,
): boolean {
  if (!(maxBytes > 0)) return false;
  try {
    const nowMs = Date.now();
    const tracked = trackedBytes.get(filePath) ?? { bytes: 0, lastStatAtMs: 0 };
    if (nowMs - tracked.lastStatAtMs >= 60_000 || tracked.bytes >= maxBytes) {
      tracked.bytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      tracked.lastStatAtMs = nowMs;
    }
    if (tracked.bytes < maxBytes) {
      tracked.bytes += appendedBytes;
      trackedBytes.set(filePath, tracked);
      return false;
    }
    let suffix = 0;
    let rotated: string;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    do {
      suffix += 1;
      rotated = `${filePath}.${date}.${suffix}.jsonl`;
    } while (fs.existsSync(rotated));
    fs.renameSync(filePath, rotated);
    trackedBytes.set(filePath, { bytes: appendedBytes, lastStatAtMs: nowMs });
    return true;
  } catch {
    return false;
  }
}
