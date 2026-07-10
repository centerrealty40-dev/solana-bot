const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const SKIP_MINTS = new Set([WSOL, USDC, USDT]);

/** Heuristic mint extraction from pump.fun / PumpSwap log lines (no getTransaction). */
export function extractMintCandidatesFromLogs(logs: string[]): string[] {
  if (!Array.isArray(logs) || logs.length === 0) return [];
  const found = new Set<string>();
  for (const line of logs) {
    if (typeof line !== 'string' || line.length < 32) continue;
    const matches = line.match(BASE58_RE);
    if (!matches) continue;
    for (const m of matches) {
      if (m.length < 32 || SKIP_MINTS.has(m)) continue;
      if (m.endsWith('pump') || line.includes('Instruction: Buy') || line.includes('Instruction: Sell')) {
        found.add(m);
      }
    }
  }
  return [...found];
}

export function extractMintFromStreamPayload(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const value = payload.value as { logs?: unknown } | undefined;
  const logsRaw = value?.logs;
  if (!Array.isArray(logsRaw)) return [];
  return extractMintCandidatesFromLogs(logsRaw.map(String));
}
