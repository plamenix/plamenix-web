/**
 * The API token, and where it comes from.
 *
 * There is no "no token" mode. An operator who forgets to configure one
 * gets a generated token printed at boot, not an open server — the
 * failure mode of a security control that can be switched off by
 * omission is that it is off everywhere nobody looked.
 */

import { randomBytes } from 'node:crypto';

/**
 * Bytes of entropy in a generated token.
 *
 * 32 bytes is well past what a local attacker could search, and the
 * token is not something anyone types — it is injected into the served
 * HTML and copied from the boot log.
 */
const TOKEN_BYTES = 32;

/** Where the token came from, for the boot log to be honest about. */
export type TokenSource = 'configured' | 'generated';

/** The resolved token and how it was obtained. */
export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/**
 * Resolves the API token, generating one when none is configured.
 *
 * A configured token shorter than 16 characters is refused rather than
 * accepted with a warning. A warning at boot is read once and then
 * scrolls away; a refusal is read every time until it is fixed.
 *
 * @throws when a configured token is too short to be worth having.
 */
export function resolveToken(configured: string | undefined): ResolvedToken {
  if (configured !== undefined && configured !== '') {
    if (configured.length < 16) {
      throw new Error(
        'AUTH_TOKEN must be at least 16 characters. Leave it unset to have one generated.',
      );
    }
    return { token: configured, source: 'configured' };
  }
  return { token: randomBytes(TOKEN_BYTES).toString('base64url'), source: 'generated' };
}
