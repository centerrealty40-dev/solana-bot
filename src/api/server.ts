import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from '../core/config.js';
import { logger, child } from '../core/logger.js';
import { registerWebhookRoutes } from './webhook-receiver.js';
import { registerDashboardRoutes } from './dashboard-routes.js';
import { ensureHeliusWebhook } from '../collectors/helius-webhook.js';

const log = child('api');

async function main(): Promise<void> {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 50 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });

  app.get('/health', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    mode: config.executorMode,
  }));

  await registerWebhookRoutes(app);
  await registerDashboardRoutes(app);

  try {
    await app.listen({ host: config.apiHost, port: config.apiPort });
    log.info({ host: config.apiHost, port: config.apiPort }, 'api listening');
  } catch (err) {
    log.error({ err }, 'api failed to start');
    process.exit(1);
  }

  // Best-effort: register/update Helius webhook on startup.
  // The function itself is a no-op when HELIUS_MODE=off, and refuses to
  // subscribe to programs even in 'wallets'/'unsafe' modes.
  if (config.heliusMode !== 'off' && config.heliusApiKey && config.heliusWebhookUrl) {
    void ensureHeliusWebhook().catch((err) =>
      logger.warn({ err: String(err) }, 'webhook ensure failed'),
    );
  } else {
    log.info({ mode: config.heliusMode }, 'helius webhook auto-register skipped');
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info({ sig }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  log.error({ err }, 'api crashed');
  process.exit(1);
});
