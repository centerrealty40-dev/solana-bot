import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMirrorStructuralStateForTests,
  resolveMirrorStructuralMetrics,
} from "../../src/milddip/mirror-structural.js";
import { resetStructuralFallbackStateForTests } from "../../src/milddip/structural-fallback.js";

const mint = "MirrorStructuralMintxxxxxxxxxxxxxxxxxxxx1";
const nowMs = Date.parse("2026-08-20T12:00:00.000Z");

const fallbackConfig = {
  structuralFallbackEnabled: true,
  structuralFallbackMaxPerMin: 20,
  structuralFallbackMintGapMs: 0,
  structuralFallbackCacheTtlMs: 15_000,
  structuralFallbackTimeoutMs: 2_500,
  entry: { allowedDexIds: ["raydium", "pumpswap"] },
} as never;

function response(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

function geckoPool(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attributes: {
      base_token_price_usd: "1",
      reserve_in_usd: "9000",
      pool_created_at: "2026-08-20T10:00:00.000Z",
      ...overrides,
    },
    relationships: {
      base_token: { data: { id: `solana_${mint}` } },
      dex: { data: { id: "raydium" } },
    },
  };
}

describe("mirror structural own-source resolution", () => {
  beforeEach(() => {
    resetMirrorStructuralStateForTests();
    resetStructuralFallbackStateForTests();
  });

  it("calculates mcap from supply and quote, then reuses cached supply", async () => {
    const rpcImpl = vi
      .fn()
      .mockResolvedValue({
        value: {
          data: { parsed: { info: { supply: "1000000", decimals: 2 } } },
        },
      });
    const args = {
      mint,
      nowMs,
      rpcUrl: "https://rpc.example.test",
      quotePriceUsd: 2,
      registryAgeHours: 2,
      dex: {
        liquidityUsd: 5000,
        marketCapUsd: null,
        pairAgeHours: 2,
        dexId: "raydium",
      },
      fallbackConfig,
      rpcImpl: rpcImpl as never,
    };
    await expect(resolveMirrorStructuralMetrics(args)).resolves.toMatchObject({
      metrics: { marketCapUsd: 20_000 },
      sources: { marketCap: "rpc" },
    });
    await resolveMirrorStructuralMetrics({
      ...args,
      quotePriceUsd: 3,
      nowMs: nowMs + 1,
    });
    expect(rpcImpl).toHaveBeenCalledTimes(1);
  });

  it("uses Gecko liquidity and age when Dex has no structural fields", async () => {
    const fetchImpl = vi.fn(async () => response({ data: [geckoPool()] }));
    const result = await resolveMirrorStructuralMetrics({
      mint,
      nowMs,
      rpcUrl: "https://rpc.example.test",
      quotePriceUsd: null,
      registryAgeHours: null,
      dex: {
        liquidityUsd: null,
        marketCapUsd: null,
        pairAgeHours: null,
        dexId: null,
      },
      fallbackConfig,
      fetchImpl,
      rpcImpl: vi.fn().mockResolvedValue(null) as never,
    });
    expect(result).toMatchObject({
      metrics: { liquidityUsd: 9000, pairAgeHours: 2 },
      sources: { liquidity: "gecko", pairAge: "gecko", marketCap: "missing" },
    });
  });

  it("leaves mcap unavailable when token supply is missing", async () => {
    const result = await resolveMirrorStructuralMetrics({
      mint,
      nowMs,
      rpcUrl: "https://rpc.example.test",
      quotePriceUsd: 2,
      registryAgeHours: 2,
      dex: {
        liquidityUsd: 5000,
        marketCapUsd: null,
        pairAgeHours: 2,
        dexId: "raydium",
      },
      fallbackConfig,
      rpcImpl: vi.fn().mockResolvedValue(null) as never,
    });
    expect(result.metrics.marketCapUsd).toBeNull();
    expect(result.sources.marketCap).toBe("missing");
  });

  it("uses registry age before GeckoTerminal", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [geckoPool({ pool_created_at: "2026-08-20T08:00:00.000Z" })],
      }),
    );
    const result = await resolveMirrorStructuralMetrics({
      mint,
      nowMs,
      rpcUrl: "https://rpc.example.test",
      quotePriceUsd: null,
      registryAgeHours: 7,
      dex: {
        liquidityUsd: null,
        marketCapUsd: null,
        pairAgeHours: null,
        dexId: null,
      },
      fallbackConfig,
      fetchImpl,
      rpcImpl: vi.fn().mockResolvedValue(null) as never,
    });
    expect(result.metrics.pairAgeHours).toBe(7);
    expect(result.sources.pairAge).toBe("registry");
  });
});
