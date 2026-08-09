import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetLeaderMintAllowlistForTests,
  hasLeaderBought,
  markLeaderBought,
  requireLeaderBoughtEnabled,
} from '../../src/volgreen/leader-mint-allowlist.js';

describe('leader-mint-allowlist', () => {
  beforeEach(() => {
    __resetLeaderMintAllowlistForTests();
  });

  it('records leader buys and gates require flag', () => {
    const mint = 'LeaderAllow11111111111111111111111111111111';
    expect(hasLeaderBought(mint)).toBe(false);
    expect(markLeaderBought(mint, 1000)).toBe(true);
    expect(markLeaderBought(mint, 2000)).toBe(false);
    expect(hasLeaderBought(mint)).toBe(true);
    expect(requireLeaderBoughtEnabled({ VOL_GREEN_REQUIRE_LEADER_BOUGHT: '1' })).toBe(true);
    expect(requireLeaderBoughtEnabled({ VOL_GREEN_REQUIRE_LEADER_BOUGHT: '0' })).toBe(false);
  });
});
