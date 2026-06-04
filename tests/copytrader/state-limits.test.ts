import { describe, expect, it } from 'vitest';
import { canScheduleProportionalAdd, positionRoomUsd } from '../../src/copytrader/state.js';

describe('unlimited copy-trader caps (env 0)', () => {
  it('positionRoomUsd is unlimited when maxPositionUsd=0', () => {
    expect(positionRoomUsd({ maxPositionUsd: 0 }, { sizeUsd: 600 } as never)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('allows any proportional add when mins and max are 0', () => {
    expect(
      canScheduleProportionalAdd({ minProportionalAddUsd: 0, maxPositionUsd: 0 }, { sizeUsd: 600 } as never, 1.5),
    ).toBe(true);
  });
});
