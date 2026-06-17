/**
 * Shyft shadow in-memory state (Stage 1.1, 1.11.467).
 *
 * Module-level singleton shared between the gRPC consumer (writer) and the comparison points in
 * `papertrader/main.ts` / tracker (readers). Kept free of any gRPC import so the paper hot-path can
 * read the last stream price without pulling in `@triton-one/yellowstone-grpc`.
 *
 * **Observability only.** Readers MUST NOT feed these values into any trading gate / eval / execution
 * decision in Stage 1.1 — this is pure shadow measurement.
 */

export interface ShadowStreamPrice {
  priceUsd: number;
  /** Local epoch ms when the stream tick was observed. */
  streamTsMs: number;
  /** Stream slot, when available. */
  slot: number | null;
}

let enabled = false;
let maxAgeMs = 60_000;
const lastByMint = new Map<string, ShadowStreamPrice>();
let watched: ReadonlySet<string> = new Set();
let onMintsChanged: ((mints: string[]) => void) | null = null;

/** Enable/disable shadow reads. When `false`, `getShyftShadowStreamPrice` always returns `null`. */
export function setShyftShadowEnabled(v: boolean): void {
  enabled = v;
}

export function isShyftShadowEnabled(): boolean {
  return enabled;
}

/** Max age (ms) a stored stream price may have to still be returned by `getShyftShadowStreamPrice`. */
export function setShyftShadowMaxAgeMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) maxAgeMs = ms;
}

/** Consumer writes the latest observed stream price for a mint. */
export function recordShyftShadowStreamPrice(mint: string, price: ShadowStreamPrice): void {
  if (!mint) return;
  lastByMint.set(mint, price);
}

/**
 * Latest stream price for a mint, or `null` when shadow is disabled, unseen, or older than `maxAgeMs`.
 * @param nowMs override for tests; defaults to `Date.now()`.
 */
export function getShyftShadowStreamPrice(
  mint: string,
  nowMs: number = Date.now(),
): ShadowStreamPrice | null {
  if (!enabled) return null;
  const p = lastByMint.get(mint);
  if (!p) return null;
  if (nowMs - p.streamTsMs > maxAgeMs) return null;
  return p;
}

/**
 * Host pushes the current watched/open mint set. Triggers the registered consumer callback only when
 * the set actually changes (avoids gRPC re-subscribe storms — RC-4).
 */
export function setShyftShadowWatchedMints(mints: Iterable<string>): void {
  const next = new Set<string>();
  for (const m of mints) {
    if (m) next.add(m);
  }
  if (next.size === watched.size) {
    let identical = true;
    for (const m of next) {
      if (!watched.has(m)) {
        identical = false;
        break;
      }
    }
    if (identical) return;
  }
  watched = next;
  // Drop cached prices for mints we no longer watch — keeps memory bounded over long uptimes.
  for (const m of [...lastByMint.keys()]) {
    if (!next.has(m)) lastByMint.delete(m);
  }
  if (onMintsChanged) onMintsChanged([...next]);
}

export function getShyftShadowWatchedMints(): string[] {
  return [...watched];
}

/** Consumer registers a callback fired whenever the watched mint set changes. */
export function onShyftShadowMintsChanged(cb: ((mints: string[]) => void) | null): void {
  onMintsChanged = cb;
}

/** Test-only reset of all module state. */
export function __resetShyftShadowStateForTests(): void {
  enabled = false;
  maxAgeMs = 60_000;
  lastByMint.clear();
  watched = new Set();
  onMintsChanged = null;
}
