import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LIVE_SCHEMA_V1,
  LIVE_SCHEMA_V2,
  parseLiveEventBody,
  safeParseLiveEventBody,
  type LiveEventBody,
} from '../src/live/events.js';
import { newLiveIntentId } from '../src/live/intent.js';
import { appendLiveJsonlEvent, configureLiveStore, liveEventDefaultFsync } from '../src/live/store-jsonl.js';

const sampleIntent = '550e8400-e29b-41d4-a716-446655440000';

function mergeEnvelope(strategyId: string, body: LiveEventBody, ts = 1_700_000_000_000): Record<string, unknown> {
  return {
    ts,
    strategyId,
    channel: 'live',
    liveSchema: LIVE_SCHEMA_V1,
    ...body,
  };
}

describe('W8.0-p1 live JSONL contract', () => {
  it('parses every kind (round-trip shape)', () => {
    const bodies: LiveEventBody[] = [
      {
        kind: 'live_boot',
        liveStrategyEnabled: false,
        executionMode: 'dry_run',
        profile: 'oscar',
        phase: 'W8.0-p1',
      },
      { kind: 'live_shutdown', sig: 'SIGTERM' },
      {
        kind: 'heartbeat',
        uptimeSec: 1,
        openPositions: 0,
        closedTotal: 0,
        liveStrategyEnabled: false,
        executionMode: 'dry_run',
        note: 'test',
      },
      {
        kind: 'execution_attempt',
        intentId: sampleIntent,
        side: 'buy',
        mint: 'So11111111111111111111111111111111111111112',
        executionMode: 'dry_run',
        quoteSnapshot: {},
      },
      {
        kind: 'execution_result',
        intentId: sampleIntent,
        status: 'sim_ok',
        simulated: true,
        unitsConsumed: 120_000,
      },
      {
        kind: 'execution_skip',
        intentId: sampleIntent,
        reason: 'feature_not_implemented',
        detail: 'phase1',
      },
      { kind: 'execution_skip', reason: 'strategy_disabled' },
      {
        kind: 'risk_block',
        limit: 'max_open_positions',
        detail: { open: 5, max: 5 },
      },
      {
        kind: 'capital_skip',
        reason: 'insufficient_free_balance_no_positions',
        freeUsdEstimate: 5,
        requiredFreeUsd: 20,
        shortfallUsd: 15,
      },
      {
        kind: 'capital_rotate_close',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        unrealizedPnlUsd: 3.5,
        txSignature: null,
      },
      {
        kind: 'live_position_open',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        openTrade: { mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'X' },
      },
      {
        kind: 'live_position_dca',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        openTrade: { mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'X' },
      },
      {
        kind: 'live_position_partial_sell',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        openTrade: { mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'X' },
      },
      {
        kind: 'live_position_close',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        closedTrade: { mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', exitTs: 1 },
      },
      {
        kind: 'live_whitelist_skip',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        symbol: 'ABC',
        lane: 'stream',
      },
      {
        kind: 'live_discovery_eval',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pass: false,
        reasons: ['dip_no_window_pass(test)'],
        symbol: 'ABC',
        lane: 'post',
        source: 'pumpswap',
        ageMin: 2222,
        entryPath: 'post_migration',
      },
      {
        kind: 'live_discovery_eval',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pass: true,
        reasons: [],
        symbol: 'OK',
      },
      {
        kind: 'live_discovery_tick_skip',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reason: 'reeval_throttle',
        discoveryReevalSec: 60,
      },
      {
        kind: 'live_discovery_universe_miss',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reasons: ['volume_5m_0<20000', 'crowded_out_snapshot_candidate_limit_300'],
        snapshotHint: '{"price_usd":1}',
      },
      {
        kind: 'live_discovery_skip_open',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reason: 'price_verify:blocked',
        symbol: 'ABC',
        detail: '{"slipPct":1.2}',
      },
      {
        kind: 'live_exit_verify_defer',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        context: 'close',
        phase: 'escalate_proceed',
        consecutiveDefers: 60,
        verdictSummary: 'blocked:slip-too-high',
        exitReason: 'TIMEOUT',
      },
      {
        kind: 'live_periodic_self_heal',
        ok: true,
        reconcileOk: true,
        staleOpensObserved: 1,
        staleOpensForced: 0,
        staleOpensForceCloseDisabled: 1,
        tailSweepsAttempted: 0,
        tailSweepsOk: 0,
        note: 'stale_open_force_close_disabled',
      },
    ];
    for (const b of bodies) {
      const again = parseLiveEventBody(JSON.parse(JSON.stringify(b)));
      expect(again).toEqual(b);
      const line = JSON.stringify(mergeEnvelope('live-oscar', b));
      const row = JSON.parse(line) as Record<string, unknown>;
      expect(row.liveSchema).toBe(1);
      expect(row.channel).toBe('live');
      expect(parseLiveEventBody(row)).toEqual(b);
    }
  });

  it('parses Stage 1.1 Shyft shadow kinds (status + price) so they are journaled, not dropped', () => {
    const status: LiveEventBody = {
      kind: 'live_shyft_shadow_status',
      status: 'connected',
      detail: 'https://grpc.fra.shyft.to',
    };
    const price: LiveEventBody = {
      kind: 'live_shyft_shadow_price',
      mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      lane: 'post',
      surface: 'mtm',
      streamPriceUsd: 0.0001234,
      pgPriceUsd: 0.0001201,
      streamTsMs: 1_700_000_000_500,
      pgSnapshotTsMs: 1_700_000_000_000,
      pgPriceAgeMs: 500,
      streamVsPgLagMs: 500,
      streamVsPgPriceDiffPct: 2.75,
      streamSlot: 123456,
    };
    for (const b of [status, price]) {
      expect(safeParseLiveEventBody(JSON.parse(JSON.stringify(b))).success).toBe(true);
      expect(parseLiveEventBody(JSON.parse(JSON.stringify(b)))).toEqual(b);
    }
    // nullable PG fields (no PG snapshot available) still parse
    const priceNoPg: LiveEventBody = {
      kind: 'live_shyft_shadow_price',
      mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      lane: 'post',
      surface: 'entry',
      streamPriceUsd: 0.0001234,
      pgPriceUsd: null,
      streamTsMs: 1_700_000_000_500,
      pgSnapshotTsMs: null,
      pgPriceAgeMs: null,
      streamVsPgLagMs: null,
      streamVsPgPriceDiffPct: null,
    };
    expect(safeParseLiveEventBody(JSON.parse(JSON.stringify(priceNoPg))).success).toBe(true);
  });

  it('rejects invalid intentId on execution_attempt', () => {
    const bad = safeParseLiveEventBody({
      kind: 'execution_attempt',
      intentId: 'not-a-uuid',
      side: 'buy',
      mint: 'So11111111111111111111111111111111111111112',
      executionMode: 'dry_run',
    });
    expect(bad.success).toBe(false);
  });

  it('newLiveIntentId parses as UUID v4', () => {
    const id = newLiveIntentId();
    expect(safeParseLiveEventBody({ kind: 'execution_attempt', intentId: id, side: 'sell', mint: 'm', executionMode: 'simulate' }).success).toBe(true);
  });

  it('liveEventDefaultFsync matches §7 basics', () => {
    expect(liveEventDefaultFsync({ kind: 'heartbeat', uptimeSec: 0, openPositions: 0, closedTotal: 0, liveStrategyEnabled: false, executionMode: 'dry_run' })).toBe(false);
    expect(liveEventDefaultFsync({ kind: 'live_boot', liveStrategyEnabled: false, executionMode: 'dry_run' })).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'execution_result',
        intentId: sampleIntent,
        status: 'sim_ok',
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_position_open',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        openTrade: {},
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_exit_verify_defer',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        context: 'partial_sell',
        phase: 'defer',
        consecutiveDefers: 1,
        verdictSummary: 'blocked:impact-too-high',
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_reconcile_report',
        ok: true,
        reconcileStatus: 'skipped',
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_whitelist_skip',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_discovery_eval',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reasons: ['x'],
      }),
    ).toBe(false);
    expect(
      liveEventDefaultFsync({
        kind: 'live_discovery_skip_open',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reason: 'safety:x',
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_discovery_tick_skip',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reason: 'reeval_throttle',
      }),
    ).toBe(false);
    expect(
      liveEventDefaultFsync({
        kind: 'live_discovery_universe_miss',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reasons: ['x'],
      }),
    ).toBe(false);
  });

  it('parses live_reconcile_report (liveSchema envelope 2 at write time)', () => {
    const body: LiveEventBody = {
      kind: 'live_reconcile_report',
      ok: false,
      reconcileStatus: 'mismatch',
      mode: 'block_new',
      mismatches: [{ mint: 'm1', expectedRaw: '10', actualRaw: '9' }],
      txAnchorSample: { checked: 2, notFound: [], rpcErrors: 0 },
    };
    expect(parseLiveEventBody(JSON.parse(JSON.stringify(body)))).toEqual(body);
    const row = {
      ts: 1,
      strategyId: 'live-oscar',
      channel: 'live',
      liveSchema: LIVE_SCHEMA_V2,
      ...body,
    };
    expect(row.liveSchema).toBe(LIVE_SCHEMA_V2);
    expect(parseLiveEventBody(row)).toEqual(body);
  });
});

describe('appendLiveJsonlEvent integration', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `live-p1-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    configureLiveStore({ storePath: tmp, strategyId: 'live-oscar' });
  });
  afterEach(() => {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  });

  it('writes validated line with envelope', () => {
    appendLiveJsonlEvent({
      kind: 'live_boot',
      liveStrategyEnabled: false,
      executionMode: 'dry_run',
      phase: 'test',
    });
    const line = fs.readFileSync(tmp, 'utf8').trim();
    const j = JSON.parse(line) as Record<string, unknown>;
    expect(j.kind).toBe('live_boot');
    expect(j.liveSchema).toBe(LIVE_SCHEMA_V1);
    expect(j.strategyId).toBe('live-oscar');
    expect(j.channel).toBe('live');
    expect(typeof j.ts).toBe('number');
  });

  it('writes live_reconcile_report with liveSchema 2', () => {
    appendLiveJsonlEvent({
      kind: 'live_reconcile_report',
      ok: true,
      reconcileStatus: 'ok',
    });
    const line = fs.readFileSync(tmp, 'utf8').trim();
    const j = JSON.parse(line) as Record<string, unknown>;
    expect(j.kind).toBe('live_reconcile_report');
    expect(j.liveSchema).toBe(LIVE_SCHEMA_V2);
  });

  it('skips invalid payloads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appendLiveJsonlEvent({ kind: 'heartbeat' });
    expect(fs.existsSync(tmp)).toBe(false);
    warn.mockRestore();
  });
});
