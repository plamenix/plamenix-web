import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fbclient from '@plamenix/native';
import type { ConnectionConfig } from '@plamenix/native';
import { sessionStore } from '../sessions/store.js';
import type { ProfileDraft, ProfileStore } from '../profiles/store.js';

const saveBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().default(3050),
  database: z.string().min(1),
  user: z.string().min(1),
  encryptionRequired: z.boolean().default(false),
  pureRust: z.boolean().default(false),
  color: z.string().optional(),
  fbclientPath: z.string().optional(),
  charset: z.string().optional(),
});

const connectBody = z.object({
  password: z.string(),
  encryptionKey: z.string().optional(),
  pureRust: z.boolean().optional(),
  encryptionRequired: z.boolean().optional(),
  fbclientPath: z.string().optional(),
  charset: z.string().optional(),
});

export function profilesRoute(store: ProfileStore) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get('/api/profiles', async () => ({ profiles: await store.list() }));

    app.post('/api/profiles', async (request, reply) => {
      const parsed = saveBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const draft: ProfileDraft = {
        name: parsed.data.name,
        host: parsed.data.host,
        port: parsed.data.port,
        database: parsed.data.database,
        user: parsed.data.user,
        encryptionRequired: parsed.data.encryptionRequired,
        pureRust: parsed.data.pureRust,
      };
      if (parsed.data.id !== undefined) {
        draft.id = parsed.data.id;
      }
      if (parsed.data.color !== undefined) {
        draft.color = parsed.data.color;
      }
      if (parsed.data.fbclientPath !== undefined) {
        draft.fbclientPath = parsed.data.fbclientPath;
      }
      if (parsed.data.charset !== undefined) {
        draft.charset = parsed.data.charset;
      }
      const profile = await store.save(draft);
      return { profile };
    });

    app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (request, reply) => {
      await store.delete(request.params.id);
      return reply.code(204).send();
    });

    app.post<{ Params: { id: string } }>(
      '/api/profiles/:id/touch-disconnected',
      async (request, reply) => {
        const profile = await store.get(request.params.id);
        if (!profile) {
          return reply.code(404).send({ error: 'unknown_profile' });
        }
        await store.touchDisconnected(profile.id);
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { id: string } }>(
      '/api/profiles/:id/connect',
      async (request, reply) => {
        const profile = await store.get(request.params.id);
        if (!profile) {
          return reply.code(404).send({ error: 'unknown_profile' });
        }

        const parsed = connectBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
        }

        const config: ConnectionConfig = {
          host: profile.host,
          port: profile.port,
          database: profile.database,
          user: profile.user,
          password: parsed.data.password,
          encryptionRequired: parsed.data.encryptionRequired ?? profile.encryptionRequired,
        };
        if (parsed.data.encryptionKey !== undefined) {
          config.encryptionKey = parsed.data.encryptionKey;
        }
        const fbclientPath = parsed.data.fbclientPath ?? profile.fbclientPath ?? null;
        if (typeof fbclientPath === 'string' && fbclientPath.length > 0) {
          config.fbclientPath = fbclientPath;
        }
        const charset = parsed.data.charset ?? profile.charset ?? null;
        if (typeof charset === 'string' && charset.length > 0) {
          config.charset = charset;
        }
        if (parsed.data.pureRust ?? profile.pureRust) {
          config.pureRust = true;
        }

        try {
          const handle = await fbclient.connect(config);
          sessionStore.register(handle.sessionId);
          // Best-effort: touch failure should not break the connect.
          store.touch(profile.id).catch((err) => {
            app.log.warn({ err, profileId: profile.id }, 'profile touch failed');
          });
          return { sessionId: handle.sessionId };
        } catch (err) {
          app.log.warn({ err }, 'profile connect failed');
          return reply.code(502).send({
            error: 'connect_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
}
