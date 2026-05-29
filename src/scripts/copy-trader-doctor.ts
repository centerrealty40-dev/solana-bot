/**
 * Verify copy-trader risky wallet setup (no secrets printed).
 *
 *   npm run copy-trader:doctor
 */
import { loadCopyTraderConfig } from '../copytrader/config.js';
import { pubkeyFromWalletSecretPath } from '../copytrader/wallet-pubkey.js';
import fs from 'node:fs';
import path from 'node:path';

async function main(): Promise<void> {
  const riskyKeyDefault = path.join('data', 'live', 'live-oscar-risky.keypair.json');
  const keyPath = process.env.COPY_TRADER_WALLET_SECRET?.trim() || riskyKeyDefault;

  console.log('[copy-trader:doctor] key file path:', keyPath);
  if (!fs.existsSync(keyPath)) {
    console.error('MISSING key file — upload Phantom base58 or JSON to:', riskyKeyDefault);
    process.exit(1);
  }

  const st = fs.statSync(keyPath);
  console.log('[copy-trader:doctor] key file size:', st.size, 'bytes, mode:', (st.mode & 0o777).toString(8));

  let pubkey: string;
  try {
    pubkey = pubkeyFromWalletSecretPath(keyPath);
  } catch (e) {
    console.error('FAIL parse key file:', (e as Error).message);
    process.exit(1);
  }
  console.log('[copy-trader:doctor] execution pubkey:', pubkey);

  try {
    const cfg = loadCopyTraderConfig();
    console.log('[copy-trader:doctor] config OK', {
      mode: cfg.executionMode,
      target: cfg.targetWallet,
      entryUsd: cfg.positionUsd,
      addUsd: cfg.addPositionUsd,
      journal: cfg.journalPath,
    });
  } catch (e) {
    console.error('FAIL config:', (e as Error).message);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
