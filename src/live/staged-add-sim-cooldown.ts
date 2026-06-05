/**
 * 1.11.230 — staged-add sim_err cooldown.
 *
 * Когда подряд несколько `sim_err` приходят на одну и ту же `(mint, intentKind)` (обычно
 * `buy_scale_in` / `dca_add` под Jupiter Custom:1 или 0x1771 — «slippage tolerance exceeded»
 * на конкретном маршруте), нет смысла каждые 30 с заходить в `runSolToTokenPipeline` —
 * это сжигает QN-кредиты на симуляциях с одинаковым результатом. Модуль хранит:
 *
 *   - per-(mint,intentKind) счётчик подряд идущих sim_err после последнего успеха;
 *   - timestamp активации cooldown (если streak ≥ threshold).
 *
 * Сбрасывается на любой не-sim_err исход (success / `confirm_timeout` / `send_failed`).
 * Не зависит от tracker tick — переживает рестарт **только** через память процесса;
 * мы сознательно не пишем в JSONL, чтобы не плодить state-файлы.
 */

import { appendLiveJsonlEvent } from './store-jsonl.js';
import { child } from '../core/logger.js';
import { appendMintToPermanentDenylistLocal } from './mint-permanent-denylist.js';
import type { LiveOscarConfig } from './config.js';

const log = child('staged-add-sim-cooldown');

export type StagedAddIntentKind = 'buy_open' | 'dca_add' | 'buy_scale_in';

interface Entry {
  /** Подряд идущих sim_err (без успехов между ними). */
  streak: number;
  /** Когда cooldown активен — `cooldownUntilMs > Date.now()`. */
  cooldownUntilMs: number;
  /** Время последнего sim_err — для отладки в логе. */
  lastSimErrTs: number;
  /** Запоминаем кэш `terminalMessage` последнего sim_err — для контекста при Telegram-нотификации. */
  lastTerminalMessage?: string;
  /** Сколько раз мы УЖЕ заблокировали повторный заход в pipeline. Для метрики. */
  blockedAttempts: number;
}

interface StagedAddCooldownConfig {
  /** Сколько подряд `sim_err` должно прийти, чтобы активировать cooldown. */
  streakThreshold: number;
  /** Длительность cooldown в мс (по умолчанию 30 мин). */
  cooldownMs: number;
  /** Сколько раз cooldown должен arm'нуться (по mint, через все intentKind) перед автоматическим добавлением в permanent-denylist. `0` = выкл. */
  autoDenylistRearmsThreshold: number;
  /** Включён ли вообще auto-denylist. */
  autoDenylistEnabled: boolean;
  /** Включён ли Telegram alert при auto-denylist. */
  autoDenylistTelegramEnabled: boolean;
}

const store = new Map<string, Entry>();
/** Сколько раз cooldown сработал для конкретного mint (через все intentKind). */
const rearmsByMint = new Map<string, number>();
/** Уже добавленные в auto-denylist mint'ы — чтобы не пытаться повторно. */
const autoDeniedByMint = new Set<string>();

let cfg: StagedAddCooldownConfig = {
  streakThreshold: 3,
  cooldownMs: 30 * 60 * 1000,
  autoDenylistRearmsThreshold: 5,
  autoDenylistEnabled: true,
  autoDenylistTelegramEnabled: true,
};
/**
 * Опциональная ссылка на `liveCfg` — нужна для `appendMintToPermanentDenylistLocal`.
 * Если не задана — auto-denylist no-op, лог-предупреждение.
 */
let liveCfgRef: LiveOscarConfig | null = null;

export function configureStagedAddSimCooldown(
  c: StagedAddCooldownConfig,
  liveCfg?: LiveOscarConfig,
): void {
  cfg = { ...c };
  if (liveCfg) liveCfgRef = liveCfg;
}

function key(mint: string, intentKind: StagedAddIntentKind): string {
  return `${mint}\u0001${intentKind}`;
}

function getOrCreate(mint: string, intentKind: StagedAddIntentKind): Entry {
  const k = key(mint, intentKind);
  const existing = store.get(k);
  if (existing) return existing;
  const fresh: Entry = { streak: 0, cooldownUntilMs: 0, lastSimErrTs: 0, blockedAttempts: 0 };
  store.set(k, fresh);
  return fresh;
}

export function isStagedAddCooldownActive(args: {
  mint: string;
  intentKind: StagedAddIntentKind;
  nowMs?: number;
}): boolean {
  const now = args.nowMs ?? Date.now();
  const entry = store.get(key(args.mint, args.intentKind));
  if (!entry) return false;
  if (entry.cooldownUntilMs <= now) return false;
  entry.blockedAttempts += 1;
  return true;
}

/** Получить ms до окончания cooldown (или 0, если cooldown не активен). */
export function stagedAddCooldownRemainingMs(args: {
  mint: string;
  intentKind: StagedAddIntentKind;
  nowMs?: number;
}): number {
  const now = args.nowMs ?? Date.now();
  const entry = store.get(key(args.mint, args.intentKind));
  if (!entry || entry.cooldownUntilMs <= now) return 0;
  return entry.cooldownUntilMs - now;
}

/**
 * Учесть результат попытки. На каждом исходе:
 *   - `kind === 'sim_err'` → инкремент streak; при достижении threshold — активируем cooldown и пишем `live_staged_add_cooldown` в JSONL.
 *   - любой не-sim_err — reset streak и cooldown.
 */
export function recordStagedAddOutcome(args: {
  mint: string;
  intentKind: StagedAddIntentKind;
  kind: 'sim_err' | 'success' | 'other';
  terminalMessage?: string;
  nowMs?: number;
}): void {
  const now = args.nowMs ?? Date.now();
  const entry = getOrCreate(args.mint, args.intentKind);

  if (args.kind !== 'sim_err') {
    if (entry.streak > 0 || entry.cooldownUntilMs > 0) {
      log.debug(
        {
          mint: args.mint.slice(0, 12),
          intentKind: args.intentKind,
          priorStreak: entry.streak,
          kind: args.kind,
        },
        'staged-add cooldown reset',
      );
    }
    entry.streak = 0;
    entry.cooldownUntilMs = 0;
    entry.lastTerminalMessage = undefined;
    entry.blockedAttempts = 0;
    return;
  }

  entry.streak += 1;
  entry.lastSimErrTs = now;
  entry.lastTerminalMessage = args.terminalMessage;

  if (entry.streak >= cfg.streakThreshold && entry.cooldownUntilMs <= now) {
    entry.cooldownUntilMs = now + cfg.cooldownMs;
    /** Учитываем rearm только если это новый cooldown (а не продолжение старого). */
    const rearmsNext = (rearmsByMint.get(args.mint) ?? 0) + 1;
    rearmsByMint.set(args.mint, rearmsNext);
    log.warn(
      {
        mint: args.mint.slice(0, 12),
        intentKind: args.intentKind,
        streak: entry.streak,
        cooldownUntil: new Date(entry.cooldownUntilMs).toISOString(),
        rearms: rearmsNext,
        sample: (args.terminalMessage ?? '').slice(0, 160),
      },
      'staged-add sim_err cooldown ARMED',
    );
    appendLiveJsonlEvent({
      kind: 'live_staged_add_cooldown',
      mint: args.mint,
      intentKind: args.intentKind,
      streak: entry.streak,
      rearms: rearmsNext,
      cooldownMs: cfg.cooldownMs,
      cooldownUntilMs: entry.cooldownUntilMs,
      sampleMessage: (args.terminalMessage ?? '').slice(0, 200),
    });

    /**
     * 1.11.231 — auto-permanent-denylist по числу cooldown-rearm'ов.
     * Если `rearmsByMint[mint] >= autoDenylistRearmsThreshold` и mint ещё не в denylist'е —
     * добавляем в локальный permanent-denylist и шлём ALERT в Telegram.
     */
    if (
      cfg.autoDenylistEnabled &&
      cfg.autoDenylistRearmsThreshold > 0 &&
      rearmsNext >= cfg.autoDenylistRearmsThreshold &&
      !autoDeniedByMint.has(args.mint)
    ) {
      autoDeniedByMint.add(args.mint);
      if (liveCfgRef) {
        const added = appendMintToPermanentDenylistLocal(
          liveCfgRef,
          args.mint,
          `staged_add_cooldown_rearms=${rearmsNext}`,
          {
            skipListChangeTelegram: !cfg.autoDenylistTelegramEnabled,
          },
        );
        log.warn(
          {
            mint: args.mint.slice(0, 12),
            rearms: rearmsNext,
            denylistAdded: added,
          },
          'staged-add auto-denylist ARMED',
        );
        appendLiveJsonlEvent({
          kind: 'live_staged_add_auto_denylist',
          mint: args.mint,
          rearms: rearmsNext,
          rearmsThreshold: cfg.autoDenylistRearmsThreshold,
          denylistAdded: added,
        });
      } else {
        log.warn(
          { mint: args.mint.slice(0, 12), rearms: rearmsNext },
          'auto-denylist threshold reached but liveCfgRef missing',
        );
      }
    }
  }
}

/** Только для тестов — обнулить все cooldown. */
export function _resetStagedAddCooldownForTests(): void {
  store.clear();
  rearmsByMint.clear();
  autoDeniedByMint.clear();
  liveCfgRef = null;
}

/** Только для тестов / диагностики — снэпшот текущих counters. */
export function stagedAddCooldownDebugSnapshot(): Array<{
  mint: string;
  intentKind: StagedAddIntentKind;
  streak: number;
  cooldownUntilMs: number;
  blockedAttempts: number;
}> {
  const out: Array<{
    mint: string;
    intentKind: StagedAddIntentKind;
    streak: number;
    cooldownUntilMs: number;
    blockedAttempts: number;
  }> = [];
  for (const [k, v] of store) {
    const [mint, intentKind] = k.split('\u0001');
    if (!mint || !intentKind) continue;
    out.push({
      mint,
      intentKind: intentKind as StagedAddIntentKind,
      streak: v.streak,
      cooldownUntilMs: v.cooldownUntilMs,
      blockedAttempts: v.blockedAttempts,
    });
  }
  return out;
}
