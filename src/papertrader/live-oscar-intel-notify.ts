import type { EvalDecision } from './discovery/dip-clones.js';
import type { IntelGateHit } from './discovery/smart-lottery-intel.js';
import type { OscarIntelGateSnapshot } from './discovery/oscar-intel-gate.js';
import { shortMintLabel } from '../live/mint-file-watch-telegram-format.js';

export type LiveOscarIntelTradeLane = 'prod' | 'runner_probe' | 'runner_lite';

const INTEL_HIT_LABEL_RU: Record<IntelGateHit['kind'], string> = {
  BLOCK_TRADE: 'BLOCK_TRADE (wallet_intel_decisions)',
  bad_tag: 'bot/scam tag',
  atlas_cluster: 'atlas cluster / wash-связка (entity_wallets)',
  scam_farm_meta: 'scam_farm_meta_cluster',
};

const LANE_INTEL_PREFIX: Record<LiveOscarIntelTradeLane, string> = {
  prod: 'prod_intel_',
  runner_probe: 'runner_probe_intel_',
  runner_lite: 'runner_lite_intel_',
};

const LANE_SHADOW_FLAG: Record<LiveOscarIntelTradeLane, string> = {
  prod: 'prod_intel_shadow_would_block',
  runner_probe: 'runner_probe_intel_shadow_would_block',
  runner_lite: 'runner_lite_intel_shadow_would_block',
};

/** Per-lane mint → last notified intel-reason fingerprint (not a buy cooldown). */
export type LiveOscarIntelBlockNotifyCache = Map<string, string>;

export function resolveLiveOscarIntelTradeLane(
  d: Pick<EvalDecision, 'liveOscarTradeLane'>,
): LiveOscarIntelTradeLane | null {
  const lane = d.liveOscarTradeLane;
  if (lane === 'prod' || lane === 'runner_probe' || lane === 'runner_lite') return lane;
  return null;
}

export function liveOscarIntelSkipReasons(
  reasons: readonly string[],
  tradeLane: LiveOscarIntelTradeLane,
): string[] {
  const prefix = LANE_INTEL_PREFIX[tradeLane];
  const shadow = LANE_SHADOW_FLAG[tradeLane];
  return reasons.filter((r) => r.startsWith(prefix) || r === shadow);
}

export function isLiveOscarIntelBlockNotifyDecision(
  d: Pick<EvalDecision, 'reasons' | 'oscarIntel' | 'liveOscarTradeLane'>,
): boolean {
  const tradeLane = resolveLiveOscarIntelTradeLane(d);
  if (!tradeLane) return false;
  if (!d.oscarIntel?.required || !d.oscarIntel.wouldBlock) return false;
  if (d.oscarIntel.tierGatesPassed !== true) return false;
  return liveOscarIntelSkipReasons(d.reasons, tradeLane).length > 0;
}

/** @deprecated Use {@link isLiveOscarIntelBlockNotifyDecision}. */
export function isRunnerProbeIntelSkipDecision(
  d: Pick<EvalDecision, 'reasons' | 'oscarIntel' | 'liveOscarTradeLane'>,
): boolean {
  if (d.liveOscarTradeLane && d.liveOscarTradeLane !== 'runner_probe') return false;
  return isLiveOscarIntelBlockNotifyDecision({ ...d, liveOscarTradeLane: 'runner_probe' });
}

/** @deprecated Use {@link liveOscarIntelSkipReasons}. */
export function runnerProbeIntelSkipReasons(reasons: readonly string[]): string[] {
  return liveOscarIntelSkipReasons(reasons, 'runner_probe');
}

export function formatIntelHitLine(hit: IntelGateHit): string {
  const label = INTEL_HIT_LABEL_RU[hit.kind] ?? hit.kind;
  return `${label}: ${hit.wallet}`;
}

export function liveOscarIntelBlockNotifyFingerprint(
  tradeLane: LiveOscarIntelTradeLane,
  ig: Pick<OscarIntelGateSnapshot, 'reasons' | 'hits' | 'mode' | 'blocked'>,
): string {
  const reasonParts = [...ig.reasons].sort();
  const hitParts = ig.hits.map((h) => `${h.kind}:${h.wallet}`).sort();
  const blockState = ig.blocked ? 'hard' : 'shadow';
  return `${tradeLane}|${blockState}|${ig.mode}|${reasonParts.join(',')}|${hitParts.join(',')}`;
}

export function liveOscarIntelBlockNotifyCacheKey(
  tradeLane: LiveOscarIntelTradeLane,
  mint: string,
): string {
  return `${tradeLane}:${mint}`;
}

/** True when Telegram should fire: first block for mint, or intel reason set changed. */
export function shouldNotifyLiveOscarIntelBlock(
  cache: LiveOscarIntelBlockNotifyCache,
  tradeLane: LiveOscarIntelTradeLane,
  mint: string,
  ig: OscarIntelGateSnapshot,
): boolean {
  const fp = liveOscarIntelBlockNotifyFingerprint(tradeLane, ig);
  return cache.get(liveOscarIntelBlockNotifyCacheKey(tradeLane, mint)) !== fp;
}

export function recordLiveOscarIntelBlockNotified(
  cache: LiveOscarIntelBlockNotifyCache,
  tradeLane: LiveOscarIntelTradeLane,
  mint: string,
  ig: OscarIntelGateSnapshot,
): void {
  cache.set(
    liveOscarIntelBlockNotifyCacheKey(tradeLane, mint),
    liveOscarIntelBlockNotifyFingerprint(tradeLane, ig),
  );
}

export function shouldJournalLiveOscarIntel(
  ig: OscarIntelGateSnapshot | undefined,
): ig is OscarIntelGateSnapshot {
  return Boolean(ig?.required && ig.wouldBlock && ig.tierGatesPassed);
}

/** @deprecated Use {@link shouldJournalLiveOscarIntel}. */
export function shouldJournalRunnerProbeIntel(
  ig: OscarIntelGateSnapshot | undefined,
): ig is OscarIntelGateSnapshot {
  return shouldJournalLiveOscarIntel(ig);
}

export function buildLiveOscarIntelBlockTelegramText(args: {
  d: EvalDecision;
  tradeLane: LiveOscarIntelTradeLane;
  escapeHtml: (s: string) => string;
  mintHrefHtml: (mint: string, label: string) => string;
  fmtUsd: (v: number | null | undefined) => string;
}): string {
  const { d, tradeLane, escapeHtml, mintHrefHtml, fmtUsd } = args;
  const ig = d.oscarIntel;
  const symbol = d.symbol?.trim() || '?';
  const intelReasons = liveOscarIntelSkipReasons(d.reasons, tradeLane);
  const intelReasonSet = new Set(intelReasons);
  const otherReasons = d.reasons.filter((r) => !intelReasonSet.has(r));
  const blocked = ig?.blocked === true;
  const shadowWouldBlock =
    !blocked &&
    (ig?.wouldBlock === true || intelReasons.includes(LANE_SHADOW_FLAG[tradeLane]));
  const mode = ig?.mode ?? 'off';
  const vol1h = d.features.vol1h_usd ?? d.features.runner?.vol1hUsd ?? null;
  const badWalletCount = ig?.hits?.length ?? 0;

  let headline: string;
  let statusLine: string;
  if (blocked) {
    headline = 'INTEL BLOCK — монета подозрительная, вход запрещён';
    statusLine =
      `Lane <b>${escapeHtml(tradeLane)}</b>: wallet-intel <b>не покупаем</b> — подозрительная активность ` +
      `(scam farm / BLOCK_TRADE / cluster tags). Блок <b>постоянный</b> пока intel policy не сменится; ` +
      `это не временный cooldown и не «попробуем позже».`;
  } else if (shadowWouldBlock) {
    headline = 'INTEL SHADOW — подозрительная активность (вход не блокируется)';
    statusLine =
      `Lane <b>${escapeHtml(tradeLane)}</b>: shadow/advisory — intel <b>заблокировал бы</b> вход ` +
      `(mode=<code>${escapeHtml(mode)}</code>), сделка <b>не остановлена</b>.`;
  } else {
    headline = 'INTEL — подозрительная активность';
    statusLine = `Lane <b>${escapeHtml(tradeLane)}</b>: tier gates пройдены, intel сработал.`;
  }

  const hitLines =
    ig?.hits?.length ?
      ig.hits.map((h) => `• ${escapeHtml(formatIntelHitLine(h))}`).join('\n')
    : intelReasons.length ?
      intelReasons.map((r) => `• <code>${escapeHtml(r)}</code>`).join('\n')
    : '• n/a';

  const lines = [
    `<b>[ADVICE][live_oscar_intel_block]</b>`,
    `<b>${escapeHtml(headline)}</b>`,
    statusLine,
    `Tier gates: <b>пройдены</b> (discovery/runner пороги OK)`,
    `Монета: <b>${escapeHtml(symbol)}</b> (<code>${escapeHtml(shortMintLabel(d.mint))}</code>)`,
    `Адрес: ${mintHrefHtml(d.mint, d.mint)}`,
    `Lane: <code>${escapeHtml(tradeLane)}</code>`,
    `Возраст: <b>${escapeHtml(String(d.ageMin))} min</b>`,
    `Market cap: <b>${escapeHtml(fmtUsd(d.features.market_cap_usd))}</b>`,
    `Vol 1h: <b>${escapeHtml(fmtUsd(vol1h))}</b>`,
    `Intel mode: <code>${escapeHtml(mode)}</code>`,
    `Подозрительных кошельков: <b>${badWalletCount}</b>`,
    `Swap coverage: <b>${ig?.swapCovered ? 'yes' : 'no'}</b>`,
    `Intel hits:`,
    hitLines,
  ];

  if (intelReasons.length) {
    lines.push(`Intel reasons: <code>${escapeHtml(intelReasons.join('; '))}</code>`);
  }
  if (otherReasons.length) {
    lines.push(`Другие причины skip: <code>${escapeHtml(otherReasons.join('; '))}</code>`);
  }

  return `${lines.join('\n')}\n`;
}

/** @deprecated Use {@link buildLiveOscarIntelBlockTelegramText}. */
export function buildRunnerProbeIntelSkipTelegramText(args: {
  d: EvalDecision;
  escapeHtml: (s: string) => string;
  mintHrefHtml: (mint: string, label: string) => string;
  fmtUsd: (v: number | null | undefined) => string;
}): string {
  return buildLiveOscarIntelBlockTelegramText({ ...args, tradeLane: 'runner_probe' });
}
