import type { FastifyInstance } from 'fastify';
import { Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export function registerMetrics(app: FastifyInstance): void {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'nexora_' });

  const httpDuration = new Histogram({
    name: 'nexora_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.addHook('onResponse', async (request, reply) => {
    httpDuration.observe(
      { method: request.method, route: request.routeOptions.url ?? 'unmatched', status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
    void reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
