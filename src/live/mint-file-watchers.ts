/**
 * 1.11.231 — file-watch hot-reload whitelist + permanent-denylist.
 *
 * `loadLiveMintWhitelistSet` уже делает mtime-poll на каждый запрос (т.е. hot-reload УЖЕ работает),
 * но реактивный `fs.watch` снижает latency перехвата изменений и добавляет видимый diff
 * в Telegram + JSONL: «whitelist updated: +SOMECOIN, -BADCOIN».
 *
 * Поведение:
 *   - инициализируется один раз через `initMintFileWatchers(cfg)` в `main.ts`;
 *   - на mtime-event перечитываем файл, считаем diff, шлём `live_mint_file_watch_change` в JSONL +
 *     Telegram (если включён `LIVE_MINT_FILE_WATCH_TELEGRAM_ENABLED`);
 *   - повторные events в течение `LIVE_MINT_FILE_WATCH_DEBOUNCE_MS` склеиваются.
 *
 * `fs.watch` ненадёжен на некоторых ФС (NFS, SMB), поэтому используется только как accelerator,
 * fallback на mtime-poll-based reload остаётся.
 */

import fs from 'node:fs';
import path from 'node:path';
import { child } from '../core/logger.js';
import { sendTagged } from '../core/telegram/sender.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { LiveOscarConfig } from './config.js';
import {
  clearLiveMintWhitelistCache,
  loadLiveMintWhitelistSet,
  resolveLiveMintWhitelistPath,
} from './mint-whitelist.js';
import {
  invalidateLivePermanentDenylistCache,
  loadPermanentDenylistCombined,
  resolveLivePermanentDenylistLocalPath,
  resolveLivePermanentDenylistSeedPath,
} from './mint-permanent-denylist.js';
import {
  buildMintFileWatchTelegramText,
  fetchMintSymbolsBatch,
} from './mint-file-watch-telegram-format.js';

const log = child('mint-file-watchers');

interface WatchState {
  /** Last known set of entries (for diffing). */
  lastSet: Set<string>;
  /** Debounce timer id (we don't actually use clearTimeout because debounce). */
  pendingTimer: NodeJS.Timeout | null;
  /** fs.watch handle (kept to allow cleanup in tests). */
  watcher: fs.FSWatcher | null;
}

const states: Map<string, WatchState> = new Map();

function debounceMs(): number {
  const raw = Number(process.env.LIVE_MINT_FILE_WATCH_DEBOUNCE_MS ?? '500');
  return Number.isFinite(raw) && raw > 50 && raw < 10_000 ? raw : 500;
}

function telegramEnabled(): boolean {
  const v = process.env.LIVE_MINT_FILE_WATCH_TELEGRAM_ENABLED?.trim();
  if (v === '0' || v === 'false') return false;
  return true;
}

function formatDiff(prev: Set<string>, next: Set<string>): {
  added: string[];
  removed: string[];
} {
  const added: string[] = [];
  const removed: string[] = [];
  for (const m of next) if (!prev.has(m)) added.push(m);
  for (const m of prev) if (!next.has(m)) removed.push(m);
  return { added, removed };
}

async function emitChangeNotice(args: {
  kind: 'whitelist' | 'denylist';
  path: string;
  prev: Set<string>;
  next: Set<string>;
}): Promise<void> {
  const { kind, path: absPath, prev, next } = args;
  const { added, removed } = formatDiff(prev, next);
  if (added.length === 0 && removed.length === 0) return;
  log.info(
    { kind, path: absPath, addedCount: added.length, removedCount: removed.length, total: next.size },
    'mint file watch reload',
  );
  appendLiveJsonlEvent({
    kind: 'live_mint_file_watch_change',
    fileKind: kind,
    path: absPath,
    addedCount: added.length,
    removedCount: removed.length,
    total: next.size,
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
  });
  if (!telegramEnabled()) return;
  const symbols = await fetchMintSymbolsBatch([...added, ...removed]);
  const text = buildMintFileWatchTelegramText({
    kind,
    absPath,
    total: next.size,
    added,
    removed,
    symbols,
  });
  try {
    await sendTagged('ADVICE', `live_mint_file_watch_${kind}`, text, {
      skipQuietHours: false,
      parseMode: 'HTML',
    });
  } catch (e) {
    log.warn({ err: String(e), kind }, 'mint file watch telegram failed');
  }
}

function reloadWhitelistAndDiff(absPath: string, state: WatchState): void {
  try {
    clearLiveMintWhitelistCache();
    if (!fs.existsSync(absPath)) {
      const next = new Set<string>();
      void emitChangeNotice({ kind: 'whitelist', path: absPath, prev: state.lastSet, next });
      state.lastSet = next;
      return;
    }
    const next = loadLiveMintWhitelistSet(absPath);
    void emitChangeNotice({ kind: 'whitelist', path: absPath, prev: state.lastSet, next });
    state.lastSet = new Set(next);
  } catch (e) {
    log.warn({ err: String(e), absPath }, 'whitelist reload failed');
  }
}

function reloadDenylistAndDiff(
  cfg: Pick<LiveOscarConfig, 'livePermanentDenylistDisabled' | 'livePermanentDenylistLocalPath' | 'livePermanentDenylistSeedPath'>,
  absPath: string,
  state: WatchState,
): void {
  try {
    invalidateLivePermanentDenylistCache();
    const next = loadPermanentDenylistCombined(cfg);
    void emitChangeNotice({ kind: 'denylist', path: absPath, prev: state.lastSet, next });
    state.lastSet = new Set(next);
  } catch (e) {
    log.warn({ err: String(e), absPath }, 'denylist reload failed');
  }
}

function watchFile(absPath: string, onChange: () => void): fs.FSWatcher | null {
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    log.warn({ dir }, 'cannot watch — parent dir missing');
    return null;
  }
  try {
    /** Используем `fs.watch` на родительском директории (для rename/atomic-write поддержки). */
    const watcher = fs.watch(dir, { persistent: false }, (_eventType, fname) => {
      if (!fname) return;
      const changed = path.resolve(dir, String(fname));
      if (changed !== absPath) return;
      onChange();
    });
    watcher.on('error', (e) => log.warn({ err: String(e), absPath }, 'fs.watch error'));
    return watcher;
  } catch (e) {
    log.warn({ err: String(e), absPath }, 'fs.watch init failed');
    return null;
  }
}

function debouncedReload(
  state: WatchState,
  reload: () => void,
): void {
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
  }
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = null;
    reload();
  }, debounceMs());
}

/** Initialize watchers. Idempotent (повторный вызов пропускает уже инициализированные пути). */
export function initMintFileWatchers(liveCfg: LiveOscarConfig): void {
  /** Whitelist. */
  if (liveCfg.liveMintWhitelistEnabled) {
    const wlAbs = resolveLiveMintWhitelistPath(liveCfg.liveMintWhitelistPath);
    if (!states.has(wlAbs)) {
      const init = fs.existsSync(wlAbs) ? loadLiveMintWhitelistSet(wlAbs) : new Set<string>();
      const st: WatchState = { lastSet: new Set(init), pendingTimer: null, watcher: null };
      st.watcher = watchFile(wlAbs, () =>
        debouncedReload(st, () => reloadWhitelistAndDiff(wlAbs, st)),
      );
      states.set(wlAbs, st);
      log.info({ path: wlAbs, count: st.lastSet.size, watcherReady: !!st.watcher }, 'whitelist watcher initialized');
    }
  }
  /** Permanent-denylist (seed + local). */
  if (!liveCfg.livePermanentDenylistDisabled) {
    const localAbs = resolveLivePermanentDenylistLocalPath(liveCfg.livePermanentDenylistLocalPath);
    const seedAbs = resolveLivePermanentDenylistSeedPath(liveCfg.livePermanentDenylistSeedPath);
    const initial = loadPermanentDenylistCombined(liveCfg);
    for (const abs of [localAbs, seedAbs]) {
      if (states.has(abs)) continue;
      const st: WatchState = { lastSet: new Set(initial), pendingTimer: null, watcher: null };
      st.watcher = watchFile(abs, () =>
        debouncedReload(st, () => reloadDenylistAndDiff(liveCfg, abs, st)),
      );
      states.set(abs, st);
      log.info({ path: abs, watcherReady: !!st.watcher }, 'denylist watcher initialized');
    }
  }
}

/** Test helper. */
export function _shutdownMintFileWatchersForTests(): void {
  for (const st of states.values()) {
    if (st.pendingTimer) clearTimeout(st.pendingTimer);
    st.watcher?.close();
  }
  states.clear();
}
