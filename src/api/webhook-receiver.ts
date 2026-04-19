import type { FastifyInstance } from 'fastify';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { processHeliusBatch } from '../collectors/helius-webhook.js';
import type { HeliusEnhancedTx } from '../collectors/normalizer.js';

const log = child('webhook-receiver');

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/helius', async (req, reply) => {
    if (config.heliusWebhookAuth) {
      const provided = req.headers['authorization'];
      if (provided !== config.heliusWebhookAuth) {
        log.warn({ ip: req.ip }, 'rejected unauthorized helius webhook');
        return reply.code(401).send({ ok: false });
      }
    }

    const body = req.body;
    if (!Array.isArray(body)) {
      return reply.code(400).send({ ok: false, error: 'expected array of enhanced tx' });
    }

    try {
      const inserted = await processHeliusBatch(body as HeliusEnhancedTx[]);
      log.debug({ batch: body.length, inserted }, 'helius batch processed');
      return reply.send({ ok: true, inserted });
    } catch (err) {
      log.error({ err: String(err) }, 'failed processing helius batch');
      return reply.code(500).send({ ok: false });
    }
  });

  /** Manual ingest endpoint — useful for backfill scripts and tests. */
  app.post('/ingest/swaps', async (req, reply) => {
    const body = req.body;
    if (!Array.isArray(body)) {
      return reply.code(400).send({ ok: false });
    }
    try {
      const inserted = await processHeliusBatch(body as HeliusEnhancedTx[]);
      return reply.send({ ok: true, inserted });
    } catch (err) {
      log.error({ err: String(err) }, 'failed manual ingest');
      return reply.code(500).send({ ok: false });
    }
  });
}
