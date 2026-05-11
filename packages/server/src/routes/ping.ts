import type { FastifyInstance } from 'fastify';

export async function pingRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/ping', async () => ({
    pong: 'plamenix-web alive',
    timestamp: new Date().toISOString(),
  }));
}
