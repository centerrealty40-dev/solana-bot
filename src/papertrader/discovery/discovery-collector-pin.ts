import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PATH = path.join('data', 'live', 'discovery-collector-pin-mints.txt');

function pinPath(): string {
  return process.env.PAPER2_SNAPSHOT_DISCOVERY_PIN_PATH?.trim() || DEFAULT_PATH;
}

function pinMax(): number {
  const n = Number(process.env.PAPER2_SNAPSHOT_DISCOVERY_PIN_MAX || 200);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

function pinEnabled(): boolean {
  return !['0', 'false', 'no'].includes(String(process.env.PAPER2_SNAPSHOT_DISCOVERY_PIN ?? '1').toLowerCase());
}

/** Mint'ы discovery SQL + priority tier → файл для DexScreener enrich в коллекторах. */
export function writeDiscoveryCollectorPinMints(mints: Iterable<string>): void {
  if (!pinEnabled()) return;
  const fp = pinPath();
  const max = pinMax();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mints) {
    const s = String(m ?? '').trim();
    if (s.length < 32 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  const dir = path.dirname(fp);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, out.length ? `${out.join('\n')}\n` : '', 'utf8');
  fs.renameSync(tmp, fp);
}
