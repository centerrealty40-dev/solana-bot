export const JUPITER_QUOTE_URL_DEFAULT = 'https://api.jup.ag/swap/v1/quote';
export const JUPITER_SWAP_URL_DEFAULT = 'https://api.jup.ag/swap/v1/swap';
export const JUPITER_PRICE_V3_URL_DEFAULT = 'https://api.jup.ag/price/v3';

export function jupiterApiKey(): string | undefined {
  const key = process.env.JUPITER_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

export function jupiterJsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...extra,
  };
  const key = jupiterApiKey();
  if (key) headers['x-api-key'] = key;
  return headers;
}

export function jupiterPriceV3Url(id: string): string {
  const url = new URL(JUPITER_PRICE_V3_URL_DEFAULT);
  url.searchParams.set('ids', id);
  return url.toString();
}
