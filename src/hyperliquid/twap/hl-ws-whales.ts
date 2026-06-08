import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SIGNALS = path.join(process.cwd(), 'data', 'hl-twap', 'signals.jsonl');

export function parseWhaleListEnv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.startsWith('0x') && s.length >= 42),
    ),
  ];
}

/** Top whales by twap_start count from audit (fallback when HL_TWAP_WS_WHALE_LIST unset). */
export function topWhalesFromSignals(
  signalsPath: string,
  maxWhales: number,
  lookbackMs: number,
): string[] {
  if (!fs.existsSync(signalsPath)) return [];
  const cutoff = Date.now() - lookbackMs;
  const counts = new Map<string, number>();
  for (const ln of fs.readFileSync(signalsPath, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let row: { event?: string; at?: string; payload?: { sig?: { user?: string } } };
    try {
      row = JSON.parse(ln) as typeof row;
    } catch {
      continue;
    }
    if (row.event !== 'twap_start' || !row.at) continue;
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs) || atMs < cutoff) continue;
    const user = row.payload?.sig?.user?.trim().toLowerCase();
    if (!user) continue;
    counts.set(user, (counts.get(user) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWhales)
    .map(([u]) => u);
}

export function loadHlWsWhaleList(opts?: {
  envList?: string;
  signalsPath?: string;
  maxWhales?: number;
  lookbackDays?: number;
}): string[] {
  const fromEnv = parseWhaleListEnv(opts?.envList ?? process.env.HL_TWAP_WS_WHALE_LIST);
  if (fromEnv.length > 0) return fromEnv.slice(0, opts?.maxWhales ?? 50);

  const max = opts?.maxWhales ?? Math.max(1, Number(process.env.HL_TWAP_WS_MAX_SUBS ?? 30));
  const lookbackDays = opts?.lookbackDays ?? Number(process.env.HL_TWAP_WS_LOOKBACK_DAYS ?? 30);
  const signalsPath = opts?.signalsPath ?? process.env.HL_TWAP_AUDIT_JSONL?.trim() ?? DEFAULT_SIGNALS;
  return topWhalesFromSignals(signalsPath, max, lookbackDays * 86_400_000);
}
