-- W6.13 — одно Telegram-уведомление за UTC-день при исчерпании detective ledger (sa_qn_global_daily).

ALTER TABLE "sa_qn_global_daily"
  ADD COLUMN IF NOT EXISTS "detective_cap_alert_sent" boolean NOT NULL DEFAULT false;
