import type { HlAccountMargin } from './twap/hyperliquid-meta.js';
import { freeMarginUsd, hasMarginForNewOpen } from './twap/live/account-margin.js';
import type { HlTwapExchangeClient } from './twap/live/exchange-client.js';
import { flattenCoinOnExchange } from './twap/live/flatten-position.js';
import type { OrderFillResult } from './twap/live/types.js';

/** Collateral for a gross-notional open leg. */
export function oscarLegMarginUsd(grossUsd: number, leverage: number): number {
  return grossUsd / Math.max(1, leverage);
}

/** True when account has free collateral for another open (+ reserve). */
export function oscarHasMarginForOpen(
  account: HlAccountMargin,
  marginUsd: number,
  reserveUsd: number,
): boolean {
  return hasMarginForNewOpen(account, new Map(), marginUsd, reserveUsd);
}

export function oscarFreeMarginUsd(account: HlAccountMargin): number {
  return freeMarginUsd(account);
}

export function oscarRequestedGrossUsd(
  fill: OrderFillResult,
  marginUsd: number,
  leverage: number,
): number {
  return fill.requestedNotionalUsd ?? marginUsd * leverage;
}

/**
 * Minimum gross fill vs requested (85% ratio, no TWAP $50 absolute floor).
 * Oscar staged legs are intentionally $30–$40; the TWAP $50 floor would reject full fills.
 */
export function oscarOpenFillAcceptable(filledGrossUsd: number, requestedGrossUsd: number): boolean {
  if (filledGrossUsd <= 0 || requestedGrossUsd <= 0) return false;
  const v = process.env.HL_TWAP_LIVE_OPEN_MIN_FILL_RATIO?.trim();
  const ratio =
    v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1
      ? Number(v)
      : 0.85;
  return filledGrossUsd >= requestedGrossUsd * ratio;
}

export type UnwindRejectedOpenResult = {
  flat: boolean;
  remainingAbsSize: number;
};

/** Flatten a rejected partial open on exchange (live only); verify HL flat before returning. */
export async function unwindOscarRejectedOpen(
  client: HlTwapExchangeClient,
  coin: string,
  displaySymbol: string,
  fill: OrderFillResult,
  markPx: number,
  logPrefix: string,
): Promise<UnwindRejectedOpenResult> {
  if (client.mode !== 'live' || fill.sizeBase <= 0) {
    return { flat: true, remainingAbsSize: 0 };
  }
  try {
    const { flat, remainingAbsSize } = await flattenCoinOnExchange(
      client,
      coin,
      displaySymbol,
      markPx,
      'close',
    );
    if (!flat) {
      console.error(
        `${logPrefix} unwind ${coin} incomplete: remaining ${remainingAbsSize.toFixed(6)} base (~$${(remainingAbsSize * markPx).toFixed(2)})`,
      );
    }
    return { flat, remainingAbsSize };
  } catch (e) {
    console.warn(`${logPrefix} unwind ${coin} fill failed`, String(e));
    const remaining = Math.abs(await client.getPositionSzi(coin));
    return { flat: remaining <= 0, remainingAbsSize: remaining };
  }
}

export type OscarOpenFillMeta = {
  requestedGrossUsd: number;
  filledGrossUsd: number;
  partialFill: boolean;
  freeMarginAtOpen?: number;
};

export function oscarOpenFillMeta(
  fill: OrderFillResult,
  marginUsd: number,
  leverage: number,
  freeMarginAtOpen?: number,
): OscarOpenFillMeta {
  const requestedGrossUsd = oscarRequestedGrossUsd(fill, marginUsd, leverage);
  const filledGrossUsd = fill.notionalUsd;
  const partialFill =
    fill.partialFill ??
    (requestedGrossUsd > 0 && filledGrossUsd > 0 && filledGrossUsd < requestedGrossUsd * 0.95);
  return { requestedGrossUsd, filledGrossUsd, partialFill, freeMarginAtOpen };
}

export type OscarBuyLegOk = {
  ok: true;
  fillPx: number;
  grossUsd: number;
  marginUsd: number;
  meta: OscarOpenFillMeta;
};

export type OscarBuyLegReject = {
  ok: false;
  reason: 'insufficient_margin' | 'fill_too_small' | 'order_failed' | 'unwind_failed';
  meta: OscarOpenFillMeta;
  unwindRemainingAbsSize?: number;
};

export type OscarBuyLegResult = OscarBuyLegOk | OscarBuyLegReject;

/** Open or DCA buy with margin pre-check and partial-fill rejection (live only). */
export async function tryOscarBuyLeg(args: {
  client: HlTwapExchangeClient;
  coin: string;
  displaySymbol: string;
  grossUsd: number;
  leverage: number;
  markPx: number;
  marginReserveUsd: number;
  accountMargin: HlAccountMargin | null;
  logPrefix: string;
  intent: 'open' | 'dca';
}): Promise<OscarBuyLegResult> {
  const marginUsd = oscarLegMarginUsd(args.grossUsd, args.leverage);
  const requestedGrossUsd = args.grossUsd;
  const freeMarginAtOpen =
    args.accountMargin != null ? oscarFreeMarginUsd(args.accountMargin) : undefined;

  if (args.client.mode === 'live' && args.accountMargin) {
    if (!oscarHasMarginForOpen(args.accountMargin, marginUsd, args.marginReserveUsd)) {
      console.log(
        `${args.logPrefix} skip ${args.coin}: insufficient_margin (free ~$${freeMarginAtOpen!.toFixed(0)}, need $${marginUsd.toFixed(0)}+$${args.marginReserveUsd})`,
      );
      return {
        ok: false,
        reason: 'insufficient_margin',
        meta: { requestedGrossUsd, filledGrossUsd: 0, partialFill: false, freeMarginAtOpen },
      };
    }
  }

  try {
    const fill = await args.client.marketOrder({
      coin: args.coin,
      displaySymbol: args.displaySymbol,
      side: 'buy',
      notionalUsd: marginUsd,
      markPx: args.markPx,
      reduceOnly: false,
      intent: args.intent,
    });
    const meta = oscarOpenFillMeta(fill, marginUsd, args.leverage, freeMarginAtOpen);
    // Oscar legs are $30–$40 gross; TWAP fill metadata may carry $50 min floor — use leg intent.
    meta.requestedGrossUsd = requestedGrossUsd;
    meta.partialFill =
      requestedGrossUsd > 0 &&
      meta.filledGrossUsd > 0 &&
      meta.filledGrossUsd < requestedGrossUsd * 0.95;
    if (
      args.client.mode === 'live' &&
      !oscarOpenFillAcceptable(meta.filledGrossUsd, meta.requestedGrossUsd)
    ) {
      console.warn(
        `${args.logPrefix} ${args.intent} ${args.coin} rejected: fill $${meta.filledGrossUsd.toFixed(2)} too small (requested ~$${meta.requestedGrossUsd.toFixed(0)})`,
      );
      const unwind = await unwindOscarRejectedOpen(
        args.client,
        args.coin,
        args.displaySymbol,
        fill,
        args.markPx,
        args.logPrefix,
      );
      if (!unwind.flat) {
        return {
          ok: false,
          reason: 'unwind_failed',
          meta,
          unwindRemainingAbsSize: unwind.remainingAbsSize,
        };
      }
      return { ok: false, reason: 'fill_too_small', meta };
    }
    return {
      ok: true,
      fillPx: fill.fillPx,
      grossUsd: fill.notionalUsd,
      marginUsd,
      meta,
    };
  } catch (e) {
    console.error(`${args.logPrefix} ${args.intent} leg failed ${args.coin}`, String(e));
    return {
      ok: false,
      reason: 'order_failed',
      meta: { requestedGrossUsd, filledGrossUsd: 0, partialFill: false, freeMarginAtOpen },
    };
  }
}
