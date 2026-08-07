/**
 * API tokens, and who each one is.
 *
 * A single anonymous token could say "someone authenticated" and
 * nothing more. Named tokens let the audit log say *which* operator did
 * something, and let one credential be revoked without rotating
 * everyone else's.
 *
 * This is identity, not accounts. Every token reaches the same data —
 * there is one `profiles.json` and one history — so a name here is an
 * attribution, not an isolation boundary. Pretending otherwise would be
 * worse than not having names at all: two people would each assume the
 * other could not see their saved connections.
 *
 * There is no unauthenticated mode. An operator who configures nothing
 * gets a generated token printed at boot, because a control that
 * switches itself off by omission is off wherever nobody looked.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bytes of entropy in a generated token. Well past what a local
 * attacker could search, and nobody types it — it is injected into the
 * served HTML and copied from the boot log.
 */
const TOKEN_BYTES = 32;

/** Shortest configured token accepted. */
export const MIN_TOKEN_LENGTH = 16;

/** Name used when a single unnamed token is configured or generated. */
export const DEFAULT_ACTOR = 'default';

/** One credential and the operator it identifies. */
export interface NamedToken {
  /** Appears in the audit log as the actor. */
  name: string;
  value: string;
}

/** The resolved credential set. */
export interface ResolvedTokens {
  tokens: readonly NamedToken[];
  /** Whether these were configured or generated at boot. */
  source: 'configured' | 'generated';
}

/**
 * Parses `AUTH_TOKENS`, falling back to `AUTH_TOKEN`, and generating
 * one when neither is set.
 *
 * `AUTH_TOKENS` is `name:value` pairs separated by commas. A name may
 * not contain a colon or a comma; the value may contain colons, since
 * base64url does not but a hand-written token might.
 *
 * @throws when a token is too short, a name is duplicated, or an entry
 * is malformed. Refused rather than warned about: a warning at boot is
 * read once and then scrolls away, and a duplicate name would make the
 * audit log ambiguous about who did something.
 */
export function resolveTokens(
  named: string | undefined,
  single: string | undefined,
): ResolvedTokens {
  if (named !== undefined && named.trim() !== '') {
    const tokens: NamedToken[] = [];
    const seen = new Set<string>();
    for (const entry of named.split(',')) {
      const trimmed = entry.trim();
      if (trimmed === '') continue;
      const colon = trimmed.indexOf(':');
      if (colon <= 0 || colon === trimmed.length - 1) {
        throw new Error(
          `AUTH_TOKENS entry "${trimmed}" is not "name:token". Names may not contain a colon.`,
        );
      }
      const name = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (value.length < MIN_TOKEN_LENGTH) {
        throw new Error(
          `AUTH_TOKENS token for "${name}" must be at least ${MIN_TOKEN_LENGTH} characters.`,
        );
      }
      if (seen.has(name)) {
        throw new Error(
          `AUTH_TOKENS names must be unique; "${name}" appears twice. The audit log records this name as the actor, and two operators sharing one would make it unanswerable.`,
        );
      }
      seen.add(name);
      tokens.push({ name, value });
    }
    if (tokens.length === 0) {
      throw new Error('AUTH_TOKENS was set but contained no usable entries.');
    }
    return { tokens, source: 'configured' };
  }

  if (single !== undefined && single !== '') {
    if (single.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Leave it unset to have one generated.`,
      );
    }
    return { tokens: [{ name: DEFAULT_ACTOR, value: single }], source: 'configured' };
  }

  return {
    tokens: [{ name: DEFAULT_ACTOR, value: randomBytes(TOKEN_BYTES).toString('base64url') }],
    source: 'generated',
  };
}

/**
 * Finds which operator a supplied token belongs to.
 *
 * Every candidate is compared, and the comparison is constant-time, so
 * neither which token matched nor how far a wrong one got is
 * observable through timing. Returning early on the first match would
 * make the answer depend on configuration order.
 */
export function actorFor(supplied: string, tokens: readonly NamedToken[]): string | null {
  let matched: string | null = null;
  for (const token of tokens) {
    if (constantTimeEquals(supplied, token.value)) matched = token.name;
  }
  return matched;
}

/** Constant-time string comparison over UTF-8 bytes. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself
  // leak length. Compare against a same-length copy and fold the length
  // check into the result.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
