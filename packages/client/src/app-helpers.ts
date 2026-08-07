/**
 * Small pure helpers the shell uses to label tabs, bucket recent
 * queries, and render relative times.
 *
 * They lived inside `App.tsx` and were unexported, which meant testing
 * them at all would have meant importing a 2,000-line component and
 * every module it pulls in. They are the kind of thing that is obvious
 * until a path separator or a rounding boundary is wrong, so they are
 * out here where a test can reach them cheaply.
 */

import {
  resolveHistoryLimit,
  useConnectionPrefs,
  useRecentQueries,
  type ConnectionForm,
  type StatementOutcome,
} from '@plamenix/ui';

export function deriveTitle(form: ConnectionForm): string {
  const last = form.database.split(/[\\/]/).pop() ?? form.database;
  return `${form.host}/${last}`;
}

/** Snapshot the persisted history-retention preference at call time so
 *  the dispatched execute carries the latest cap without forcing the
 *  surrounding `useCallback` to re-subscribe on every settings tweak. */
export function currentHistoryLimit(): number | null {
  return resolveHistoryLimit(useConnectionPrefs.getState().queryHistoryLimit);
}

/** Stable key for the welcome-dashboard recent-queries bucket. Prefers
 *  the profile name so multiple tabs against the same profile share a
 *  list; falls back to host/db so anonymous connections still bucket
 *  cleanly. */
export function recentKeyOf(form: ConnectionForm, profileName: string): string {
  const trimmed = profileName.trim();
  return trimmed.length > 0 ? trimmed : deriveTitle(form);
}

export function recordExec(
  key: string,
  sql: string,
  startedAt: number,
  outcomes: StatementOutcome[] | null,
  err: string | null,
): void {
  const durationMs = Date.now() - startedAt;
  let status: 'ok' | 'err' = 'ok';
  let rowCount: number | null = null;
  let errMsg: string | null = null;
  if (err !== null) {
    status = 'err';
    errMsg = err;
  } else if (outcomes && outcomes.length > 0) {
    const failed = outcomes.find((o) => o.status === 'err');
    if (failed && failed.status === 'err') {
      status = 'err';
      errMsg = failed.error;
    } else {
      const last = outcomes[outcomes.length - 1];
      if (last && last.status === 'ok') {
        if ('Rows' in last.result) rowCount = last.result.Rows.rows.length;
        else if ('Affected' in last.result) rowCount = last.result.Affected.rows;
      }
    }
  }
  useRecentQueries.getState().record(key, {
    sql,
    executedAt: startedAt,
    durationMs,
    status,
    rowCount,
    error: errMsg,
  });
}

/** Renders an epoch-ms timestamp as a short relative-time string. The
 *  unused `_tick` argument forces a re-render when the parent's ticker
 *  advances; the value itself is discarded. */
export function formatRelative(at: number, _tick: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
