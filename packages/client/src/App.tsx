import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  currentHistoryLimit,
  deriveTitle,
  formatRelative,
  recentKeyOf,
  recordExec,
} from './app-helpers.js';
import {
  copyText,
  historyKeyOf,
  useToastStore,
  ConfirmationModal,
  ConnectionScreen,
  DdlViewerModal,
  ErrorBanner,
  DatabaseExportModal,
  HistoryButton,
  HistoryPanel,
  MultiResultView,
  NewObjectModal,
  ObjectListPage,
  QueryPanel,
  ToastViewport,
  notifyMutations,
  SchemaBrowser,
  SchemaEditorModal,
  sourceQuery,
  SettingsButton,
  SettingsPage,
  TableObjectView,
  StatsDashboard,
  swatchFor,
  TabStrip,
  WelcomeDashboard,
  getModKeyLabel,
  useConnectionActions,
  useShellCommands,
  resolveStatement,
  dispatchSchemaDdl,
  applySchemaAction,
  useSessionRefreshers,
  quoteIdentifier,
  abandonStatement,
  abandonNeedsConfirmation,
  describeAbandonCost,
  isStaleSession,
  countFromCell,
  runGuardedExport,
  ShellOverlays,
  appendIdentifier,
  profileToForm,
  firstRows,
  firstAffected,
  type ConnectionAdapter,
  installPluginInterceptors,
  type ExtensionPoint,
  type PluginInterceptorOutcome,
  installDestructiveDropInterceptor,
  setConfirmationProvider,
  type ConfirmationRequest,
  type PendingConfirmation,
  emitEditorFocused,
  emitEditorSelectionChanged,
  useDefaultKeybindings,
  useBuiltinContributions,
  usePluginEventForwarding,
  useConnectionPrefs,
  useEmitConnectionEvents,
  useEmitEditorEvents,
  useEmitLifecycleEvents,
  useEmitQueryEvents,
  useEmitSchemaEvents,
  useEmitSettingsThemeEvents,
  useEmitTabEvents,
  useResolvedThemeMode,
  useRecentQueries,
  useTabsStore,
  useThemeStore,
  type ConnectionForm,
  type ColumnValue,
  type CryptState,
  type DatabaseStats,
  type DdlSourceKind,
  type HistoryEntry,
  type ListAliasesResult,
  type NewObjectKind,
  type ObjectListKind,
  type Profile,
  type StreamedExportRequest,
  type StreamedExportResult,
  type StreamedExportRunner,
  type TableExportPart,
  type TableInfo,
  type Schema,
  type StatementOutcome,
  type TabState,
  type SchemaAction,
  type SchemaDdl,
  type TestConnectionResult,
  TransactionBar,
  hasUncommittedWork,
  type TxConfig,
  type TxMode,
  type TxStatus,
} from '@plamenix/ui';
import { authHeaders, fetchTransport } from '@/transport/fetch';
import { connectEventChannel } from '@/events/channel';
import {
  connectByProfile,
  deleteProfile,
  listProfiles,
  saveProfile,
  touchProfileDisconnected,
  type ProfileConnectArgs,
  type ProfileDraft,
} from '@/profiles';

interface ConnectResponse {
  sessionId: string;
}

interface CryptStateResponse {
  state: CryptState;
}

// I6 event-bus identity. Keep in sync with package.json version on
// release-prep (no live import yet — vite JSON imports work but
// require the workspace to expose package.json to the bundler).
const HOST_VERSION = '1.0.0-beta';
const EDITION = 'web' as const;

export function App() {
  // I6.3-I6.6 + I6.8 + I6.10 + I6.11 — mount the seven event-bridge
  // hooks once at the App root. Each hook subscribes to its source
  // store + diffs/emits on every relevant transition. Order is
  // arbitrary; hooks are independent.
  useEmitLifecycleEvents({ edition: EDITION, hostVersion: HOST_VERSION });
  useEmitTabEvents();
  useEmitConnectionEvents();
  useEmitQueryEvents();
  useEmitSchemaEvents();
  useEmitSettingsThemeEvents();
  useEmitEditorEvents();

  // I6.12 — confirmation queue + provider + built-in destructive-DROP
  // interceptor. The queue keeps multiple in-flight confirmations
  // ordered; each user action resolves exactly one request.
  const [confirmQueue, setConfirmQueue] = useState<
    Array<PendingConfirmation & { resolve: (v: boolean) => void }>
  >([]);
  useEffect(() => {
    setConfirmationProvider(
      (req: ConfirmationRequest) =>
        new Promise<boolean>((resolve) => {
          setConfirmQueue((q) => [...q, { ...req, resolve }]);
        }),
    );
    const dropReg = installDestructiveDropInterceptor();
    return () => {
      setConfirmationProvider(null);
      dropReg.dispose();
    };
  }, []);
  const confirmHead = confirmQueue[0] ?? null;
  const onConfirmHead = useCallback(() => {
    setConfirmQueue((q) => {
      const [head, ...rest] = q;
      head?.resolve(true);
      return rest;
    });
  }, []);
  const onCancelHead = useCallback(() => {
    setConfirmQueue((q) => {
      const [head, ...rest] = q;
      head?.resolve(false);
      return rest;
    });
  }, []);

  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const newTab = useTabsStore((s) => s.newTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActive = useTabsStore((s) => s.setActive);
  const patchTab = useTabsStore((s) => s.patchTab);
  const renameTab = useTabsStore((s) => s.renameTab);
  const reorderTab = useTabsStore((s) => s.reorderTab);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [aliasesData, setAliasesData] = useState<ListAliasesResult | null>(null);
  const [aliasesLoading, setAliasesLoading] = useState(false);
  const [ddlViewer, setDdlViewer] = useState<{
    kind: DdlSourceKind;
    name: string;
    source: string | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const openHistory = useCallback(async () => {
    setHistoryOpen(true);

    // Opens even with nowhere to read from — the panel explains why it
    // is empty. Returning early made the button silently do nothing for
    // a session connected without a saved profile.
    const pid = historyKeyOf(activeTab.selectedProfileId, activeTab.form);
    setHistoryLoading(true);
    try {
      const res = await fetchTransport.invoke<HistoryEntry[]>('history-list', {
        profileId: pid,
        limit: 200,
      });
      setHistoryEntries(res);
    } catch (err) {
      patchTab(activeTabId, { error: String(err) });
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [activeTab, activeTabId, patchTab]);

  const clearHistory = useCallback(async () => {
    const pid = historyKeyOf(activeTab.selectedProfileId, activeTab.form);
    try {
      await fetchTransport.invoke<{ cleared: number }>('history-clear', {
        profileId: pid,
      });
      setHistoryEntries([]);
    } catch (err) {
      patchTab(activeTabId, { error: String(err) });
    }
  }, [activeTab, activeTabId, patchTab]);

  const deleteHistoryEntry = useCallback(async (id: number) => {
    await fetchTransport.invoke<{ removed: boolean }>('history-delete', { id });
    setHistoryEntries((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
  }, []);

  const deleteHistoryEntries = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    await fetchTransport.invoke<{ removed: number }>('history-delete-many', {
      ids,
    });
    const drop = new Set(ids);
    setHistoryEntries((prev) => (prev ? prev.filter((e) => !drop.has(e.id)) : prev));
  }, []);

  const setHistoryLabel = useCallback(
    async (id: number, label: string | null) => {
      await fetchTransport.invoke<{ updated: boolean }>('history-set-label', {
        id,
        label,
      });
      const normalized = label && label.trim().length > 0 ? label.trim() : null;
      let matched: { sql: string; executedAt: number } | null = null;
      setHistoryEntries((prev) => {
        if (!prev) return prev;
        return prev.map((entry) => {
          if (entry.id !== id) return entry;
          matched = { sql: entry.sql, executedAt: entry.executedAt };
          return { ...entry, label: normalized };
        });
      });
      if (matched) {
        const tab = activeTab;
        const key = recentKeyOf(tab.form, tab.profileName);
        useRecentQueries.getState().setLabel(key, matched, normalized);
      }
    },
    [activeTab],
  );

  const handleShowDdl = useCallback(
    async (kind: DdlSourceKind, name: string) => {
      const tab = activeTab;
      if (!tab.sessionId) return;
      setDdlViewer({ kind, name, source: null, loading: true, error: null });
      try {
        const sql = sourceQuery(kind, name);
        const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
          sessionId: tab.sessionId,
          sql,
        });
        const first = outcomes[0];
        if (!first) throw new Error('Source query produced no outcome.');
        if (first.status === 'err') throw new Error(first.error);
        if (!('Rows' in first.result)) {
          throw new Error('Source query did not return a row.');
        }
        const cell = first.result.Rows.rows[0]?.cells[0];
        let source = '';
        if (cell?.type === 'text') source = cell.value;
        else if (cell?.type === 'null') source = '';
        setDdlViewer({ kind, name, source, loading: false, error: null });
      } catch (err) {
        setDdlViewer({
          kind,
          name,
          source: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeTab],
  );

  const refreshProfiles = useCallback(async () => {
    try {
      setProfiles(await listProfiles());
    } catch (err) {
      patchTab(activeTabId, { error: String(err) });
    }
  }, [activeTabId, patchTab]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const updateField = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => {
    patchTab(activeTabId, {
      form: { ...activeTab.form, [key]: value },
      testResult: null,
    });
  };

  const handleSelectProfile = (id: string | null) => {
    if (id === null) {
      patchTab(activeTabId, { selectedProfileId: null, profileName: '', profileColor: null });
      return;
    }
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    patchTab(activeTabId, {
      selectedProfileId: id,
      profileName: profile.name,
      profileColor: profile.color ?? null,
      form: profileToForm(profile),
    });
  };

  const handleSaveProfile = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    patchTab(tabId, { error: null, busy: true });
    try {
      const draft: ProfileDraft = {
        name: tab.profileName.trim(),
        host: tab.form.host,
        port: tab.form.port,
        database: tab.form.database,
        user: tab.form.user,
        encryptionRequired: tab.form.encryptionRequired,
        pureRust: tab.form.pureRust,
        color: tab.profileColor,
      };
      if (tab.selectedProfileId !== null) {
        draft.id = tab.selectedProfileId;
      }
      if (tab.form.fbclientPath !== '') {
        draft.fbclientPath = tab.form.fbclientPath;
      }
      if (tab.form.charset !== '') {
        draft.charset = tab.form.charset;
      }
      const saved = await saveProfile(draft);
      await refreshProfiles();
      patchTab(tabId, {
        selectedProfileId: saved.id,
        profileName: saved.name,
        profileColor: saved.color ?? null,
      });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleDeleteProfile = async (id: string) => {
    const tabId = activeTabId;
    const existing = profiles.find((p) => p.id === id);
    if (!existing) return;
    if (!window.confirm(`Delete "${existing.name}"?`)) return;
    patchTab(tabId, { error: null, busy: true });
    try {
      await deleteProfile(id);
      await refreshProfiles();
      if (activeTab.selectedProfileId === id) {
        patchTab(tabId, { selectedProfileId: null, profileName: '' });
      }
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleQuickConnect = async (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    await quickConnect(profile);
  };

  // Connect, reconnect, test, the health probe and auto-reconnect live
  // in `@plamenix/ui` now. The desktop shell ran a near-identical copy
  // of every one of them, and one of the two had already drifted. What
  // stays here is what is genuinely this edition's: HTTP endpoints, the
  // profile route that keeps the password out of the URL, and
  // `undefined` rather than `null` for an absent optional field.
  const connectionAdapter = useMemo<ConnectionAdapter>(
    () => ({
      connect: ({ form, profileId }) => {
        if (profileId !== null) {
          const args: ProfileConnectArgs = {
            password: form.password,
            pureRust: form.pureRust,
            encryptionRequired: form.encryptionRequired,
          };
          if (form.encryptionKey !== '') args.encryptionKey = form.encryptionKey;
          if (form.fbclientPath !== '') args.fbclientPath = form.fbclientPath;
          if (form.charset !== '') args.charset = form.charset;
          return connectByProfile(profileId, args);
        }
        return fetchTransport.invoke<ConnectResponse>('connect', {
          host: form.host,
          port: form.port,
          database: form.database,
          user: form.user,
          password: form.password,
          encryptionKey: form.encryptionKey === '' ? undefined : form.encryptionKey,
          encryptionRequired: form.encryptionRequired,
          pureRust: form.pureRust,
          fbclientPath: form.fbclientPath === '' ? undefined : form.fbclientPath,
          charset: form.charset === '' ? undefined : form.charset,
        });
      },
      testConnection: (form) =>
        fetchTransport.invoke<TestConnectionResult>('test-connection', {
          host: form.host,
          port: form.port,
          database: form.database,
          user: form.user,
          password: form.password,
          encryptionKey: form.encryptionKey === '' ? undefined : form.encryptionKey,
          encryptionRequired: form.encryptionRequired,
          pureRust: form.pureRust,
          fbclientPath: form.fbclientPath === '' ? undefined : form.fbclientPath,
          charset: form.charset === '' ? undefined : form.charset,
        }),
      pingSession: (sessionId) =>
        fetchTransport
          .invoke<{ engineVersion: string }>('ping-session', { sessionId })
          .then((r) => r.engineVersion),
    }),
    [],
  );

  const autoReconnect = useConnectionPrefs((s) => s.autoReconnect);
  const {
    handleConnect,
    handleReconnect,
    handleTestConnection,
    handleQuickConnect: quickConnect,
  } = useConnectionActions({
    adapter: connectionAdapter,
    activeTab,
    tabs,
    patchTab,
    renameTab,
    deriveTitle,
    autoReconnect,
    onConnected: (tabId, sessionId) => {
      void refreshCryptState(tabId, sessionId);
      void refreshTxStatus(tabId, sessionId);
      void refreshSchema(tabId, sessionId);
      void refreshEngineVersion(tabId, sessionId);
    },
  });


  // Wires activated plugins into the interceptor chains. Runs once:
  // the web edition activates plugins server-side at boot, so unlike
  // the desktop shell there is no client-driven reload to react to.
  useEffect(() => {
    let handle: { dispose(): void } | null = null;
    let cancelled = false;
    void installPluginInterceptors({
      listInterceptors: async () => {
        const res = await fetch('/api/plugins/interceptors', { headers: authHeaders() });
        if (!res.ok) return [];
        const body = (await res.json()) as {
          interceptors: Array<{ extensionPoint: ExtensionPoint }>;
        };
        return body.interceptors;
      },
      runInterceptors: async (extensionPoint, contextJson) => {
        const res = await fetch('/api/plugins/interceptors/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ extensionPoint, contextJson }),
        });
        if (!res.ok) {
          // A transport failure is not a plugin verdict. Proceeding is
          // the same fail-open rule the host applies to a trap.
          return { verdict: { action: 'proceed' }, skipped: [] };
        }
        return (await res.json()) as PluginInterceptorOutcome;
      },
    }).then((installed) => {
      if (cancelled) installed.dispose();
      else handle = installed;
    });
    return () => {
      cancelled = true;
      handle?.dispose();
    };
  }, []);

  const { refreshCryptState, refreshEngineVersion, refreshSchema, refreshTxStatus } =
    useSessionRefreshers({
      adapter: useMemo(
        () => ({
          cryptState: (sessionId) =>
            fetchTransport
              .invoke<CryptStateResponse>('crypt-state', { sessionId })
              .then((r) => r.state),
          engineVersion: (sessionId) =>
            fetchTransport
              .invoke<{ engineVersion: string }>('ping-session', { sessionId })
              .then((r) => r.engineVersion),
          describeSchema: (sessionId) =>
            fetchTransport.invoke<Schema>('describe-schema', { sessionId }),
          transactionStatus: (sessionId) =>
            fetchTransport.invoke<TxStatus>('transaction/status', { sessionId }),
        }),
        [],
      ),
      patchTab,
    });


  const handleExecute = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    const decision = await resolveStatement({
      tabId,
      sessionId: tab.sessionId,
      sql: tab.sql,
    });
    if (decision.action === 'cancel') {
      patchTab(tabId, { error: decision.reason });
      return;
    }
    const sql = decision.sql;
    const key = recentKeyOf(tab.form, tab.profileName);
    const startedAt = Date.now();
    // Remembered so the outcome can be discarded if the tab has moved
    // to a different session by the time it settles.
    const ranAgainst = tab.sessionId;
    patchTab(tabId, { error: null, busy: true });
    try {
      const res = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql,
        profileId: historyKeyOf(tab.selectedProfileId, tab.form),
        historyLimit: currentHistoryLimit(),
      });
      patchTab(tabId, { results: res, executedSql: sql, focusedObjectName: null });
      notifyMutations(res);
      recordExec(key, sql, startedAt, res, null);
      // Manual mode opens the transaction on the first statement and
      // counts each one after, so the indicator needs a refresh.
      if (tab.sessionId) void refreshTxStatus(tabId, tab.sessionId);
    } catch (err) {
      // A statement whose session the tab has since left is not a
      // failure to report: abandoning ends the session under the
      // in-flight execute, so this rejection is the abandon working.
      // Writing it would stamp an error on a tab that has already
      // reconnected and looks healthy.
      if (isStaleSession(ranAgainst, useTabsStore.getState().tabs.find((t) => t.id === tabId)?.sessionId ?? null)) {
        return;
      }
      patchTab(tabId, { error: String(err) });
      recordExec(key, sql, startedAt, null, String(err));
    } finally {
      if (!isStaleSession(ranAgainst, useTabsStore.getState().tabs.find((t) => t.id === tabId)?.sessionId ?? null)) {
        patchTab(tabId, { busy: false });
      }
    }
  };

  const handleCommitCellEdit = useCallback(
    async (sql: string) => {
      const tab = activeTab;
      if (!tab.sessionId) {
        throw new Error('No active session.');
      }
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      try {
        const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
          sessionId: tab.sessionId,
          sql,
          profileId: historyKeyOf(tab.selectedProfileId, tab.form),
          historyLimit: currentHistoryLimit(),
        });
        firstAffected(outcomes, 'UPDATE');
        notifyMutations(outcomes);
        recordExec(key, sql, startedAt, outcomes, null);
      } catch (err) {
        recordExec(key, sql, startedAt, null, String(err));
        throw err;
      }
    },
    [activeTab],
  );

  const handleFetchBlob = useCallback(
    async (blobId: string) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const res = await fetchTransport.invoke<{ hex: string }>('fetch-blob', {
        sessionId: tab.sessionId,
        blobId,
      });
      return res.hex;
    },
    [activeTab],
  );

  const handleExecuteDdl = useCallback(
    async (sql: string) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      try {
        const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
          sessionId: tab.sessionId,
          sql,
          profileId: historyKeyOf(tab.selectedProfileId, tab.form),
          historyLimit: currentHistoryLimit(),
        });
        for (const outcome of outcomes) {
          if (outcome.status === 'err') throw new Error(outcome.error);
        }
        notifyMutations(outcomes);
        recordExec(key, sql, startedAt, outcomes, null);
      } catch (err) {
        recordExec(key, sql, startedAt, null, String(err));
        throw err;
      }
    },
    [activeTab],
  );

  const handleStreamedExport: StreamedExportRunner = useCallback(
    async (req: StreamedExportRequest): Promise<StreamedExportResult> =>
      runGuardedExport(req, {
        tabId: activeTab.id,
        // Raw `fetch` rather than the transport: this endpoint answers
        // with a file, not the transport's JSON envelope.
        transfer: async (request) => {
          const response = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
              sessionId: request.sessionId,
              format: request.format,
              csvDelimiter: request.csvDelimiter,
              scope: request.scope,
              includeDdl: request.includeDdl ?? true,
            }),
          });
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(text || `export HTTP ${response.status}`);
          }
          const blob = await response.blob();
          const disposition = response.headers.get('Content-Disposition') ?? '';
          const named = /filename="([^"]+)"/.exec(disposition);
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
          return {
            blob,
            suggestedFilename: named?.[1] ?? `plamenix-export-${stamp}.${request.format}`,
          };
        },
      }),
    [activeTab.id],
  );

  const handleFetchTableExport = useCallback(
    async (table: TableInfo): Promise<TableExportPart> => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const quoted = quoteIdentifier(table.name);
      const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql: `SELECT * FROM ${quoted}`,
      });
      const { columns, rows } = firstRows(outcomes, table.name);
      return {
        table,
        columns,
        rows,
      };
    },
    [activeTab],
  );

  const handleCountAllRows = useCallback(
    async ({ table, predicate }: { table: string; predicate: string | null }) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const quoted = quoteIdentifier(table);
      const sql = predicate
        ? `SELECT COUNT(*) FROM ${quoted} WHERE ${predicate}`
        : `SELECT COUNT(*) FROM ${quoted}`;
      const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql,
      });
      const { rows } = firstRows(outcomes, 'COUNT(*)');
      return countFromCell(rows[0]?.cells[0]);
    },
    [activeTab],
  );

  const handleFetchScopedRows = useCallback(
    async ({ table, predicate }: { table: string; predicate: string | null }) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const quoted = quoteIdentifier(table);
      const sql = predicate
        ? `SELECT * FROM ${quoted} WHERE ${predicate}`
        : `SELECT * FROM ${quoted}`;
      const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql,
      });
      return firstRows(outcomes, 'Scoped fetch').rows;
    },
    [activeTab],
  );

  const handleBrowseTable = useCallback(
    async (name: string) => {
      const tabId = activeTabId;
      const tab = activeTab;
      if (!tab.sessionId) return;
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
      const sql = `SELECT * FROM ${quoted}`;
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      patchTab(tabId, { error: null, busy: true });
      try {
        const res = await fetchTransport.invoke<StatementOutcome[]>('execute', {
          sessionId: tab.sessionId,
          sql,
          profileId: historyKeyOf(tab.selectedProfileId, tab.form),
          historyLimit: currentHistoryLimit(),
        });
        // Show the data in the result panel without touching the editor
        // buffer. Flag table-focus mode so the content pane swaps to
        // the tabbed `TableObjectView` (Data / Schema / DDL).
        patchTab(tabId, { results: res, executedSql: sql, focusedObjectName: name });
        recordExec(key, sql, startedAt, res, null);
      } catch (err) {
        patchTab(tabId, { error: String(err) });
        recordExec(key, sql, startedAt, null, String(err));
      } finally {
        patchTab(tabId, { busy: false });
      }
    },
    [activeTab, activeTabId, patchTab],
  );

  const handleApplyFilter = useCallback(
    async (sql: string, options?: { recordHistory?: boolean }) => {
      const tabId = activeTabId;
      const tab = activeTab;
      if (!tab.sessionId) return;
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      patchTab(tabId, { error: null, busy: true });
      try {
        const res = await fetchTransport.invoke<StatementOutcome[]>('execute', {
          sessionId: tab.sessionId,
          sql,
          // Omitted for the automatic re-read after a write: history is
          // what the user ran, and the host skips recording when there
          // is no key.
          profileId:
            options?.recordHistory === false
              ? undefined
              : historyKeyOf(tab.selectedProfileId, tab.form),
          historyLimit: currentHistoryLimit(),
        });
        patchTab(tabId, { results: res, executedSql: sql });
        recordExec(key, sql, startedAt, res, null);
      } catch (err) {
        patchTab(tabId, { error: String(err) });
        recordExec(key, sql, startedAt, null, String(err));
      } finally {
        patchTab(tabId, { busy: false });
      }
    },
    [activeTab, activeTabId, patchTab],
  );

  /** I5.5 — dispatch a fully-resolved `SchemaDdl` through the same
   *  autoExecute / insert-into-editor / confirm-then-run pipeline the
   *  built-in `SchemaAction` handler uses. Plugin schema_actions go
   *  through this directly; built-in actions go through
   *  `handleSchemaAction` → `schemaDdl(action)` → here. */
  const dispatchDdl = async (ddl: SchemaDdl): Promise<boolean> => {
    const tabId = activeTabId;
    const tab = activeTab;
    const key = recentKeyOf(tab.form, tab.profileName);
    return dispatchSchemaDdl(ddl, {
      sessionId: tab.sessionId,
      execute: (sql) =>
        fetchTransport.invoke<StatementOutcome[]>('execute', {
          sessionId: tab.sessionId,
          sql,
          profileId: historyKeyOf(tab.selectedProfileId, tab.form),
          historyLimit: currentHistoryLimit(),
        }),
      patch: (patch) => patchTab(tabId, patch),
      record: (sql, startedAt, outcomes, error) =>
        recordExec(key, sql, startedAt, outcomes, error),
      refreshSchema: () => {
        if (tab.sessionId) void refreshSchema(tabId, tab.sessionId);
      },
      confirm: (prompt) => window.confirm(prompt),
    });
  };

  const handleSchemaAction = async (action: SchemaAction) => {
    await applySchemaAction(action, {
      tabId: activeTabId,
      sessionId: activeTab.sessionId,
      dispatch: dispatchDdl,
      patch: (patch) => patchTab(activeTabId, patch),
    });
  };

  const handleSetTxMode = async (mode: TxMode, config: TxConfig) => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    patchTab(tabId, { busy: true });
    try {
      const status = await fetchTransport.invoke<TxStatus>('transaction/mode', {
        sessionId: tab.sessionId,
        mode,
        config,
      });
      patchTab(tabId, { txStatus: status, error: null });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const finishTx = async (which: 'commit' | 'rollback') => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    patchTab(tabId, { busy: true });
    try {
      const status = await fetchTransport.invoke<TxStatus>(`transaction/${which}`, {
        sessionId: tab.sessionId,
      });
      patchTab(tabId, { txStatus: status, error: null });
      // DDL is transactional in Firebird, so committing or discarding
      // can change the schema.
      void refreshSchema(tabId, tab.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  /// Asks before throwing away uncommitted work. An open transaction
  /// with nothing in it is not worth interrupting anyone over.
  const confirmDiscardTx = (tab: TabState, what: string): boolean => {
    if (!hasUncommittedWork(tab.txStatus)) return true;
    const count = tab.txStatus?.pendingStatements ?? 0;
    const statements = count === 1 ? '1 statement' : `${count} statements`;
    return window.confirm(
      `${what} will roll back ${statements} that have not been committed. Continue?`,
    );
  };

  // Firebird offers no way to stop a running statement through either
  // backend Plamenix ships, so the only honest lever is the attachment
  // itself: detaching rolls back the transaction and the server stops
  // the work with it. The user is told that cost before it happens.
  const handleAbandon = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    if (abandonNeedsConfirmation(tab.txStatus) && !window.confirm(describeAbandonCost(tab.txStatus))) {
      return;
    }
    await abandonStatement({
      sessionId: tab.sessionId,
      close: (sessionId) => fetchTransport.invoke<{ closed: boolean }>('close', { sessionId }).then(() => undefined),
      reconnect: handleReconnect,
      onError: (message) => patchTab(tabId, { error: message }),
    });
  };

  const handleDisconnect = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    if (!confirmDiscardTx(tab, 'Disconnecting')) return;
    patchTab(tabId, { error: null, busy: true });
    try {
      await fetchTransport.invoke<{ closed: boolean }>('close', { sessionId: tab.sessionId });
      if (tab.selectedProfileId !== null) {
        void touchProfileDisconnected(tab.selectedProfileId).catch(() => {});
      }
      patchTab(tabId, {
        sessionId: null,
        results: null,
        cryptState: null,
        schema: null,
        health: 'unknown',
        lastPingAt: null,
        connectedAt: null,
        engineVersion: null,
        txStatus: null,
      });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleListAliases = async () => {
    setAliasesLoading(true);
    try {
      const res = await fetchTransport.invoke<ListAliasesResult>('list-aliases');
      setAliasesData(res);
    } catch {
      setAliasesData({ sourcePath: null, aliases: [] });
    } finally {
      setAliasesLoading(false);
    }
  };

  const handleTabClose = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab && !confirmDiscardTx(tab, 'Closing this tab')) return;
    if (tab?.sessionId) {
      void fetchTransport
        .invoke<{ closed: boolean }>('close', { sessionId: tab.sessionId })
        .catch(() => {});
    }
    closeTab(id);
  };

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsFetchedAt, setStatsFetchedAt] = useState<number | null>(null);
  const [statsTick, setStatsTick] = useState(0);

  const refreshStats = useCallback(async (sessionId: string) => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const next = await fetchTransport.invoke<DatabaseStats>('database-stats', {
        sessionId,
      });
      setStats(next);
      setStatsFetchedAt(Date.now());
    } catch (err) {
      setStatsError(String(err));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const openStats = useCallback(() => {
    if (!activeTab.sessionId) return;
    setStatsOpen(true);
    void refreshStats(activeTab.sessionId);
  }, [activeTab.sessionId, refreshStats]);

  useEffect(() => {
    if (!statsOpen) return;
    const id = window.setInterval(() => setStatsTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [statsOpen]);

  const toggleMode = useThemeStore((s) => s.toggleMode);
  const toggleSidebar = useThemeStore((s) => s.toggleSidebar);
  const themeMode = useResolvedThemeMode();

  const accentByTabId = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const t of tabs) {
      const swatch = swatchFor(t.profileColor ?? null, themeMode);
      if (swatch !== undefined) map[t.id] = swatch;
    }
    return map;
  }, [tabs, themeMode]);

  // The dispatcher and the six shell defaults live in `@plamenix/ui`.
  // Handlers are passed directly: the hook owns the ref that keeps the
  // once-registered bindings pointed at the current ones.
  // Every shipped built-in contribution, for the life of the shell.
  // They used to register from inside the components that consumed
  // them, which made a feature's availability depend on an unrelated
  // component being mounted — the Format button was the visible case.
  useBuiltinContributions();

  // Shell events reach WASM plugins from here. The host is asked which
  // patterns anything subscribed to, so a topic nobody wants costs
  // nothing — `editor/changed` fires as the user types.
  const [pluginEventPatterns, setPluginEventPatterns] = useState<string[]>([]);
  const refreshPluginEventPatterns = useCallback(() => {
    void fetch('/api/plugins/event-patterns', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { patterns: [] }))
      .then((body: { patterns?: string[] }) => setPluginEventPatterns(body.patterns ?? []))
      .catch(() => setPluginEventPatterns([]));
  }, []);
  useEffect(refreshPluginEventPatterns, [refreshPluginEventPatterns]);
  usePluginEventForwarding({
    subscribedPatterns: pluginEventPatterns,
    forward: (topic, payload, sessionId) => {
      void fetch('/api/plugins/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ topic, payload, sessionId }),
      }).catch(() => {
        // A plugin trapping on an event must not disturb the
        // interaction that produced it; the supervisor records it.
      });
    },
  });


  // The host→client push channel. Everything the server pushes lands on
  // the shared event bus, so a subscriber cannot tell whether it came
  // from this edition's WebSocket or the desktop shell's Tauri events.
  useEffect(() => connectEventChannel(), []);

  useDefaultKeybindings({
    openCheatSheet: () => setShortcutsOpen(true),
    openSearchPalette: () => setSearchOpen(true),
    openCommandPalette: () => setPaletteOpen(true),
    newTab: () => newTab(),
    closeActiveTab: () => handleTabClose(activeTabId),
    canSaveProfile: () =>
      activeTab.sessionId === null && activeTab.profileName.trim() !== '' && !activeTab.busy,
    saveActiveProfile: () => void handleSaveProfile(),
  });

  const mod = getModKeyLabel();

  const commands = useShellCommands({
    mod,
    themeMode,
    hasSession: activeTab.sessionId !== null,
    hasProfile: activeTab.selectedProfileId !== null,
    newTab: () => newTab(),
    closeTab: () => handleTabClose(activeTabId),
    toggleTheme: toggleMode,
    toggleSidebar,
    showShortcuts: () => setShortcutsOpen(true),
    saveProfile: () => void handleSaveProfile(),
    connect: () => void handleConnect(),
    execute: () => void handleExecute(),
    refreshSchema: () => {
      if (activeTab.sessionId) void refreshSchema(activeTabId, activeTab.sessionId);
    },
    disconnect: () => void handleDisconnect(),
    openHistory: () => void openHistory(),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch bg-inset">
        <div className="flex-1 overflow-hidden">
          <TabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActive}
            onClose={handleTabClose}
            onNew={() => newTab()}
            onReorder={reorderTab}
            accentByTabId={accentByTabId}
          />
        </div>
        <div className="flex shrink-0 items-stretch border-b border-edge">
          {/* This edition's shell has no Home/Menu pair to sit between,
              so History goes beside Settings. It opens the dialog rather
              than a pane: there is no pane switch here to own one, and
              the point is the same either way — history was reachable
              only by a keyboard shortcut nobody was told about. */}
          {activeTab.sessionId !== null && (
            <HistoryButton active={historyOpen} onClick={() => void openHistory()} />
          )}
          <SettingsButton onOpenDetailed={() => setShowSettings(true)} />
        </div>
      </div>
      {showSettings && activeTab.sessionId === null ? (
        <SettingsPage onClose={() => setShowSettings(false)} backLabel="Back to connections" />
      ) : activeTab.sessionId === null ? (
        <ConnectView
          tab={activeTab}
          profiles={profiles}
          aliasesData={aliasesData}
          aliasesLoading={aliasesLoading}
          onFieldChange={updateField}
          onSelectProfile={handleSelectProfile}
          onProfileNameChange={(v) => patchTab(activeTabId, { profileName: v })}
          onProfileColorChange={(c) => patchTab(activeTabId, { profileColor: c })}
          onSaveProfile={handleSaveProfile}
          onDeleteProfile={handleDeleteProfile}
          onQuickConnect={handleQuickConnect}
          onConnect={handleConnect}
          onTest={handleTestConnection}
          onListAliases={handleListAliases}
        />
      ) : (
        <SessionView
          tab={activeTab}
          showSettings={showSettings}
          onCloseSettings={() => setShowSettings(false)}
          onCloseFocusedObject={() => patchTab(activeTabId, { focusedObjectName: null })}
          onOpenDeepSearch={() => setSearchOpen(true)}
          onSqlChange={(v) => patchTab(activeTabId, { sql: v })}
          onBookmarksChange={(next) => patchTab(activeTabId, { bookmarks: next })}
          onExecute={handleExecute}
          onAbandon={() => void handleAbandon()}
          onDisconnect={handleDisconnect}
          onSetTxMode={(mode, config) => void handleSetTxMode(mode, config)}
          onCommitTx={() => void finishTx('commit')}
          onRollbackTx={() => void finishTx('rollback')}
          onOpenStats={openStats}
          onCommitCellEdit={handleCommitCellEdit}
          onCommitDdl={handleExecuteDdl}
          onFetchTableExport={handleFetchTableExport}
          onStreamedExport={handleStreamedExport}
          onApplyFilter={handleApplyFilter}
          onColumnWidthsChange={(next) => patchTab(activeTabId, { columnWidths: next })}
          onFetchBlob={handleFetchBlob}
          onCountAllRows={handleCountAllRows}
          onFetchScopedRows={handleFetchScopedRows}
          onReconnect={handleReconnect}
          onRefreshSchema={() => {
            if (activeTab.sessionId) {
              void refreshSchema(activeTabId, activeTab.sessionId);
            }
          }}
          onSchemaAction={handleSchemaAction}
          onPluginDdl={dispatchDdl}
          onClearError={() => patchTab(activeTabId, { error: null })}
          onShowDdl={handleShowDdl}
          onBrowseTable={handleBrowseTable}
        />
      )}
      <DdlViewerModal
        kind={ddlViewer?.kind ?? null}
        name={ddlViewer?.name ?? null}
        source={ddlViewer?.source ?? null}
        loading={ddlViewer?.loading ?? false}
        error={ddlViewer?.error ?? null}
        onClose={() => setDdlViewer(null)}
        onOpenInEditor={(sql) => {
          const id = newTab();
          patchTab(id, { sql });
          setActive(id);
        }}
      />
      <HistoryPanel
        open={historyOpen}
        profileLabel={
          (activeTab.selectedProfileId
            ? profiles.find((p) => p.id === activeTab.selectedProfileId)?.name
            : null) ??
          activeTab.profileName ??
          'No profile'
        }
        entries={historyEntries}
        loading={historyLoading}
        onClose={() => setHistoryOpen(false)}
        onPick={(sql) => patchTab(activeTabId, { sql })}
        onClear={clearHistory}
        onSetLabel={setHistoryLabel}
        onDeleteEntry={deleteHistoryEntry}
        onDeleteEntries={deleteHistoryEntries}
      />
      <ShellOverlays
        tab={{
          sessionId: activeTab.sessionId,
          health: activeTab.health,
          user: activeTab.form.user,
          host: activeTab.form.host,
          port: activeTab.form.port,
          database: activeTab.form.database,
          executedSql: activeTab.executedSql,
          results: activeTab.results,
          schema: activeTab.schema,
        }}
        recentKey={recentKeyOf(activeTab.form, activeTab.profileName)}
        commands={commands}
        paletteOpen={paletteOpen}
        onPaletteClose={() => setPaletteOpen(false)}
        shortcutsOpen={shortcutsOpen}
        onShortcutsClose={() => setShortcutsOpen(false)}
        searchOpen={searchOpen}
        onSearchClose={() => setSearchOpen(false)}
        onSearchPick={(id) => patchTab(activeTabId, { sql: appendIdentifier(activeTab.sql, id) })}
      />
      <StatsDashboard
        open={statsOpen}
        stats={stats}
        loading={statsLoading}
        error={statsError}
        lastRefreshLabel={
          statsFetchedAt !== null ? formatRelative(statsFetchedAt, statsTick) : null
        }
        onClose={() => setStatsOpen(false)}
        onRefresh={() => {
          if (activeTab.sessionId) void refreshStats(activeTab.sessionId);
        }}
      />
      <ToastViewport
        onOpenInEditor={(sql) => {
          const id = newTab();
          patchTab(id, { sql });
          setActive(id);
        }}
      />
      <ConfirmationModal request={confirmHead} onConfirm={onConfirmHead} onCancel={onCancelHead} />
    </div>
  );
}

interface ConnectViewProps {
  tab: TabState;
  profiles: Profile[];
  aliasesData: ListAliasesResult | null;
  aliasesLoading: boolean;
  onFieldChange: <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => void;
  onSelectProfile: (id: string | null) => void;
  onProfileNameChange: (value: string) => void;
  onProfileColorChange: (color: string | null) => void;
  onSaveProfile: () => void;
  onDeleteProfile: (id: string) => void;
  onQuickConnect: (id: string) => void;
  onConnect: () => void;
  onTest: () => void;
  onListAliases: () => void;
}

function ConnectView({
  tab,
  profiles,
  aliasesData,
  aliasesLoading,
  onFieldChange,
  onSelectProfile,
  onProfileNameChange,
  onProfileColorChange,
  onSaveProfile,
  onDeleteProfile,
  onQuickConnect,
  onConnect,
  onTest,
  onListAliases,
}: ConnectViewProps) {
  return (
    <div className="flex-1 overflow-hidden">
      <ConnectionScreen
        form={tab.form}
        profileName={tab.profileName}
        busy={tab.busy}
        error={tab.error}
        profiles={profiles}
        selectedProfileId={tab.selectedProfileId}
        testing={tab.testing}
        testResult={tab.testResult}
        aliasesData={aliasesData}
        aliasesLoading={aliasesLoading}
        profileColor={tab.profileColor}
        onChange={onFieldChange}
        onProfileNameChange={onProfileNameChange}
        onProfileColorChange={onProfileColorChange}
        onSelectProfile={onSelectProfile}
        onSaveProfile={onSaveProfile}
        onDeleteProfile={onDeleteProfile}
        onQuickConnect={onQuickConnect}
        onSubmit={onConnect}
        onTest={onTest}
        onListAliases={onListAliases}
      />
    </div>
  );
}

interface SessionViewProps {
  tab: TabState;
  onSqlChange: (value: string) => void;
  onBookmarksChange: (next: Record<string, number>) => void;
  onExecute: () => void;
  onAbandon: () => void;
  onDisconnect: () => void;
  onSetTxMode: (mode: TxMode, config: TxConfig) => void;
  onCommitTx: () => void;
  onRollbackTx: () => void;
  onRefreshSchema: () => void;
  onSchemaAction: (action: SchemaAction) => void;
  onPluginDdl: (ddl: SchemaDdl) => void;
  onClearError: () => void;
  onOpenStats: () => void;
  onCommitCellEdit: (sql: string) => Promise<void>;
  onCommitDdl: (sql: string) => Promise<void>;
  onFetchTableExport: (table: TableInfo) => Promise<TableExportPart>;
  onStreamedExport: StreamedExportRunner;
  onApplyFilter: (sql: string, options?: { recordHistory?: boolean }) => Promise<void>;
  onColumnWidthsChange: (next: Record<string, number>) => void;
  onFetchBlob: (blobId: string) => Promise<string>;
  onCountAllRows: (args: { table: string; predicate: string | null }) => Promise<number>;
  onFetchScopedRows: (args: {
    table: string;
    predicate: string | null;
  }) => Promise<{ cells: ColumnValue[] }[]>;
  onReconnect: () => void;
  onShowDdl: (kind: DdlSourceKind, name: string) => void;
  onBrowseTable: (name: string) => Promise<void>;
  onCloseFocusedObject: () => void;
  showSettings: boolean;
  onCloseSettings: () => void;
  onOpenDeepSearch: () => void;
}

function SessionView({
  tab,
  onSqlChange,
  onBookmarksChange,
  onExecute,
  onAbandon,
  onDisconnect,
  onSetTxMode,
  onCommitTx,
  onRollbackTx,
  onRefreshSchema,
  onSchemaAction,
  onPluginDdl,
  onClearError,
  onOpenStats,
  onCommitCellEdit,
  onCommitDdl,
  onFetchTableExport,
  onStreamedExport,
  onApplyFilter,
  onColumnWidthsChange,
  onFetchBlob,
  onCountAllRows,
  onFetchScopedRows,
  onReconnect,
  onShowDdl,
  onBrowseTable,
  onCloseFocusedObject,
  showSettings,
  onCloseSettings,
  onOpenDeepSearch,
}: SessionViewProps) {
  const sidebarCollapsed = useThemeStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useThemeStore((s) => s.toggleSidebar);
  const [schemaEditorOpen, setSchemaEditorOpen] = useState(false);
  const [objectListKind, setObjectListKind] = useState<ObjectListKind | null>(null);
  const [newObjectKind, setNewObjectKind] = useState<NewObjectKind | null>(null);
  const [dbExportOpen, setDbExportOpen] = useState(false);
  if (!tab.sessionId) return null;
  return (
    <div className="flex flex-1 overflow-hidden">
      {sidebarCollapsed ? (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Expand schema sidebar"
          className="flex shrink-0 items-start border-r border-edge bg-canvas px-2 pt-3 text-fg-subtle hover:text-fg"
        >
          »
        </button>
      ) : (
        <div className="flex w-64 shrink-0 flex-col overflow-hidden">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Collapse schema sidebar"
            className="self-end px-2 text-fg-subtle hover:text-fg"
            title="Collapse sidebar"
          >
            «
          </button>
          <div className="flex-1 overflow-hidden">
            <SchemaBrowser
              schema={tab.schema}
              busy={tab.busy}
              onRefresh={onRefreshSchema}
              onCopyIdentifier={(identifier, label) => {
                void copyText(identifier).then((ok) => {
                  useToastStore.getState().push({
                    kind: 'notice',
                    tone: ok ? 'success' : 'error',
                    title: ok ? `Copied ${label}` : `Could not copy ${label}`,
                  });
                });
              }}
              onOpenObject={(target) => {
                if (target.kind === 'table') {
                  void onBrowseTable(target.name);
                } else {
                  onShowDdl(target.kind, target.name);
                }
              }}
              onAction={onSchemaAction}
              onPluginDdl={onPluginDdl}
              onNewTable={() => setSchemaEditorOpen(true)}
              onPickObjectList={(kind) => setObjectListKind(kind)}
              onNewObject={(kind) => setNewObjectKind(kind)}
              onExportDatabase={() => setDbExportOpen(true)}
              engineVersion={tab.engineVersion}
              onShowDdl={onShowDdl}
              onOpenDeepSearch={onOpenDeepSearch}
            />
          </div>
        </div>
      )}
      {showSettings ? (
        <SettingsPage onClose={onCloseSettings} backLabel="Back to session" />
      ) : objectListKind && tab.schema ? (
        <ObjectListPage
          kind={objectListKind}
          schema={tab.schema}
          onClose={() => setObjectListKind(null)}
          onCommit={onCommitDdl}
          onRefresh={onRefreshSchema}
          engineVersion={tab.engineVersion}
          onShowDdl={onShowDdl}
        />
      ) : (
        <main className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
          <QueryPanel
            transactionBar={
              <TransactionBar
                status={tab.txStatus}
                busy={tab.busy}
                onSetMode={onSetTxMode}
                onCommit={onCommitTx}
                onRollback={onRollbackTx}
              />
            }
            sessionId={tab.sessionId}
            sql={tab.sql}
            busy={tab.busy}
            cryptState={tab.cryptState}
            schema={tab.schema}
            bookmarks={tab.bookmarks}
            health={tab.health}
            engineVersion={tab.engineVersion}
            encryptionKeySupplied={tab.form.encryptionKey.length > 0}
            onSqlChange={onSqlChange}
            onExecute={onExecute}
            onAbandon={onAbandon}
            onClose={onDisconnect}
            onBookmarksChange={onBookmarksChange}
            onOpenStats={onOpenStats}
            onReconnect={onReconnect}
            onEditorFocus={() => emitEditorFocused({ tabId: tab.id, focusedAt: Date.now() })}
            onEditorSelectionChange={(sel) =>
              emitEditorSelectionChanged({
                tabId: tab.id,
                anchor: sel.anchor,
                head: sel.head,
                length: sel.head - sel.anchor,
                changedAt: Date.now(),
              })
            }
          />

          {tab.error && <ErrorBanner error={tab.error} onDismiss={onClearError} />}

          {(() => {
            const focusedTable =
              tab.focusedObjectName && tab.schema
                ? (tab.schema.tables.find((t) => t.name === tab.focusedObjectName) ?? null)
                : null;
            if (focusedTable && tab.results && tab.results.length > 0) {
              return (
                <TableObjectView
                  tabId={tab.id}
                  table={focusedTable}
                  results={tab.results}
                  schema={tab.schema}
                  onClose={onCloseFocusedObject}
                  onRefreshData={() => void onBrowseTable(focusedTable.name)}
                  columnWidths={tab.columnWidths}
                  onColumnWidthsChange={onColumnWidthsChange}
                  onCommitCellEdit={onCommitCellEdit}
                  onApplyFilter={onApplyFilter}
                  onFetchBlob={onFetchBlob}
                  onCountAllRows={onCountAllRows}
                  onFetchScopedRows={onFetchScopedRows}
                  sessionId={tab.sessionId}
                />
              );
            }
            if (tab.results && tab.results.length > 0) {
              return (
                <MultiResultView
                  tabId={tab.id}
                  sessionId={tab.sessionId}
                  outcomes={tab.results}
                  schema={tab.schema}
                  onCommitCellEdit={onCommitCellEdit}
                  onApplyFilter={onApplyFilter}
                  columnWidths={tab.columnWidths}
                  onColumnWidthsChange={onColumnWidthsChange}
                  onFetchBlob={onFetchBlob}
                  onCountAllRows={onCountAllRows}
                  onFetchScopedRows={onFetchScopedRows}
                />
              );
            }
            return null;
          })() || (
            <WelcomeDashboard
              sessionId={tab.sessionId}
              user={tab.form.user}
              host={tab.form.host}
              port={tab.form.port}
              database={tab.form.database}
              engineVersion={tab.engineVersion}
              connectedAt={tab.connectedAt}
              schema={tab.schema}
              recentKey={recentKeyOf(tab.form, tab.profileName)}
              onPickRecent={(sql) => onSqlChange(sql)}
            />
          )}
        </main>
      )}
      <SchemaEditorModal
        open={schemaEditorOpen}
        domains={tab.schema?.domains ?? []}
        onClose={() => setSchemaEditorOpen(false)}
        onApply={(sql) => {
          const trimmed = tab.sql.replace(/\s+$/u, '');
          const next = trimmed.length === 0 ? sql : `${trimmed}\n\n${sql}`;
          onSqlChange(next);
        }}
      />
      <NewObjectModal
        open={newObjectKind !== null}
        kind={newObjectKind ?? 'view'}
        schema={tab.schema}
        onClose={() => setNewObjectKind(null)}
        onApply={(sql) => {
          const trimmed = tab.sql.replace(/\s+$/u, '');
          const next = trimmed.length === 0 ? sql : `${trimmed}\n\n${sql}`;
          onSqlChange(next);
        }}
      />
      <DatabaseExportModal
        open={dbExportOpen}
        schema={tab.schema}
        onClose={() => setDbExportOpen(false)}
        onFetchTable={onFetchTableExport}
        onStreamedExport={onStreamedExport}
        sessionId={tab.sessionId}
      />
    </div>
  );
}
