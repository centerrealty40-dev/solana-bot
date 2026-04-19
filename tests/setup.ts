// Provide fake env vars so importing src/core/config.ts during tests doesn't throw.
// Real values are only needed for integration tests (none yet).
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.HELIUS_API_KEY ??= 'test';
process.env.LOG_LEVEL ??= 'fatal';
process.env.EXECUTOR_MODE ??= 'paper';
