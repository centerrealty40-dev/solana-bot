#!/usr/bin/env node
/**
 * paper2-diagnose-holders-gpa.mjs — класс **A** (docs/strategy/release/DIAGNOSTIC_SCRIPTS.md)
 *
 * Назначение: сравнить число SPL token accounts по mint для двух запросов getProgramAccounts:
 *   (A) как раньше для **обоих** программ с `dataSize: 165` — может занижать Token-2022 с extensions;
 *   (B) как в исправленном `holders-resolve.ts`: legacy с `dataSize`, Token-2022 **без** `dataSize`.
 * Плюс уникальные владельцы с ненулевым балансом (как в проде), без учёта EXCLUDE_OWNERS.
 *
 * Входы:
 *   argv[2] — mint base58 (обязательно)
 *   SA_RPC_HTTP_URL — HTTP RPC (обязательно), тот же что у papertrader / QN
 *
 * Пример:
 *   SA_RPC_HTTP_URL=https://... node scripts-tmp/paper2-diagnose-holders-gpa.mjs Hon2rHAiqkcDtUzL5gA2vjXPr7T1MPCK2UT2AHKCpump
 *
 * npm:
 *   npm run paper2:diagnose-holders-gpa -- <mint>
 *
 * Ограничения: только чтение RPC; не трогает JSONL и БД. На VPS — только после git pull, см. RELEASE_OPERATING_MODEL §7.4.
 */
import 'dotenv/config';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_ACCOUNT_DATA_SIZE = 165;

function parseOwnerAmountSlice(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 40) return null;
    const ownerBytes = buf.subarray(0, 32);
    const amountBytes = buf.subarray(32, 40);
    const nonZero = amountBytes.some((b) => b !== 0);
    return { ownerB64: ownerBytes.toString('base64'), hasBalance: nonZero };
  } catch {
    return null;
  }
}

function extractB64Data(item) {
  const d = item?.account?.data;
  if (!d) return null;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && typeof d[0] === 'string') return d[0];
  return null;
}

function countOwners(items) {
  const owners = new Set();
  let raw = 0;
  if (!Array.isArray(items)) return { accounts: 0, holders: 0 };
  for (const it of items) {
    raw++;
    const b64 = extractB64Data(it);
    if (!b64) continue;
    const dec = parseOwnerAmountSlice(b64);
    if (!dec?.hasBalance) continue;
    owners.add(dec.ownerB64);
  }
  return { accounts: raw, holders: owners.size };
}

function paramsClassic(programId, mint) {
  return [
    programId,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      dataSlice: { offset: 32, length: 40 },
      filters: [{ dataSize: SPL_ACCOUNT_DATA_SIZE }, { memcmp: { offset: 0, bytes: mint } }],
    },
  ];
}

function params2022OldBoth165(mint) {
  return paramsClassic(TOKEN_2022_PROGRAM_ID, mint);
}

function params2022NoDataSize(mint) {
  return [
    TOKEN_2022_PROGRAM_ID,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      dataSlice: { offset: 32, length: 40 },
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
    },
  ];
}

async function rpc(url, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 400)}`);
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

async function main() {
  const mint = process.argv[2]?.trim();
  const url = (process.env.SA_RPC_HTTP_URL || '').trim();
  if (!mint) {
    console.error('Usage: SA_RPC_HTTP_URL=<url> node scripts-tmp/paper2-diagnose-holders-gpa.mjs <mint>');
    process.exit(2);
  }
  if (!url) {
    console.error('SA_RPC_HTTP_URL is required');
    process.exit(2);
  }

  console.log('mint:', mint);
  console.log('rpc host:', new URL(url).host);

  const legacy = await rpc(url, 'getProgramAccounts', paramsClassic(TOKEN_PROGRAM_ID, mint));
  const t22old = await rpc(url, 'getProgramAccounts', params2022OldBoth165(mint));
  const t22new = await rpc(url, 'getProgramAccounts', params2022NoDataSize(mint));

  const cLeg = countOwners(legacy);
  const cOld = countOwners(t22old);
  const cNew = countOwners(t22new);

  const mergedOld = new Set();
  for (const arr of [legacy, t22old]) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const b64 = extractB64Data(it);
      const dec = b64 ? parseOwnerAmountSlice(b64) : null;
      if (dec?.hasBalance) mergedOld.add(dec.ownerB64);
    }
  }
  const mergedNew = new Set();
  for (const arr of [legacy, t22new]) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const b64 = extractB64Data(it);
      const dec = b64 ? parseOwnerAmountSlice(b64) : null;
      if (dec?.hasBalance) mergedNew.add(dec.ownerB64);
    }
  }

  console.log('\n--- По программам (accounts / уникальных с balance>0) ---');
  console.log('Token legacy dataSize=165:', cLeg.accounts, '/', cLeg.holders);
  console.log('Token-2022 dataSize=165 (старое поведение для T22):', cOld.accounts, '/', cOld.holders);
  console.log('Token-2022 БЕЗ dataSize (исправленный путь):', cNew.accounts, '/', cNew.holders);
  console.log('\n--- Сводка как в prod до фикса (legacy + T22 оба с 165) ---');
  console.log('unique holders:', mergedOld.size);
  console.log('--- Сводка после фикса (legacy 165 + T22 без dataSize) ---');
  console.log('unique holders:', mergedNew.size);
  if (mergedNew.size > mergedOld.size) {
    console.log(
      `\nВывод: недосчёт подтверждается — без dataSize на Token-2022 на ${mergedNew.size - mergedOld.size} холдеров больше.`,
    );
  } else if (mergedNew.size === mergedOld.size) {
    console.log('\nВывод: для этого mint расхождения нет; искать другую причину (RPC limit, другой mint/program).');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
