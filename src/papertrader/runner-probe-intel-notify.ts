import type { EvalDecision } from './discovery/dip-clones.js';
import type { IntelGateHit } from './discovery/smart-lottery-intel.js';
import type { OscarIntelGateSnapshot } from './discovery/oscar-intel-gate.js';

const INTEL_HIT_LABEL_RU: Record<IntelGateHit['kind'], string> = {
  BLOCK_TRADE: 'BLOCK_TRADE (wallet_intel_decisions)',
  bad_tag: 'bot/scam tag',
  atlas_cluster: 'atlas cluster (entity_wallets)',
  scam_farm_meta: 'scam_farm_meta_cluster',
};

export function runnerProbeIntelSkipReasons(reasons: readonly string[]): string[] {
  return reasons.filter(
    (r) => r.startsWith('runner_probe_intel_') || r === 'runner_probe_intel_shadow_would_block',
  );
}

export function isRunnerProbeIntelSkipDecision(d: Pick<EvalDecision, 'reasons' | 'oscarIntel'>): boolean {
  if (runnerProbeIntelSkipReasons(d.reasons).length > 0) return true;
  return Boolean(d.oscarIntel?.required && d.oscarIntel.wouldBlock);
}

export function formatIntelHitLine(hit: IntelGateHit): string {
  const label = INTEL_HIT_LABEL_RU[hit.kind] ?? hit.kind;
  return `${label}: ${hit.wallet}`;
}

export function buildRunnerProbeIntelSkipTelegramText(args: {
  d: EvalDecision;
  escapeHtml: (s: string) => string;
  mintHrefHtml: (mint: string, label: string) => string;
  fmtUsd: (v: number | null | undefined) => string;
}): string {
  const { d, escapeHtml, mintHrefHtml, fmtUsd } = args;
  const ig = d.oscarIntel;
  const symbol = d.symbol?.trim() || '?';
  const intelReasons = runnerProbeIntelSkipReasons(d.reasons);
  const otherReasons = d.reasons.filter((r) => !intelReasons.includes(r));
  const blocked = ig?.blocked === true;
  const shadowWouldBlock =
    !blocked && (ig?.wouldBlock === true || intelReasons.includes('runner_probe_intel_shadow_would_block'));
  const mode = ig?.mode ?? 'off';

  let statusLine: string;
  if (blocked) {
    statusLine = `Покупка runner_probe <b>заблокирована</b> wallet-intel gate (mode=<code>${escapeHtml(mode)}</code>).`;
  } else if (shadowWouldBlock) {
    statusLine = `Shadow/advisory: intel <b>заблокировал бы</b> вход (mode=<code>${escapeHtml(mode)}</code>), сделка не остановлена.`;
  } else {
    statusLine = `Runner_probe eval не прошёл; есть intel-причины.`;
  }

  const hitLines =
    ig?.hits?.length ?
      ig.hits.map((h) => `• ${escapeHtml(formatIntelHitLine(h))}`).join('\n')
    : intelReasons.length ?
      intelReasons.map((r) => `• <code>${escapeHtml(r)}</code>`).join('\n')
    : '• n/a';

  const lines = [
    `<b>[ADVICE][runner_probe_intel]</b>`,
    statusLine,
    `Монета: <b>${escapeHtml(symbol)}</b>`,
    `Адрес: ${mintHrefHtml(d.mint, d.mint)}`,
    `Возраст: <b>${escapeHtml(String(d.ageMin))} min</b>`,
    `Market cap: <b>${escapeHtml(fmtUsd(d.features.market_cap_usd))}</b>`,
    `Intel mode (lane): <code>${escapeHtml(mode)}</code>`,
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

export function shouldJournalRunnerProbeIntel(ig: OscarIntelGateSnapshot | undefined): ig is OscarIntelGateSnapshot {
  return Boolean(ig?.required && ig.wouldBlock);
}
