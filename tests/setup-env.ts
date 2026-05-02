/** Minimal env so core/logger → config loads in Vitest without dotenv. */
process.env.DATABASE_URL ||= 'postgresql://u:p@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
/** Importing `scripts-tmp/dashboard-server.ts` in tests must not bind HTTP. */
process.env.DASHBOARD_NO_LISTEN = '1';
