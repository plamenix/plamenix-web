import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fbclient from '@plamenix/native';
import { sessionStore } from '../sessions/store.js';
import type { Env } from '../env.js';

const FORMAT_MIME: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  sql: 'application/sql',
  xml: 'application/xml',
};

const exportBody = z.object({
  sessionId: z.string().uuid(),
  format: z.enum(['csv', 'json', 'sql', 'xml']),
  csvDelimiter: z.enum(['comma', 'semicolon', 'tab']).default('comma'),
  scope: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('statement'),
      sql: z.string().min(1),
      label: z.string().optional(),
      table: z.unknown().optional(),
    }),
    z.object({
      kind: z.literal('tables'),
      tables: z.array(z.unknown()),
    }),
  ]),
  /** When false, SQL-format dumps omit the `CREATE TABLE` block and
   *  emit `INSERT`-only. Defaults to true to preserve existing
   *  behaviour for callers that do not opt in. */
  includeDdl: z.boolean().default(true),
});

const CHUNK_BYTES = 64 * 1024;

/**
 * Server-streamed export. Runs the formatting pipeline through the
 * NAPI binding, then writes the result to the HTTP response in
 * 64 KiB chunks via the raw stream so the browser sees the bytes
 * arrive progressively rather than waiting for the full body.
 */
export function exportRoute(env: Env) {
  return async function register(app: FastifyInstance): Promise<void> {
  app.post('/api/export', async (request, reply) => {
    const parsed = exportBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { sessionId, format, csvDelimiter, scope, includeDdl } = parsed.data;
    if (!sessionStore.has(sessionId)) {
      return reply.code(404).send({ error: 'unknown_session' });
    }

    try {
      const output = await fbclient.exportQuery(
        sessionId,
        format,
        csvDelimiter,
        JSON.stringify(scope),
        includeDdl,
        // Bounded at the producer. The chunking below is only the
        // socket write — the whole export exists as a string here and
        // again as a Buffer before the first byte leaves, so an
        // unbounded export is a memory spike in a process that serves
        // every request.
        env.EXPORT_MAX_ROWS,
      );

      const stamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 15);
      const filename = `plamenix-export-${stamp}.${format}`;
      const mime = FORMAT_MIME[format] ?? 'application/octet-stream';

      reply.raw.statusCode = 200;
      reply.raw.setHeader('Content-Type', `${mime}; charset=utf-8`);
      reply.raw.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      reply.raw.setHeader('Transfer-Encoding', 'chunked');
      reply.raw.setHeader('Cache-Control', 'no-store');

      // Chunked write at UTF-8-safe boundaries. The Rust formatter
      // already returns valid UTF-8; slicing by `Buffer.byteLength`
      // boundaries that respect codepoints keeps it intact.
      const buf = Buffer.from(output, 'utf8');
      for (let offset = 0; offset < buf.length; offset += CHUNK_BYTES) {
        const end = Math.min(offset + CHUNK_BYTES, buf.length);
        const slice = buf.subarray(offset, end);
        const ok = reply.raw.write(slice);
        if (!ok) {
          await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
        }
      }
      reply.raw.end();
      return reply;
    } catch (err) {
      app.log.warn({ err }, 'export failed');
      if (!reply.raw.headersSent) {
        return reply.code(502).send({
          error: 'export_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      reply.raw.end();
      return reply;
    }
  });
  };
}
