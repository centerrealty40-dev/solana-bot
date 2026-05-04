/**
 * W6.8 — чистые функции оркестратора (тесты + переиспользование логики расписания).
 * @module wallet-orchestrator-lib
 */

/** @param {unknown} poolData Gecko JSON:API pool included */
export function geckoDexId(poolData) {
  return String(poolData?.relationships?.dex?.data?.id ?? '').toLowerCase();
}

export function geckoDexLegacy(poolData) {
  const attrs = poolData?.attributes ?? {};
  return String(attrs.dex_name ?? attrs.dex ?? '').toLowerCase();
}

/**
 * @param {unknown} poolData
 * @param {string} laneId pumpswap | raydium | meteora | orca | moonshot
 */
export function matchLaneDex(poolData, laneId) {
  const id = geckoDexId(poolData);
  const leg = geckoDexLegacy(poolData);
  switch (laneId) {
    case 'pumpswap':
      return (
        id.includes('pump') ||
        id.includes('pumpswap') ||
        leg.includes('pumpswap') ||
        leg.includes('pump swap') ||
        leg.includes('pump.fun')
      );
    case 'raydium':
      return id === 'raydium' || id.startsWith('raydium-') || leg.includes('raydium');
    case 'meteora':
      return id.includes('meteora') || leg.includes('meteora');
    case 'orca':
      return id.includes('orca') || leg.includes('orca') || leg.includes('whirlpool');
    case 'moonshot':
      return id.includes('moonshot') || leg.includes('moonshot');
    default:
      return false;
  }
}

/** Базовые страницы Gecko по типу job (без бонуса pumpswap). */
export function basePagesForJobType(jobType) {
  switch (jobType) {
    case 'new_pools':
      return 2;
    case 'trending_pools':
      return 2;
    case 'extended':
      return 4;
    case 'daily_deep':
      return 8;
    default:
      return 1;
  }
}

export function pagesForLaneJob(jobType, laneId, pumpswapPageBonus) {
  const b = basePagesForJobType(jobType);
  const bonus = laneId === 'pumpswap' ? pumpswapPageBonus : 0;
  return Math.min(20, Math.max(1, b + bonus));
}

/** Путь Gecko API v2 network solana. */
export function geckoPathForJobType(jobType) {
  if (jobType === 'trending_pools') return 'trending_pools';
  return 'new_pools';
}

/**
 * Слаги Gecko Terminal `/networks/solana/dexes/{slug}/pools`.
 * Глобальный `/new_pools` почти весь из pump-fun / meteora — Raydium/Orca/Moonshot там часто 0 строк на первых страницах.
 * Для `trending_pools` остаётся только глобальный `/trending_pools` (у dex нет отдельного trending в API).
 * @returns {string[] | null} null → использовать глобальный путь {@link geckoPathForJobType}
 */
export function geckoDexPoolSlugsForLane(laneId) {
  switch (laneId) {
    case 'raydium':
      return ['raydium', 'raydium-clmm', 'raydium-launchlab'];
    case 'meteora':
      return ['meteora', 'meteora-dbc', 'meteora-damm-v2'];
    case 'orca':
      return ['orca'];
    case 'moonshot':
      return ['moonshot'];
    default:
      return null;
  }
}

/**
 * Уникальный слот «уже выполняли» для dedupe.
 * @param {string} jobType
 * @param {number} hourUtc 0–23
 */
export function fireSlotKey(utcDay, jobType, laneId, hourUtc) {
  if (jobType === 'new_pools') return `${utcDay}|${laneId}|${jobType}|h${hourUtc}`;
  if (jobType === 'trending_pools') return `${utcDay}|${laneId}|${jobType}|q${Math.floor(hourUtc / 6)}`;
  if (jobType === 'extended') return `${utcDay}|${laneId}|${jobType}|b${Math.floor(hourUtc / 12)}`;
  if (jobType === 'daily_deep') return `${utcDay}|${laneId}|${jobType}|d`;
  return `${utcDay}|${laneId}|${jobType}|x`;
}

/**
 * Можно ли стартовать job сейчас (UTC). Повтор в том же слоте режет caller по `firedSlots` / fireSlotKey.
 *
 * Раньше требовали `m === laneIdx*9` — при тике 45s и длинных волнах (очередь) реально пропускали час.
 * Правило: не раньше фазы `laneIdx*9`, после неё — до конца часа (догоняющий запуск).
 */
export function isMinuteAlignedForJob({ laneIdx, jobType, now, dailyDeepHourUtc }) {
  const phase = laneIdx * 9;
  const m = now.getUTCMinutes();
  const h = now.getUTCHours();
  if (m < phase) return false;
  if (jobType === 'new_pools') return true;
  if (jobType === 'trending_pools') return h % 6 === 0;
  if (jobType === 'extended') return h % 12 === 0;
  if (jobType === 'daily_deep') return h === dailyDeepHourUtc;
  return false;
}
