/**
 * Unified Position Engine — single lifecycle + ledger for live Oscar positions.
 * Chain-confirmed facts are SSOT; journal is a projection.
 */

/** Lifecycle phase for one mint (strict ordering). */
export type PositionPhase = 'opening' | 'acquiring' | 'managed' | 'exiting' | 'closed';

/** Buy leg recorded only after on-chain confirm. */
export interface ConfirmedBuyLeg {
  txSignature: string;
  sizeUsd: number;
  effectivePriceUsd: number;
  marketPriceUsd: number;
  /** SPL raw amount credited on wallet for this leg. */
  rawTokens: bigint;
  confirmedTs: number;
  reason: 'open' | 'entry_split' | 'dca' | 'staged_avg' | 'scale_in';
}

/** Sell leg with chain proceeds. */
export interface ConfirmedSellLeg {
  txSignature: string;
  solProceedsLamports: bigint;
  tokensSoldRaw: bigint;
  proceedsUsd: number;
  reason: string;
  confirmedTs: number;
}

export interface ChainSnapshot {
  rawTokenBalance: bigint;
  decimals: number;
  priceUsd: number;
  /** Wallet mint USD minus copy-leader attribution when applicable. */
  oscarAttributedUsd: number;
}

/** Entry-split progress (planned vs done legs with usd > 0). */
export interface EntrySplitProgress {
  /** True when entry-split v2 plan is active. */
  active: boolean;
  plannedLegs: number;
  completedLegs: number;
  allLegsDone: boolean;
}

export interface PositionSnapshot {
  mint: string;
  phase: PositionPhase;
  confirmedBuys: ConfirmedBuyLeg[];
  confirmedSells: ConfirmedSellLeg[];
  entrySplit: EntrySplitProgress;
  chain: ChainSnapshot;
  /** Optimistic journal totalInvestedUsd (may exceed chain). */
  journalInvestedUsd: number;
  /** In-memory sell attempt in flight. */
  exitInFlight: boolean;
}

export type ExitGuardDecision =
  | { allowed: true }
  | {
      allowed: false;
      invariant: 'UPE-I1' | 'UPE-I2' | 'UPE-I5';
      reason: string;
    };

export interface ExitGuardRequest {
  exitReason: string;
  /** Policy-only emergency (mem-swan profile) still subject to UPE-I1/I2. */
  emergencyExit?: boolean;
}

export interface PositionEngineConfig {
  /** Min chain/journal cost ratio before full exit (default 0.55). */
  minChainJournalRatio: number;
  /** Allow LIQ_DRAIN during ACQUIRING. */
  allowLiqDrainDuringAcquire: boolean;
  enabled: boolean;
}

export interface ClosePnlResult {
  costBasisUsd: number;
  totalProceedsUsd: number;
  netPnlUsd: number;
  netPnlPct: number;
  /** True when close used chain-clamped denominator (desync). */
  desyncAdjusted: boolean;
}
