/**
 * Telegram-текст для file-watch whitelist / permanent-denylist: символ + GMGN-ссылка.
 */
import { gmgnMintHrefHtml } from '../papertrader/discovery/near-ready-dip-watch.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function shortMintLabel(mint: string): string {
  const m = mint.trim();
  if (m.length <= 12) return m;
  return `${m.slice(0, 8)}…${m.slice(-4)}`;
}

export function resolveMintDisplayLabel(mint: string, symbol?: string | null): string {
  const sym = symbol?.trim();
  if (sym && sym !== '?') return sym;
  return shortMintLabel(mint);
}

export function formatMintListHtml(
  mints: string[],
  symbols: Map<string, string | null | undefined>,
  cap = 6,
): string {
  if (mints.length === 0) return '—';
  const head = mints.slice(0, cap);
  const items = head.map((m) =>
    gmgnMintHrefHtml(m, resolveMintDisplayLabel(m, symbols.get(m))),
  );
  const tail = mints.length - head.length;
  return tail > 0 ? `${items.join(', ')} (+${tail} more)` : items.join(', ');
}

export function buildMintFileWatchTelegramText(args: {
  kind: 'whitelist' | 'denylist';
  absPath: string;
  total: number;
  added: string[];
  removed: string[];
  symbols: Map<string, string | null | undefined>;
}): string {
  const { kind, absPath, total, added, removed, symbols } = args;
  return (
    `Файл ${kind} обновлён.\n` +
    `Путь: ${absPath}\n` +
    `Всего записей: ${total}\n` +
    `Добавлено (${added.length}): ${formatMintListHtml(added, symbols)}\n` +
    `Удалено (${removed.length}): ${formatMintListHtml(removed, symbols)}`
  );
}

/** Best-effort symbol lookup via DexScreener (batch). */
export async function fetchMintSymbolsBatch(mints: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(mints.map((m) => m.trim()).filter((m) => ADDR_RE.test(m)))];
  for (const m of unique) out.set(m, null);

  const CHUNK = 30;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map((m) => encodeURIComponent(m)).join(',')}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) continue;
      const j = (await r.json()) as {
        pairs?: { baseToken?: { address?: string; symbol?: string } }[];
      };
      const seen = new Set<string>();
      for (const p of j.pairs ?? []) {
        const addr = String(p.baseToken?.address ?? '').trim();
        if (!addr || seen.has(addr) || !out.has(addr)) continue;
        seen.add(addr);
        const sym = String(p.baseToken?.symbol ?? '').trim() || null;
        out.set(addr, sym);
      }
    } catch {
      /* fallback: shortMintLabel in formatMintListHtml */
    }
  }
  return out;
}
