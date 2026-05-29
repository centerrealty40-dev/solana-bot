import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';

/** Resolve base58 pubkey from keypair file path (JSON array or Phantom base58 line). */
export function pubkeyFromWalletSecretPath(secretPath: string): string {
  const kp = loadLiveKeypairFromSecretEnv(secretPath);
  return kp.publicKey.toBase58();
}
