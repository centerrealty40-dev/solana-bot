export type ExitRefireDecision = 'settle_closed' | 'refire' | 'give_up';

export function decideExitRefire(args: {
  lane: string | null | undefined;
  sellReason: string | null | undefined;
  fraction: number;
  attemptsUsed: number;
  maxAttempts: number;
  onchainRaw: bigint;
  dustRaw: bigint;
}): ExitRefireDecision {
  if (args.lane !== 'leader_mirror') return 'give_up';
  if (args.sellReason !== 'confirm_timeout') return 'give_up';
  if (args.fraction !== 1) return 'give_up';
  if (args.maxAttempts <= 0 || args.attemptsUsed >= args.maxAttempts) return 'give_up';
  if (args.onchainRaw <= args.dustRaw) return 'settle_closed';
  return 'refire';
}
