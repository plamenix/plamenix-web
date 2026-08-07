/**
 * A fixed-window rate limiter, keyed by actor.
 *
 * What it is for is narrow and worth stating, because rate limiting is
 * often reached for as though it were a general defence. Here it does
 * two things:
 *
 * * **Bounds token guessing.** The token is 32 bytes of entropy, so
 *   guessing it is not a realistic attack — but an unauthenticated
 *   caller can otherwise ask as fast as it likes, and there is no
 *   reason to let it.
 * * **Stops one client monopolising the process.** Every request holds
 *   a Firebird attachment and, for exports, memory proportional to the
 *   result. A loop in a plugin or a stuck retry in the client would
 *   otherwise degrade the server for whoever else is using it.
 *
 * What it is *not* is a defence against a determined local attacker.
 * They can wait. The controls that stop them are the Host allowlist and
 * the token.
 *
 * Fixed windows rather than a sliding log or token bucket: the
 * behaviour is easy to state ("N per window"), the memory is one
 * counter per actor rather than one entry per request, and the burst it
 * permits at a window boundary does not matter for either purpose
 * above.
 */

/** One actor's counter for the window it is in. */
interface Window {
  windowStartedAt: number;
  count: number;
}

export interface RateLimitOptions {
  /** Requests permitted per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** What a check decided. */
export interface RateLimitVerdict {
  allowed: boolean;
  /** Requests left in this window; 0 once refused. */
  remaining: number;
  /** When the current window ends, for a `Retry-After`. */
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly options: RateLimitOptions) {}

  /**
   * Counts one request against `key` and says whether to serve it.
   *
   * `key` is the actor name for an authenticated request and the remote
   * address otherwise — so one operator's loop cannot exhaust another
   * operator's budget, and an unauthenticated flood is bounded per
   * source rather than globally. A global counter would let one bad
   * client lock everyone out, which is the failure the limiter is
   * supposed to prevent.
   */
  check(key: string, now: number = Date.now()): RateLimitVerdict {
    const existing = this.windows.get(key);
    if (existing === undefined || now - existing.windowStartedAt >= this.options.windowMs) {
      this.windows.set(key, { windowStartedAt: now, count: 1 });
      return {
        allowed: true,
        remaining: this.options.max - 1,
        resetAt: now + this.options.windowMs,
      };
    }

    existing.count += 1;
    const resetAt = existing.windowStartedAt + this.options.windowMs;
    if (existing.count > this.options.max) {
      return { allowed: false, remaining: 0, resetAt };
    }
    return { allowed: true, remaining: this.options.max - existing.count, resetAt };
  }

  /**
   * Drops windows that have expired.
   *
   * Without this the map grows one entry per distinct key forever,
   * which for unauthenticated requests means one per source address —
   * a slow leak an attacker can drive.
   */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (now - window.windowStartedAt >= this.options.windowMs) {
        this.windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Live window count, for tests and diagnostics. */
  size(): number {
    return this.windows.size;
  }
}
