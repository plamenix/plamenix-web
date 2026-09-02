/**
 * The shell's labelling, bucketing, and recent-query recording.
 *
 * `recordExec` is the interesting one: it decides what a user sees in
 * the recent-queries list after a batch, and its rules are not obvious
 * — any failed statement makes the whole batch a failure, the row count
 * comes from the *last* statement, and an explicit error argument wins
 * over whatever the outcomes say. The web server derives the same facts
 * for the history table in `recordOutcomeBatch`, so the two agreeing is
 * something to check rather than assume.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecentQueries, type ConnectionForm, type StatementOutcome } from '@plamenix/ui';
import { deriveTitle, formatRelative, recentKeyOf, recordExec } from './app-helpers.js';

function form(overrides: Partial<ConnectionForm> = {}): ConnectionForm {
  return {
    host: 'localhost',
    port: 3050,
    database: '/var/lib/firebird/data/test.fdb',
    user: 'SYSDBA',
    password: '',
    ...overrides,
  } as ConnectionForm;
}

/** The entries `recordExec` put in a bucket. */
function recorded(key: string): ReturnType<typeof useRecentQueries.getState>['byKey'][string] {
  return useRecentQueries.getState().byKey[key] ?? [];
}

function rowsOutcome(rows: number): StatementOutcome {
  return {
    status: 'ok',
    result: { Rows: { columns: [], rows: Array.from({ length: rows }, () => ({ cells: [] })) } },
  } as unknown as StatementOutcome;
}

function affectedOutcome(rows: number): StatementOutcome {
  return { status: 'ok', result: { Affected: { rows } } } as unknown as StatementOutcome;
}

function errOutcome(error: string): StatementOutcome {
  return { status: 'err', error } as unknown as StatementOutcome;
}

describe('deriveTitle', () => {
  it('shows the file name, not the whole path', async () => {
    expect(deriveTitle(form())).toBe('localhost/test.fdb');
  });

  it('splits Windows paths too', () => {
    // The server may be on Windows while the client is not, so the
    // separator is a property of the path and not of this machine.
    expect(deriveTitle(form({ database: 'C:\\firebird\\data\\test.fdb' }))).toBe(
      'localhost/test.fdb',
    );
  });

  it('falls back to the whole value when there is no separator', () => {
    expect(deriveTitle(form({ database: 'employee' }))).toBe('localhost/employee');
  });

  it('does not produce a bare trailing slash for an empty database', () => {
    // `''.split(...)` yields `['']`, so `pop()` is `''` rather than
    // undefined and the `??` fallback never fires.
    expect(deriveTitle(form({ database: '' }))).toBe('localhost/');
  });
});

describe('recentKeyOf', () => {
  it('prefers the profile name so tabs on one profile share a bucket', () => {
    expect(recentKeyOf(form(), 'Production')).toBe('Production');
  });

  it('ignores a whitespace-only name', () => {
    // A name of spaces would otherwise become a bucket key that no
    // other tab could ever match, silently splitting the list.
    expect(recentKeyOf(form(), '   ')).toBe('localhost/test.fdb');
  });

  it('trims, so a stray space does not fork the bucket', () => {
    expect(recentKeyOf(form(), '  Production  ')).toBe('Production');
  });
});

describe('formatRelative', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "just now" under a second', () => {
    expect(formatRelative(NOW - 400, 0)).toBe('just now');
  });

  it('counts seconds, then minutes, then hours', () => {
    expect(formatRelative(NOW - 5_000, 0)).toBe('5s ago');
    expect(formatRelative(NOW - 90_000, 0)).toBe('2m ago');
    expect(formatRelative(NOW - 3_600_000, 0)).toBe('1h ago');
  });

  it('never shows a negative age for a clock that jumped', () => {
    // A timestamp from the server, or a system clock correction, can
    // sit in the future. "-3s ago" would be worse than "just now".
    expect(formatRelative(NOW + 10_000, 0)).toBe('just now');
  });

  it('ignores the tick argument entirely', () => {
    // It exists to force a re-render, not to change the output. If it
    // ever starts mattering, this is where it shows up.
    expect(formatRelative(NOW - 5_000, 0)).toBe(formatRelative(NOW - 5_000, 999));
  });
});

describe('recordExec', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    useRecentQueries.setState({ byKey: {} });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a successful batch with the last statement’s row count', () => {
    // The last statement is the one whose grid the user is looking at.
    recordExec('k', 'SELECT 1; SELECT 2', NOW - 50, [rowsOutcome(3), rowsOutcome(7)], null);

    expect(recorded('k')[0]).toMatchObject({
      sql: 'SELECT 1; SELECT 2',
      executedAt: NOW - 50,
      durationMs: 50,
      status: 'ok',
      rowCount: 7,
      error: null,
    });
  });

  it('takes the row count from an affected-rows result', () => {
    recordExec('k', 'UPDATE T SET A = 1', NOW, [affectedOutcome(12)], null);

    expect(recorded('k')[0]?.rowCount).toBe(12);
  });

  it('marks the whole batch failed when any statement failed', () => {
    // Reporting "ok" because the last one happened to succeed would
    // hide the failure that matters.
    recordExec('k', 'a; b; c', NOW, [rowsOutcome(1), errOutcome('boom'), rowsOutcome(2)], null);

    const entry = recorded('k')[0];
    expect(entry?.status).toBe('err');
    expect(entry?.error).toBe('boom');
    expect(entry?.rowCount).toBeNull();
  });

  it('reports the first failure, not the last', () => {
    recordExec('k', 'a; b', NOW, [errOutcome('first'), errOutcome('second')], null);

    expect(recorded('k')[0]?.error).toBe('first');
  });

  it('lets an explicit error win over the outcomes', () => {
    // The transport threw after the statements came back — that is the
    // failure the user needs to see.
    recordExec('k', 'SELECT 1', NOW, [rowsOutcome(1)], 'TransportError: connection reset');

    const entry = recorded('k')[0];
    expect(entry?.status).toBe('err');
    expect(entry?.error).toBe('TransportError: connection reset');
  });

  it('records a bare success when there are no outcomes at all', () => {
    // A DDL batch can come back empty. It still ran, so it still
    // belongs in the list.
    recordExec('k', 'CREATE TABLE T (A INTEGER)', NOW, [], null);

    expect(recorded('k')[0]).toMatchObject({ status: 'ok', rowCount: null, error: null });
  });

  it('keeps buckets separate', () => {
    recordExec('one', 'SELECT 1', NOW, [rowsOutcome(1)], null);
    recordExec('two', 'SELECT 2', NOW, [rowsOutcome(1)], null);

    expect(recorded('one')).toHaveLength(1);
    expect(recorded('two')).toHaveLength(1);
    expect(recorded('one')[0]?.sql).toBe('SELECT 1');
  });
});
