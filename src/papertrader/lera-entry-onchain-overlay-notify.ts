import type { EvalDecision } from './discovery/dip-clones.js';
import type { OpenTrade } from './types.js';
import type {
  LeraEntryOnchainOverlayResult,
  LeraOverlayHit,
  LeraOverlayHitKind,
} from './entry-lera-onchain-overlay.js';
import { shortMintLabel } from '../live/mint-file-watch-telegram-format.js';

const HIT_LABEL_RU: Record<LeraOverlayHitKind, string> = {
  BLOCK_TRADE: 'BLOCK_TRADE (wallet_intel_decisions)',
  bad_tag: 'bot/scam tag',
  atlas_cluster: 'atlas cluster / wash-связка',
  scam_farm_meta: 'scam_farm_meta_cluster',
  coord_sell: 'координированные продажи',
  whale_dump: 'активный whale dump',
  multi_large_sell: 'несколько крупных sells',
};

export function formatLeraOverlayHitLine(hit: LeraOverlayHit): string {
  const label = HIT_LABEL_RU[hit.kind] ?? hit.kind;
  const amt =
    hit.amountUsd != null && Number.isFinite(hit.amountUsd)
      ? ` $${Math.round(hit.amountUsd)}`
      : '';
  const age = hit.ageSec != null && Number.isFinite(hit.ageSec) ? ` ${Math.round(hit.ageSec)}s ago` : '';
  return `${label}: ${hit.wallet}${amt}${age}`;
}

export function shouldNotifyLeraOverlayShadowBuy(
  overlay: LeraEntryOnchainOverlayResult | null | undefined,
): overlay is LeraEntryOnchainOverlayResult {
  if (!overlay) return false;
  if (!overlay.wouldBlock) return false;
  if (overlay.verdict !== 'SKIP' && overlay.verdict !== 'WAIT') return false;
  if (overlay.reasons.includes('overlay_disabled')) return false;
  if (overlay.reasons.includes('overlay_pg_error')) return false;
  return true;
}

export function buildLeraOverlayShadowBuyTelegramText(args: {
  d: EvalDecision;
  ot: Pick<OpenTrade, 'mint' | 'symbol' | 'totalInvestedUsd' | 'legs' | 'entryTs'>;
  overlay: LeraEntryOnchainOverlayResult;
  strategyId: string;
  escapeHtml: (s: string) => string;
  mintHrefHtml: (mint: string, label: string) => string;
  fmtUsd: (v: number | null | undefined) => string;
}): string {
  const { d, ot, overlay, strategyId, escapeHtml, mintHrefHtml, fmtUsd } = args;
  const symbol = ot.symbol?.trim() || d.symbol?.trim() || '?';
  const entryPx = ot.legs[0]?.marketPrice ?? ot.legs[0]?.price ?? d.features.price_usd;
  const verdictRu = overlay.verdict === 'SKIP' ? 'SKIP — не покупать' : 'WAIT — подождать';
  const hitLines =
    overlay.hits.length > 0
      ? overlay.hits.map((h) => `• ${escapeHtml(formatLeraOverlayHitLine(h))}`).join('\n')
      : overlay.reasons
          .filter((r) => r !== 'shadow_allow')
          .map((r) => `• <code>${escapeHtml(r)}</code>`)
          .join('\n') || '• n/a';

  const lines = [
    `<b>[ADVICE][lera_overlay_shadow_buy]</b>`,
    `<b>LERA — покупка прошла, аналитика заблокировала бы</b>`,
    `Shadow A/B: сделка <b>исполнена</b>, on-chain overlay <b>не остановил</b> вход — сравни с Oscar (TA-only).`,
    `Стратегия: <code>${escapeHtml(strategyId)}</code>`,
    `Монета: <b>${escapeHtml(symbol)}</b> (<code>${escapeHtml(shortMintLabel(ot.mint))}</code>)`,
    `Адрес: ${mintHrefHtml(ot.mint, ot.mint)}`,
    `Вердикт аналитики: <b>${escapeHtml(verdictRu)}</b> (mode=shadow)`,
    `Причины: <code>${escapeHtml(overlay.reasons.join('; '))}</code>`,
    `Цена входа: <b>${escapeHtml(fmtUsd(entryPx))}</b>`,
    `Размер ноги: <b>${escapeHtml(fmtUsd(ot.totalInvestedUsd))}</b>`,
    `Market cap: <b>${escapeHtml(fmtUsd(d.features.market_cap_usd))}</b>`,
    `Недавние sells: <b>${overlay.recentSellCount}</b> (крупных: ${overlay.largeSellCount}, $${Math.round(overlay.totalSellUsd)} за ${overlay.lookbackSec}s)`,
    `On-chain hits:`,
    hitLines,
    `⏱ Смотри хронологически куда уйдёт цена — зря купили или overlay был прав.`,
  ];

  return `${lines.join('\n')}\n`;
}
