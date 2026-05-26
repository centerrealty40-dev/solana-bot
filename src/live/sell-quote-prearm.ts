/**
 * 1.11.231 — pre-arm sell quote для TP-ladder.
 *
 * Когда tracker детектирует, что позиция близка к TP-rung'у (peakPnl ≈ TP*0.9), он зовёт
 * `armSellQuote(mint, ..., expirePartial=true)` который **заранее** делает Jupiter quote +
 * swap build, и сохраняет в in-memory store. При фактическом TP-trigger sell pipeline
 * сначала пробует `consumeArmedSellQuote` — если quote ещё fresh (< quoteMaxAgeMs), используем
 * его и пропускаем Jupiter `/quote` + `/swap` calls (~500-1000ms latency saved).
 *
 * Это **НЕ pre-signing**: подпись/отправка происходят строго на `consume` стадии. Pre-armed
 * quote НЕ может «случайно отправиться».
 *
 * Безопасность:
 *   - quote живёт `armTtlMs` (default 5_000), потом отбрасывается;
 *   - на каждый mint храним только **одну** armed quote (новый вытесняет старую);
 *   - `consume` атомарно delete'ит quote → второй consume вернёт `null`.
 *
 * Метрики:
 *   - JSONL `live_sell_quote_prearm_armed` / `live_sell_quote_prearm_consumed`
 *   - JSONL `live_sell_quote_prearm_expired` (для дашборда / cost-estimate)
 */

import { appendLiveJsonlEvent } from './store-jsonl.js';
import { child } from '../core/logger.js';

const log = child('sell-quote-prearm');

export interface ArmedSellQuoteEntry {
  /** Unix ms когда arm создан. */
  armedAtMs: number;
  /** TTL после которого quote считается stale. */
  expiresAtMs: number;
  /** Сам quote response + swapBuild — экземпляр того же типа, что возвращает `liveSellQuoteAndPrepareSnapshot`. */
  quoteResponse: Record<string, unknown>;
  quoteSnapshot: Record<string, unknown>;
  swapBuildB64: string;
  /** Конкретный intent для которого armed (для гонок tracker/phase4). */
  intentKind: 'sell_partial' | 'sell_full';
  /** Используемые atomar units — для consume integrity check (если запросили другой размер — отбрасываем arm). */
  tokenAmountRaw: string;
}

const store = new Map<string, ArmedSellQuoteEntry>();

function key(mint: string): string {
  return mint;
}

export function setArmedSellQuote(mint: string, entry: ArmedSellQuoteEntry): void {
  store.set(key(mint), entry);
  appendLiveJsonlEvent({
    kind: 'live_sell_quote_prearm_armed',
    mint,
    intentKind: entry.intentKind,
    tokenAmountRaw: entry.tokenAmountRaw,
    expiresAtMs: entry.expiresAtMs,
  });
  log.info(
    { mint: mint.slice(0, 12), intentKind: entry.intentKind, ttlMs: entry.expiresAtMs - entry.armedAtMs },
    'sell quote pre-armed',
  );
}

/**
 * Попытаться использовать armed quote. Возвращает entry если:
 *   - armed quote есть для mint,
 *   - не expired,
 *   - совпадает по `intentKind`,
 *   - `tokenAmountRaw` соответствует ожидаемому (sell_full допускает разный raw, sell_partial — должен совпадать).
 *
 * При успехе entry **удаляется** из store (one-shot). При неуспехе entry остаётся.
 */
export function consumeArmedSellQuote(args: {
  mint: string;
  intentKind: 'sell_partial' | 'sell_full';
  tokenAmountRaw: string;
  nowMs?: number;
}): ArmedSellQuoteEntry | null {
  const now = args.nowMs ?? Date.now();
  const entry = store.get(key(args.mint));
  if (!entry) return null;
  if (entry.expiresAtMs <= now) {
    /** Expired — отбрасываем, пишем метрику. */
    store.delete(key(args.mint));
    appendLiveJsonlEvent({
      kind: 'live_sell_quote_prearm_expired',
      mint: args.mint,
      intentKind: entry.intentKind,
      expiresAtMs: entry.expiresAtMs,
      nowMs: now,
    });
    return null;
  }
  if (entry.intentKind !== args.intentKind) return null;
  /** sell_partial должен точно совпадать; sell_full — допускаем (chain raw может меняться). */
  if (args.intentKind === 'sell_partial' && entry.tokenAmountRaw !== args.tokenAmountRaw) {
    return null;
  }
  store.delete(key(args.mint));
  appendLiveJsonlEvent({
    kind: 'live_sell_quote_prearm_consumed',
    mint: args.mint,
    intentKind: entry.intentKind,
    ageMs: now - entry.armedAtMs,
  });
  log.info(
    { mint: args.mint.slice(0, 12), intentKind: entry.intentKind, ageMs: now - entry.armedAtMs },
    'sell quote pre-armed consumed',
  );
  return entry;
}

/** Очистить arm для mint (например, при close/cancel позиции). */
export function clearArmedSellQuote(mint: string): boolean {
  return store.delete(key(mint));
}

/** Тест-helper. */
export function _resetArmedSellQuoteForTests(): void {
  store.clear();
}

/** Snapshot for diagnostics. */
export function armedSellQuoteSnapshot(): Array<{
  mint: string;
  intentKind: string;
  ageMs: number;
  ttlMs: number;
}> {
  const now = Date.now();
  const out: Array<{ mint: string; intentKind: string; ageMs: number; ttlMs: number }> = [];
  for (const [mint, entry] of store) {
    out.push({
      mint,
      intentKind: entry.intentKind,
      ageMs: now - entry.armedAtMs,
      ttlMs: entry.expiresAtMs - now,
    });
  }
  return out;
}
