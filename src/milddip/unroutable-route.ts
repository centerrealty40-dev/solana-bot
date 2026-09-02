import type { PriceVerifyVerdict } from '../papertrader/types.js';

export type UnroutableRouteStatus =
  | 'routable'
  | 'unroutable'
  | 'worthless'
  | 'unknown';

function isNoRoute(value: PriceVerifyVerdict): boolean {
  return (
    (value.kind === 'blocked' || value.kind === 'skipped') &&
    value.reason === 'no-route'
  );
}

export async function confirmUnroutableRoute(args: {
  quote: () => Promise<PriceVerifyVerdict>;
  sleep: (ms: number) => Promise<void>;
  gapMs?: number;
  isWorthless?: (value: PriceVerifyVerdict) => boolean;
}): Promise<{ status: UnroutableRouteStatus; first: PriceVerifyVerdict }> {
  const first = await args.quote();
  if (isNoRoute(first)) {
    await args.sleep(args.gapMs ?? 2_000);
    const confirmation = await args.quote();
    if (isNoRoute(confirmation)) return { status: 'unroutable', first };
    return { status: 'unknown', first };
  }
  if (first.kind === 'ok') {
    if (!args.isWorthless?.(first)) return { status: 'routable', first };
    await args.sleep(args.gapMs ?? 2_000);
    const confirmation = await args.quote();
    if (confirmation.kind === 'ok' && args.isWorthless(confirmation)) {
      return { status: 'worthless', first };
    }
    return { status: 'unknown', first };
  }
  return { status: 'unknown', first };
}
