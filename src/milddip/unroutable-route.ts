import type { PriceVerifyVerdict } from '../papertrader/types.js';

export type UnroutableRouteStatus = 'routable' | 'unroutable' | 'unknown';

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
}): Promise<{ status: UnroutableRouteStatus; first: PriceVerifyVerdict }> {
  const first = await args.quote();
  if (isNoRoute(first)) {
    await args.sleep(args.gapMs ?? 2_000);
    const confirmation = await args.quote();
    if (isNoRoute(confirmation)) return { status: 'unroutable', first };
    return { status: 'unknown', first };
  }
  if (first.kind === 'ok') return { status: 'routable', first };
  return { status: 'unknown', first };
}
