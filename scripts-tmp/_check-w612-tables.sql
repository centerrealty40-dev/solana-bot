SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('sa_qn_global_daily', 'wallet_backfill_queue');
