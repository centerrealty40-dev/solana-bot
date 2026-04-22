CREATE TABLE IF NOT EXISTS "paper_trades" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,

  /** mint адрес токена который мы купили */
  "mint" varchar(64) NOT NULL,
  /** primary pair / pool address для трекинга цены */
  "pool_address" varchar(64),

  /** когда сработал ring-detector */
  "alert_ts" timestamp with time zone NOT NULL,
  /** когда мы виртуально купили (после прохождения всех фильтров) */
  "entry_ts" timestamp with time zone NOT NULL,
  /** entry price USD из quote или dexscreener в момент покупки */
  "entry_price_usd" double precision NOT NULL,
  /** размер позиции в USD (обычно $10) */
  "entry_size_usd" double precision NOT NULL,

  /** метаданные алерта: buyers, funders, vol_window, etc */
  "alert_meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
  /** какие фильтры прошли + значения (liquidity, age, vol_h1/h6, honeypot_check, etc) */
  "filter_results" jsonb NOT NULL DEFAULT '{}'::jsonb,

  /** оставшаяся доля позиции (1.0 = full open, 0.0 = fully closed) */
  "remaining_fraction" double precision NOT NULL DEFAULT 1.0,
  /** реализованный USD-профит на закрытых частях (включая возврат стейка) */
  "realized_pnl_usd" double precision NOT NULL DEFAULT 0,
  /** максимальная цена видимая с момента входа (для trailing stop на moon bag) */
  "max_price_seen_usd" double precision NOT NULL,
  /** последняя проверенная цена */
  "last_price_usd" double precision NOT NULL,
  "last_check_ts" timestamp with time zone NOT NULL DEFAULT now(),

  /** open | partial_2x | partial_5x | closed_win | closed_loss | closed_timeout | closed_rug */
  "status" varchar(24) NOT NULL DEFAULT 'open',
  /** журнал событий выхода: [{ts, fraction, price, reason, pnl_usd}] */
  "exit_events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "closed_at" timestamp with time zone,

  CONSTRAINT "paper_trades_mint_entry_uq" UNIQUE ("mint", "entry_ts")
);

CREATE INDEX IF NOT EXISTS "paper_trades_status_idx" ON "paper_trades" ("status");
CREATE INDEX IF NOT EXISTS "paper_trades_mint_idx"   ON "paper_trades" ("mint");
CREATE INDEX IF NOT EXISTS "paper_trades_entry_idx"  ON "paper_trades" ("entry_ts");
