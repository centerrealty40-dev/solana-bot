import { jupiterJsonHeaders } from '../core/jupiter-http.js';

const TRIGGER_ORDERS_PRO = 'https://api.jup.ag/trigger/v1/getTriggerOrders';
const TRIGGER_ORDERS_LITE = 'https://lite-api.jup.ag/trigger/v1/getTriggerOrders';
const MAX_PAGES = 8;

export type JupiterActiveSellOrders = {
  active: boolean;
  orderCount: number;
  totalRemainingRaw: string;
  source: 'pro' | 'lite' | 'none';
};

type TriggerOrderRow = {
  inputMint?: string;
  rawRemainingMakingAmount?: string;
  remainingMakingAmount?: string;
};

function remainingRawFromOrder(order: TriggerOrderRow): bigint {
  const raw = order.rawRemainingMakingAmount ?? order.remainingMakingAmount ?? '0';
  try {
    return BigInt(raw);
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.floor(n)) : 0n;
  }
}

function parseOrdersPage(body: Record<string, unknown>): TriggerOrderRow[] {
  const orders = body.orders;
  if (!Array.isArray(orders)) return [];
  return orders.filter((o) => o && typeof o === 'object') as TriggerOrderRow[];
}

function hasMorePages(body: Record<string, unknown>, page: number): boolean {
  const hasMore = body.hasMoreData;
  if (hasMore === true || hasMore === 'true') return true;
  const totalPages = Number(body.totalPages ?? 0);
  if (Number.isFinite(totalPages) && totalPages > page) return true;
  const totalItems = Number(body.totalItems ?? 0);
  const orders = parseOrdersPage(body);
  return totalItems > page * orders.length && orders.length >= 10;
}

async function fetchTriggerOrdersPage(
  baseUrl: string,
  wallet: string,
  inputMint: string,
  page: number,
): Promise<Record<string, unknown> | null> {
  const url = new URL(baseUrl);
  url.searchParams.set('user', wallet);
  url.searchParams.set('orderStatus', 'active');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('page', String(page));
  try {
    const ac = new AbortController();
    const tt = setTimeout(() => ac.abort(), 12_000);
    try {
      const resp = await fetch(url.toString(), {
        method: 'GET',
        signal: ac.signal,
        headers: jupiterJsonHeaders(),
      });
      if (!resp.ok) return null;
      const raw = (await resp.json()) as unknown;
      return typeof raw === 'object' && raw != null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    } finally {
      clearTimeout(tt);
    }
  } catch {
    return null;
  }
}

async function fetchActiveSellOrdersFromBase(
  baseUrl: string,
  wallet: string,
  inputMint: string,
): Promise<{ orders: TriggerOrderRow[]; ok: boolean }> {
  const all: TriggerOrderRow[] = [];
  let sawOk = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await fetchTriggerOrdersPage(baseUrl, wallet, inputMint, page);
    if (!body) return { orders: all, ok: sawOk };
    sawOk = true;
    const pageOrders = parseOrdersPage(body);
    all.push(...pageOrders);
    if (!hasMorePages(body, page)) break;
  }
  return { orders: all, ok: sawOk };
}

/**
 * Active Jupiter Trigger sell orders: leader selling `inputMint` (tokens escrowed off-wallet).
 */
export async function leaderHasActiveJupiterSellOrders(
  wallet: string,
  inputMint: string,
): Promise<JupiterActiveSellOrders> {
  const pro = await fetchActiveSellOrdersFromBase(TRIGGER_ORDERS_PRO, wallet, inputMint);
  let orders = pro.orders;
  let source: JupiterActiveSellOrders['source'] = pro.ok ? 'pro' : 'none';

  if (!pro.ok) {
    const lite = await fetchActiveSellOrdersFromBase(TRIGGER_ORDERS_LITE, wallet, inputMint);
    orders = lite.orders;
    source = lite.ok ? 'lite' : 'none';
  }

  let total = 0n;
  let count = 0;
  for (const order of orders) {
    if (order.inputMint && order.inputMint !== inputMint) continue;
    const rem = remainingRawFromOrder(order);
    if (rem > 0n) {
      count += 1;
      total += rem;
    }
  }

  return {
    active: count > 0,
    orderCount: count,
    totalRemainingRaw: total.toString(),
    source,
  };
}
