/**
 * Daily Telegram digest: scam-farm detective → Wallet Atlas + review queue.
 *
 * Секреты/DSN: только из `.env` (DATABASE_URL, TELEGRAM_*).
 * Флаги запуска (вкл, окно часов) — задай в crontab, не в .env, например:
 *   SCAM_FARM_DAILY_TELEGRAM=1 SCAM_FARM_DAILY_HOURS=24 node scripts/cron/daily-scam-farm-telegram.mjs
 * Без SCAM_FARM_DAILY_TELEGRAM=1 — выход 0, без отправки.
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const TAG_SRC = 'scam_farm_detective';

const BOT = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const DSN = process.env.DATABASE_URL || '';
const ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.SCAM_FARM_DAILY_TELEGRAM || '').toLowerCase(),
);
const HOURS = Math.min(168, Math.max(1, Number(process.env.SCAM_FARM_DAILY_HOURS || 24)));

function shortAddr(a) {
  if (!a || a.length < 8) {
    return a || '—';
  }
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

import { sendTagged } from '../lib/telegram.mjs';

async function sendTelegram(text) {
  if (!BOT || !CHAT) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
    process.exit(1);
  }
  await sendTagged('REPORT', 'scam-farm', text);
}

async function main() {
  if (!ENABLED) {
    console.log('SCAM_FARM_DAILY_TELEGRAM not set to 1, exit 0');
    return;
  }
  if (!DSN) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: DSN, max: 2 });
  const hi = HOURS;

  const t0 = `now() - $1::int * interval '1 hour'`;

  const { rows: r1 } = await pool.query(
    `SELECT
      (SELECT count(DISTINCT wallet)::int
       FROM wallet_tags
       WHERE source = $2 AND added_at >= ${t0}) AS tags_wallets,
      (SELECT count(*)::int
       FROM wallet_tags
       WHERE source = $2 AND added_at >= ${t0}) AS tag_rows`,
    [hi, TAG_SRC],
  );
  const { rows: r2 } = await pool.query(
    `SELECT count(*)::int AS c FROM scam_farm_candidates
     WHERE status IN ('open', 'needs_evidence')`,
  );
  const { rows: r2b } = await pool.query(
    `SELECT count(DISTINCT w)::int AS c FROM (
      SELECT jsonb_array_elements_text(coalesce(participant_wallets, '[]'::jsonb)) AS w
      FROM scam_farm_candidates
      WHERE status IN ('open', 'needs_evidence')
    ) u`,
  );
  const { rows: r3 } = await pool.query(
    `SELECT count(*)::int AS c
     FROM scam_farm_candidates
     WHERE wrote_to_atlas = true
       AND coalesce(
         (artifacts->>'atlasWriteAt')::timestamptz,
         updated_at
       ) >= ${t0}`,
    [hi],
  );
  const { rows: r4 } = await pool.query(
    `SELECT
       candidate_id,
       score,
       funder,
       rule_ids,
       participant_wallets,
       status
     FROM scam_farm_candidates
     WHERE wrote_to_atlas = true
       AND coalesce(
         (artifacts->>'atlasWriteAt')::timestamptz,
         updated_at
       ) >= ${t0}
     ORDER BY score DESC
     LIMIT 8`,
    [hi],
  );

  const tagsWallets = r1[0]?.tags_wallets ?? 0;
  const tagRows = r1[0]?.tag_rows ?? 0;
  const reviewC = r2[0]?.c ?? 0;
  const reviewDist = r2b[0]?.c ?? 0;
  const newAtlasN = r3[0]?.c ?? 0;
  const haveNew = newAtlasN > 0;

  let organizersFound = 0;
  for (const row of r4) {
    if (row.funder) {
      organizersFound += 1;
    }
  }

  const lines = [];
  lines.push(`Scam-farm: отчёт за последние ${hi} ч — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(
    haveNew
      ? `Новая ферма (записано в Wallet Atlas): ДА — ${newAtlasN} кандид.`
      : `Новая ферма (записано в Wallet Atlas): НЕТ (за период новых атлас-записей нет)`,
  );
  lines.push(
    `Кошельков внесено в Wallet Atlas (теги, источник ${TAG_SRC}): ${tagsWallets} (строк тегов: ${tagRows})`,
  );
  lines.push(
    `В review (очередь, open+needs_evidence): кандидатов ${reviewC}, уникальных кошельков: ${reviewDist}`,
  );
  if (newAtlasN > 0) {
    lines.push(
      `Организатор (funder) у новых в атласе: выявлен в ${organizersFound} из ${newAtlasN} случ. (где funder в БД задан)`,
    );
  } else {
    lines.push('Организатор: для новых атлас-строк в периоде нечего отчитать (0).');
  }
  lines.push('');

  if (r4.length) {
    lines.push('Параметры (топ по score, новые записи в атлас):');
    for (const row of r4) {
      let w = row.participant_wallets;
      if (typeof w === 'string') {
        try {
          w = JSON.parse(w);
        } catch {
          w = [];
        }
      }
      const nW = Array.isArray(w) ? w.length : 0;
      let rules = row.rule_ids;
      if (typeof rules === 'string') {
        try {
          rules = JSON.parse(rules);
        } catch {
          rules = [];
        }
      }
      const rs = Array.isArray(rules) ? rules.join(', ') : String(rules || '—');
      const org = row.funder
        ? `funder: ${shortAddr(row.funder)} (да)`
        : 'funder: не задан (нет в данных money_flows/wallets для этого кандидата)';
      lines.push(
        `  • score ${Number(row.score).toFixed(0)} | ${org} | rules: [${rs}] | кошельков: ${nW} | status: ${row.status}`,
      );
    }
  }

  const summaryJson = {
    periodHours: hi,
    new_farm_written_to_atlas: haveNew,
    atlas_candidate_rows_in_period: newAtlasN,
    wallets_with_tag_in_period: tagsWallets,
    tag_rows_in_period: tagRows,
    review: {
      candidates: reviewC,
      unique_wallets: reviewDist,
    },
    organizers_resolved_in_period: organizersFound,
  };
  lines.push('');
  lines.push('JSON:');
  lines.push(JSON.stringify(summaryJson));

  await sendTelegram(lines.join('\n'));
  await pool.end();
  console.log('daily scam-farm telegram sent', summaryJson);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
