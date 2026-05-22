/**
 * Query-history endpoints. Mirrors the desktop edition's
 * `history_list` + `history_clear` Tauri commands so both editions can
 * share the `HistoryPanel` component without forking transport code.
 *
 * The web edition records entries server-side from the `/api/execute`
 * route when the client provides a `profileId`; clients never call a
 * separate record endpoint (keeps client wiring narrow and avoids a
 * double round-trip per query).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HistoryStore } from '../history/store.js';

const listBody = z.object({
  profileId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(2000).default(200),
});

const clearBody = z.object({
  profileId: z.string().min(1),
});

const setLabelBody = z.object({
  id: z.number().int(),
  /** `null` or omitted clears the label. The server trims whitespace
   *  and treats a whitespace-only label as a clear as well. */
  label: z.string().nullable().optional(),
});

const deleteBody = z.object({
  id: z.number().int(),
});

const deleteManyBody = z.object({
  ids: z.array(z.number().int()).min(1),
});

export function historyRoute(store: HistoryStore) {
  return async function (app: FastifyInstance): Promise<void> {
    app.post('/api/history-list', async (request, reply) => {
      const parsed = listBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_body',
          issues: parsed.error.issues,
        });
      }
      return store.list(parsed.data.profileId, parsed.data.limit);
    });

    app.post('/api/history-clear', async (request, reply) => {
      const parsed = clearBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_body',
          issues: parsed.error.issues,
        });
      }
      const cleared = store.clear(parsed.data.profileId);
      return { cleared };
    });

    app.post('/api/history-set-label', async (request, reply) => {
      const parsed = setLabelBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_body',
          issues: parsed.error.issues,
        });
      }
      const updated = store.setLabel(parsed.data.id, parsed.data.label ?? null);
      return { updated };
    });

    app.post('/api/history-delete', async (request, reply) => {
      const parsed = deleteBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_body',
          issues: parsed.error.issues,
        });
      }
      const removed = store.delete(parsed.data.id);
      return { removed };
    });

    app.post('/api/history-delete-many', async (request, reply) => {
      const parsed = deleteManyBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_body',
          issues: parsed.error.issues,
        });
      }
      const removed = store.deleteMany(parsed.data.ids);
      return { removed };
    });
  };
}
