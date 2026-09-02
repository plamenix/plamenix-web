/**
 * Serves the built SPA, and hands it the API token.
 *
 * Until this existed the server served no static assets at all, so the
 * web edition's client was reachable neither same-origin (nothing
 * served it) nor cross-origin (production CORS is off). The edition did
 * not work as a product; the review recorded it as a missing deployment
 * path.
 *
 * ## Why the token goes into the HTML
 *
 * The SPA needs a credential and the person running the server should
 * not have to paste one. The options were a cookie or the document.
 *
 * A cookie is attached by the browser automatically, which is exactly
 * what makes CSRF possible — every request from any page would carry
 * it. Injecting the token into the served HTML means the SPA sends it
 * in an `Authorization` header, and browsers never add those on their
 * own. CSRF stops being something to defend against and becomes
 * something that cannot happen.
 *
 * This is only safe because the security gate runs first. A page that
 * reached this HTML through DNS rebinding could read the token straight
 * out of it — the Host allowlist is what stops that request arriving,
 * and this route depends on it.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Placeholder the built `index.html` carries for the token. */
const TOKEN_PLACEHOLDER = '__PLAMENIX_API_TOKEN__';

export interface SpaRouteOptions {
  /** Directory holding the built client. */
  clientDist: string;
  /** Token to hand the SPA. */
  token: string;
}

/**
 * Registers static asset serving plus an index handler that injects the
 * token.
 *
 * Assets are served from `/assets` and friends; anything else that is
 * not an API path falls through to `index.html` so client-side routing
 * works on a hard refresh.
 */
export function spaRoute(options: SpaRouteOptions) {
  return async function register(app: FastifyInstance): Promise<void> {
    const root = path.resolve(options.clientDist);
    const indexPath = path.join(root, 'index.html');

    await app.register(fastifyStatic, {
      root,
      // The index is served by the handler below so the token can be
      // injected; serving it here too would hand out the placeholder.
      index: false,
      wildcard: false,
      // Hashed asset filenames are safe to cache hard; index.html is
      // not served from here at all.
      maxAge: '1y',
      immutable: true,
    });

    const serveIndex = async (): Promise<string> => {
      const html = await fs.readFile(indexPath, 'utf8');
      return html.split(TOKEN_PLACEHOLDER).join(options.token);
    };

    app.get('/', async (_request, reply) => {
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
      return serveIndex();
    });

    // Client-side routes. API paths are excluded so a mistyped endpoint
    // returns a 404 from the API rather than a page that looks like it
    // worked.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
      return serveIndex();
    });
  };
}
