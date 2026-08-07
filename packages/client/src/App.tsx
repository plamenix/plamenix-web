import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  currentHistoryLimit,
  deriveTitle,
  formatRelative,
  recentKeyOf,
  recordExec,
} from './app-helpers.js';
import {
  CommandPalette,
  ConfirmationModal,
  ConnectionScreen,
  DdlViewerModal,
  ErrorBanner,
  DatabaseExportModal,
  HistoryPanel,
  MultiResultView,
  NewObjectModal,
  ObjectListPage,
  QueryPanel,
  ToastViewport,
  notifyMutations,
  SchemaBrowser,
  SchemaEditorModal,
  schemaDdl,
  sourceQuery,
  SettingsButton,
  SettingsPage,
  TableObjectView,
  SearchPalette,
  StatsDashboard,
  StatusBar,
  swatchFor,
  TabStrip,
  WelcomeDashboard,
  ShortcutsCheatSheet,
  getModKeyLabel,
  registerBuiltinDefaultKeybindings,
  connectionOpeningChain,
  editorSavingChain,
  installPluginInterceptors,
  type ExtensionPoint,
  type PluginInterceptorOutcome,
  installDestructiveDropInterceptor,
  setConfirmationProvider,
  type ConfirmationRequest,
  type PendingConfirmation,
  emitExportCompleted,
  emitExportFailed,
  emitExportStarted,
  emitSchemaActionApplied,
  emitEditorFocused,
  emitEditorSelectionChanged,
  exportStartingChain,
  newExportId,
  queryExecutingChain,
  schemaActionApplyingChain,
  useGlobalKeybindings,
  useConnectionPrefs,
  useEmitConnectionEvents,
  useEmitEditorEvents,
  useEmitLifecycleEvents,
  useEmitQueryEvents,
  useEmitSchemaEvents,
  useEmitSettingsThemeEvents,
  useEmitTabEvents,
  useResolvedThemeMode,
  useHealthProbe,
  useRecentQueries,
  useTabsStore,
  useThemeStore,
  type Command,
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
import {
  History,
  Keyboard,
  LogOut,
  Moon,
  PanelLeftClose,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Sun,
  X,
} from 'lucide-react';
import { authHeaders, fetchTransport } from '@/transport/fetch';
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
const HOST_VERSION = '1.0.0-beta.0';
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
    const pid = activeTab.selectedProfileId;
    if (!pid) return;
    setHistoryOpen(true);
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
    const pid = activeTab.selectedProfileId;
    if (!pid) return;
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
      form: {
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        password: '',
        pureRust: profile.pureRust,
        encryptionKey: '',
        encryptionRequired: profile.encryptionRequired,
        fbclientPath: profile.fbclientPath ?? '',
        charset: profile.charset ?? 'UTF8',
        embedded: profile.embedded ?? false,
      },
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
    const tabId = activeTabId;
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    patchTab(tabId, {
      error: null,
      busy: true,
      cryptState: null,
      selectedProfileId: profileId,
      profileName: profile.name,
      form: {
        ...activeTab.form,
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        encryptionRequired: profile.encryptionRequired,
        pureRust: profile.pureRust,
      },
    });
    try {
      const args: ProfileConnectArgs = {
        password: activeTab.form.password,
        pureRust: profile.pureRust,
        encryptionRequired: profile.encryptionRequired,
      };
      if (activeTab.form.encryptionKey !== '') {
        args.encryptionKey = activeTab.form.encryptionKey;
      }
      if (activeTab.form.fbclientPath !== '') {
        args.fbclientPath = activeTab.form.fbclientPath;
      }
      if (activeTab.form.charset !== '') {
        args.charset = activeTab.form.charset;
      }
      const response = await connectByProfile(profileId, args);
      patchTab(tabId, {
        sessionId: response.sessionId,
        results: null,
        health: 'healthy',
        lastPingAt: Date.now(),
        connectedAt: Date.now(),
      });
      renameTab(tabId, profile.name);
      void refreshCryptState(tabId, response.sessionId);
      void refreshTxStatus(tabId, response.sessionId);
      void refreshSchema(tabId, response.sessionId);
      void refreshEngineVersion(tabId, response.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleConnect = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    const decision = await connectionOpeningChain.run({
      tabId,
      profileId: tab.selectedProfileId,
      host: tab.form.host,
      port: tab.form.port,
      database: tab.form.database,
      user: tab.form.user,
      pureRust: tab.form.pureRust,
      encryptionRequired: tab.form.encryptionRequired,
      charset: tab.form.charset,
    });
    if (decision.action === 'cancel') {
      patchTab(tabId, { error: decision.reason });
      return;
    }
    patchTab(tabId, { error: null, busy: true, cryptState: null });
    try {
      let response: ConnectResponse;
      if (tab.selectedProfileId !== null) {
        const args: ProfileConnectArgs = {
          password: tab.form.password,
          pureRust: tab.form.pureRust,
          encryptionRequired: tab.form.encryptionRequired,
        };
        if (tab.form.encryptionKey !== '') {
          args.encryptionKey = tab.form.encryptionKey;
        }
        if (tab.form.fbclientPath !== '') {
          args.fbclientPath = tab.form.fbclientPath;
        }
        if (tab.form.charset !== '') {
          args.charset = tab.form.charset;
        }
        response = await connectByProfile(tab.selectedProfileId, args);
      } else {
        response = await fetchTransport.invoke<ConnectResponse>('connect', {
          host: tab.form.host,
          port: tab.form.port,
          database: tab.form.database,
          user: tab.form.user,
          password: tab.form.password,
          encryptionKey: tab.form.encryptionKey === '' ? undefined : tab.form.encryptionKey,
          encryptionRequired: tab.form.encryptionRequired,
          pureRust: tab.form.pureRust,
          fbclientPath: tab.form.fbclientPath === '' ? undefined : tab.form.fbclientPath,
          charset: tab.form.charset === '' ? undefined : tab.form.charset,
        });
      }
      patchTab(tabId, {
        sessionId: response.sessionId,
        results: null,
        health: 'healthy',
        lastPingAt: Date.now(),
        connectedAt: Date.now(),
      });
      renameTab(tabId, tab.profileName.trim() || deriveTitle(tab.form));
      void refreshCryptState(tabId, response.sessionId);
      void refreshTxStatus(tabId, response.sessionId);
      void refreshSchema(tabId, response.sessionId);
      void refreshEngineVersion(tabId, response.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleReconnect = useCallback(async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (tab.health === 'reconnecting') return;
    patchTab(tabId, { health: 'reconnecting', error: null });
    try {
      let response: ConnectResponse;
      if (tab.selectedProfileId !== null) {
        const args: ProfileConnectArgs = {
          password: tab.form.password,
          pureRust: tab.form.pureRust,
          encryptionRequired: tab.form.encryptionRequired,
        };
        if (tab.form.encryptionKey !== '') {
          args.encryptionKey = tab.form.encryptionKey;
        }
        if (tab.form.fbclientPath !== '') {
          args.fbclientPath = tab.form.fbclientPath;
        }
        if (tab.form.charset !== '') {
          args.charset = tab.form.charset;
        }
        response = await connectByProfile(tab.selectedProfileId, args);
      } else {
        response = await fetchTransport.invoke<ConnectResponse>('connect', {
          host: tab.form.host,
          port: tab.form.port,
          database: tab.form.database,
          user: tab.form.user,
          password: tab.form.password,
          encryptionKey: tab.form.encryptionKey === '' ? undefined : tab.form.encryptionKey,
          encryptionRequired: tab.form.encryptionRequired,
          pureRust: tab.form.pureRust,
          fbclientPath: tab.form.fbclientPath === '' ? undefined : tab.form.fbclientPath,
          charset: tab.form.charset === '' ? undefined : tab.form.charset,
        });
      }
      patchTab(tabId, {
        sessionId: response.sessionId,
        health: 'healthy',
        lastPingAt: Date.now(),
        connectedAt: Date.now(),
      });
      const newSessionId = response.sessionId;
      void fetchTransport
        .invoke<{ engineVersion: string }>('ping-session', { sessionId: newSessionId })
        .then((r) =>
          patchTab(tabId, {
            engineVersion: r.engineVersion.trim().length > 0 ? r.engineVersion.trim() : null,
          }),
        )
        .catch(() => patchTab(tabId, { engineVersion: null }));
    } catch (err) {
      patchTab(tabId, { health: 'dead', error: String(err) });
    }
  }, [activeTab, activeTabId, patchTab]);

  useHealthProbe({
    tabs,
    ping: (sessionId) =>
      fetchTransport
        .invoke<{ engineVersion: string }>('ping-session', { sessionId })
        .then((r) => r.engineVersion),
    onPatch: (tabId, patch) => patchTab(tabId, patch),
  });

  // Auto-reconnect: same single-shot-per-dead pattern as desktop.
  const autoReconnect = useConnectionPrefs((s) => s.autoReconnect);
  const lastAutoDeadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoReconnect) {
      lastAutoDeadRef.current = null;
      return;
    }
    if (activeTab.health !== 'dead') {
      lastAutoDeadRef.current = null;
      return;
    }
    if (activeTab.busy) return;
    if (lastAutoDeadRef.current === activeTab.id) return;
    lastAutoDeadRef.current = activeTab.id;
    void handleReconnect();
  }, [activeTab.health, activeTab.busy, activeTab.id, autoReconnect, handleReconnect]);

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

  const refreshCryptState = async (tabId: string, sessionId: string) => {
    try {
      const res = await fetchTransport.invoke<CryptStateResponse>('crypt-state', { sessionId });
      patchTab(tabId, { cryptState: res.state });
    } catch {
      patchTab(tabId, { cryptState: null });
    }
  };

  const refreshEngineVersion = async (tabId: string, sessionId: string) => {
    try {
      const res = await fetchTransport.invoke<{ engineVersion: string }>('ping-session', {
        sessionId,
      });
      patchTab(tabId, {
        engineVersion: res.engineVersion.trim().length > 0 ? res.engineVersion.trim() : null,
        lastPingAt: Date.now(),
      });
    } catch {
      patchTab(tabId, { engineVersion: null });
    }
  };

  const refreshSchema = async (tabId: string, sessionId: string) => {
    try {
      const schema = await fetchTransport.invoke<Schema>('describe-schema', { sessionId });
      patchTab(tabId, { schema });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    }
  };

  const handleExecute = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    const sqlAtSend = tab.sql;
    const editorDecision = await editorSavingChain.run({
      tabId,
      sessionId: tab.sessionId,
      sql: sqlAtSend,
    });
    if (editorDecision.action === 'cancel') {
      patchTab(tabId, { error: editorDecision.reason });
      return;
    }
    const sqlAfterEditor = editorDecision.action === 'replace' ? editorDecision.ctx.sql : sqlAtSend;
    const queryDecision = await queryExecutingChain.run({
      tabId,
      sessionId: tab.sessionId,
      sql: sqlAfterEditor,
    });
    if (queryDecision.action === 'cancel') {
      patchTab(tabId, { error: queryDecision.reason });
      return;
    }
    const sql = queryDecision.action === 'replace' ? queryDecision.ctx.sql : sqlAfterEditor;
    const key = recentKeyOf(tab.form, tab.profileName);
    const startedAt = Date.now();
    patchTab(tabId, { error: null, busy: true });
    try {
      const res = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql,
        profileId: tab.selectedProfileId ?? undefined,
        historyLimit: currentHistoryLimit(),
      });
      patchTab(tabId, { results: res, executedSql: sql, focusedObjectName: null });
      notifyMutations(res);
      recordExec(key, sql, startedAt, res, null);
      // Manual mode opens the transaction on the first statement and
      // counts each one after, so the indicator needs a refresh.
      if (tab.sessionId) void refreshTxStatus(tabId, tab.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
      recordExec(key, sql, startedAt, null, String(err));
    } finally {
      patchTab(tabId, { busy: false });
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
          profileId: tab.selectedProfileId ?? undefined,
          historyLimit: currentHistoryLimit(),
        });
        const first = outcomes[0];
        if (!first) {
          throw new Error('UPDATE produced no outcome.');
        }
        if (first.status === 'err') {
          throw new Error(first.error);
        }
        if ('Affected' in first.result && first.result.Affected.rows === 0) {
          throw new Error('UPDATE matched zero rows.');
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
          profileId: tab.selectedProfileId ?? undefined,
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
    async (req: StreamedExportRequest): Promise<StreamedExportResult> => {
      const exportId = newExportId();
      const startedAt = Date.now();
      const scopeLabel =
        req.scope.kind === 'statement'
          ? (req.scope.label ?? req.scope.table?.name ?? req.scope.sql.slice(0, 80))
          : req.scope.tables.map((t) => t.name).join(', ');
      const tables =
        req.scope.kind === 'statement'
          ? req.scope.table
            ? [req.scope.table.name]
            : []
          : req.scope.tables.map((t) => t.name);
      const exportDecision = await exportStartingChain.run({
        tabId: activeTab.id,
        sessionId: req.sessionId,
        format: req.format,
        scopeKind: req.scope.kind,
        scopeLabel,
        tables,
      });
      if (exportDecision.action === 'cancel') {
        throw new Error(exportDecision.reason);
      }
      emitExportStarted({
        exportId,
        tabId: activeTab.id,
        sessionId: req.sessionId,
        format: req.format,
        scopeKind: req.scope.kind,
        scopeLabel,
        startedAt,
      });
      try {
        const response = await fetch('/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            sessionId: req.sessionId,
            format: req.format,
            csvDelimiter: req.csvDelimiter,
            scope: req.scope,
            includeDdl: req.includeDdl ?? true,
          }),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(text || `export HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') ?? '';
        const m = /filename="([^"]+)"/.exec(disposition);
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
        const suggestedFilename = m?.[1] ?? `plamenix-export-${stamp}.${req.format}`;
        emitExportCompleted({
          exportId,
          durationMs: Date.now() - startedAt,
          byteSize: blob.size,
          rowCount: null,
          completedAt: Date.now(),
        });
        return { blob, suggestedFilename };
      } catch (err) {
        emitExportFailed({
          exportId,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
          failedAt: Date.now(),
        });
        throw err;
      }
    },
    [activeTab.id],
  );

  const handleFetchTableExport = useCallback(
    async (table: TableInfo): Promise<TableExportPart> => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(table.name)
        ? table.name
        : `"${table.name.replace(/"/g, '""')}"`;
      const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql: `SELECT * FROM ${quoted}`,
      });
      const first = outcomes[0];
      if (!first) throw new Error(`No outcome for ${table.name}.`);
      if (first.status === 'err') throw new Error(`${table.name}: ${first.error}`);
      if (!('Rows' in first.result)) {
        throw new Error(`${table.name}: SELECT did not return rows.`);
      }
      return {
        table,
        columns: first.result.Rows.columns,
        rows: first.result.Rows.rows,
      };
    },
    [activeTab],
  );

  const handleCountAllRows = useCallback(
    async ({ table, predicate }: { table: string; predicate: string | null }) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(table) ? table : `"${table.replace(/"/g, '""')}"`;
      const sql = predicate
        ? `SELECT COUNT(*) FROM ${quoted} WHERE ${predicate}`
        : `SELECT COUNT(*) FROM ${quoted}`;
      const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql,
      });
      const first = outcomes[0];
      if (!first || first.status !== 'ok' || !('Rows' in first.result)) {
        throw new Error('COUNT(*) did not return a row.');
      }
      const cell = first.result.Rows.rows[0]?.cells[0];
      if (!cell) throw new Error('COUNT(*) returned an empty row.');
      if (cell.type === 'integer') {
        // Integers cross the wire as exact decimal text so a BIGINT
        // survives the JSON hop. A row count is bounded by what the UI
        // can page through, so narrowing it here is safe.
        const parsed = Number(cell.value);
        if (!Number.isFinite(parsed)) {
          throw new Error(`COUNT(*) returned an unparseable value: ${cell.value}.`);
        }
        return parsed;
      }
      if (cell.type === 'float' && typeof cell.value === 'number') {
        return cell.value;
      }
      throw new Error(`COUNT(*) returned an unexpected cell type: ${cell.type}.`);
    },
    [activeTab],
  );

  const handleFetchScopedRows = useCallback(
    async ({ table, predicate }: { table: string; predicate: string | null }) => {
      const tab = activeTab;
      if (!tab.sessionId) throw new Error('No active session.');
      const quoted = /^[A-Z_][A-Z0-9_]*$/.test(table) ? table : `"${table.replace(/"/g, '""')}"`;
      const sql = predicate
        ? `SELECT * FROM ${quoted} WHERE ${predicate}`
        : `SELECT * FROM ${quoted}`;
      const outcomes = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql,
      });
      const first = outcomes[0];
      if (!first) throw new Error('Scoped fetch produced no outcome.');
      if (first.status === 'err') throw new Error(first.error);
      if (!('Rows' in first.result)) {
        throw new Error('Scoped fetch did not return rows.');
      }
      return first.result.Rows.rows;
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
          profileId: tab.selectedProfileId ?? undefined,
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
    async (sql: string) => {
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
          profileId: tab.selectedProfileId ?? undefined,
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
    if (ddl.autoExecute) {
      if (!tab.sessionId) return false;
      const key = recentKeyOf(tab.form, tab.profileName);
      const startedAt = Date.now();
      patchTab(tabId, { error: null, busy: true });
      let executed = false;
      try {
        const res = await fetchTransport.invoke<StatementOutcome[]>('execute', {
          sessionId: tab.sessionId,
          sql: ddl.sql,
          profileId: tab.selectedProfileId ?? undefined,
          historyLimit: currentHistoryLimit(),
        });
        notifyMutations(res);
        recordExec(key, ddl.sql, startedAt, res, null);
        void refreshSchema(tabId, tab.sessionId);
        executed = true;
      } catch (err) {
        patchTab(tabId, { error: String(err) });
        recordExec(key, ddl.sql, startedAt, null, String(err));
      } finally {
        patchTab(tabId, { busy: false });
      }
      return executed;
    }
    if (!ddl.destructive) {
      patchTab(tabId, { sql: ddl.sql });
      return false;
    }
    if (!window.confirm(ddl.confirmPrompt ?? 'Run destructive statement?')) return false;
    if (!tab.sessionId) return false;
    const key = recentKeyOf(tab.form, tab.profileName);
    const startedAt = Date.now();
    patchTab(tabId, { error: null, busy: true, sql: ddl.sql });
    let executed = false;
    try {
      const res = await fetchTransport.invoke<StatementOutcome[]>('execute', {
        sessionId: tab.sessionId,
        sql: ddl.sql,
        profileId: tab.selectedProfileId ?? undefined,
        historyLimit: currentHistoryLimit(),
      });
      patchTab(tabId, { results: res, executedSql: ddl.sql });
      notifyMutations(res);
      recordExec(key, ddl.sql, startedAt, res, null);
      void refreshSchema(tabId, tab.sessionId);
      executed = true;
    } catch (err) {
      patchTab(tabId, { error: String(err) });
      recordExec(key, ddl.sql, startedAt, null, String(err));
    } finally {
      patchTab(tabId, { busy: false });
    }
    return executed;
  };

  const handleSchemaAction = async (action: SchemaAction) => {
    const ddl = schemaDdl(action);
    if (activeTab.sessionId !== null) {
      const decision = await schemaActionApplyingChain.run({
        tabId: activeTabId,
        sessionId: activeTab.sessionId,
        kind: action.kind,
        action: action.action,
        targetName: action.target.name,
        ddl: ddl.sql,
      });
      if (decision.action === 'cancel') {
        patchTab(activeTabId, { error: decision.reason });
        return;
      }
    }
    const executed = await dispatchDdl(ddl);
    if (executed) {
      emitSchemaActionApplied({
        tabId: activeTabId,
        sessionId: activeTab.sessionId,
        kind: action.kind,
        action: action.action,
        targetName: action.target.name,
        ddl: ddl.sql,
        appliedAt: Date.now(),
      });
    }
  };

  /// Pulls the session's transaction state into the tab, so the
  /// indicator reflects the session rather than what the UI assumed.
  const refreshTxStatus = useCallback(
    async (tabId: string, sessionId: string) => {
      try {
        const status = await fetchTransport.invoke<TxStatus>('transaction/status', {
          sessionId,
        });
        patchTab(tabId, { txStatus: status });
      } catch {
        // Not worth surfacing alone; the next real operation reports it.
      }
    },
    [patchTab],
  );

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

  const handleTestConnection = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    patchTab(tabId, { testing: true, testResult: null });
    try {
      const res = await fetchTransport.invoke<TestConnectionResult>('test-connection', {
        host: tab.form.host,
        port: tab.form.port,
        database: tab.form.database,
        user: tab.form.user,
        password: tab.form.password,
        encryptionKey: tab.form.encryptionKey === '' ? undefined : tab.form.encryptionKey,
        encryptionRequired: tab.form.encryptionRequired,
        pureRust: tab.form.pureRust,
        fbclientPath: tab.form.fbclientPath === '' ? undefined : tab.form.fbclientPath,
        charset: tab.form.charset === '' ? undefined : tab.form.charset,
      });
      patchTab(tabId, { testResult: res });
    } catch (err) {
      patchTab(tabId, {
        testResult: {
          ok: false,
          firebirdVersion: null,
          error: String(err),
          durationMs: 0,
        },
      });
    } finally {
      patchTab(tabId, { testing: false });
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

  const handlersRef = useRef({
    newTab,
    handleTabClose,
    handleSaveProfile,
    activeTab,
    activeTabId,
    setPaletteOpen,
    setSearchOpen,
    setShortcutsOpen,
  });
  handlersRef.current = {
    newTab,
    handleTabClose,
    handleSaveProfile,
    activeTab,
    activeTabId,
    setPaletteOpen,
    setSearchOpen,
    setShortcutsOpen,
  };

  // I5.1 — keybindings now live in the registry. The dispatcher
  // hook walks `keybindings` contributions in priority order on
  // every keydown; the built-in `@plamenix-builtin/default-keybindings`
  // registration below carries the six shell defaults that used to
  // live in a 40-line inline switch here. Third-party plugins can
  // override individual combos by registering at lower priority.
  useGlobalKeybindings();
  useEffect(() => {
    return registerBuiltinDefaultKeybindings({
      openCheatSheet: () => handlersRef.current.setShortcutsOpen(true),
      openSearchPalette: () => handlersRef.current.setSearchOpen(true),
      openCommandPalette: () => handlersRef.current.setPaletteOpen(true),
      newTab: () => handlersRef.current.newTab(),
      closeActiveTab: () => handlersRef.current.handleTabClose(handlersRef.current.activeTabId),
      canSaveProfile: () => {
        const t = handlersRef.current.activeTab;
        return t.sessionId === null && t.profileName.trim() !== '' && !t.busy;
      },
      saveActiveProfile: () => void handlersRef.current.handleSaveProfile(),
    });
  }, []);

  const mod = getModKeyLabel();

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'new-tab',
        label: 'New tab',
        description: 'Open a fresh disconnected session',
        icon: Plus,
        shortcut: `${mod}T`,
        group: 'Tabs',
        run: () => newTab(),
      },
      {
        id: 'close-tab',
        label: 'Close tab',
        description: 'Close the active session and tab',
        icon: X,
        shortcut: `${mod}W`,
        group: 'Tabs',
        run: () => handleTabClose(activeTabId),
      },
      {
        id: 'toggle-theme',
        label: `Switch to ${themeMode === 'dark' ? 'light' : 'dark'} theme`,
        description: 'Flip the Plamenix theme',
        icon: themeMode === 'dark' ? Sun : Moon,
        group: 'Appearance',
        run: () => toggleMode(),
      },
      {
        id: 'toggle-sidebar',
        label: 'Toggle schema sidebar',
        description: 'Collapse or expand the schema browser',
        icon: PanelLeftClose,
        group: 'Appearance',
        run: () => toggleSidebar(),
      },
      {
        id: 'show-shortcuts',
        label: 'Show keyboard shortcuts',
        description: 'Cheat sheet of every shortcut Plamenix exposes',
        icon: Keyboard,
        shortcut: '?',
        group: 'Help',
        run: () => setShortcutsOpen(true),
      },
    ];

    if (activeTab.sessionId === null) {
      list.push(
        {
          id: 'save-profile',
          label: 'Save connection profile',
          description: 'Persist the current form values',
          icon: Save,
          shortcut: `${mod}S`,
          group: 'Connection',
          run: () => void handleSaveProfile(),
        },
        {
          id: 'connect',
          label: 'Connect',
          description: 'Open a session against the current form',
          icon: Plug,
          shortcut: `${mod}↵`,
          group: 'Connection',
          run: () => void handleConnect(),
        },
      );
    } else {
      list.push(
        {
          id: 'execute',
          label: 'Execute SQL',
          description: 'Run the current editor buffer',
          icon: Play,
          shortcut: `${mod}↵`,
          group: 'Session',
          run: () => void handleExecute(),
        },
        {
          id: 'refresh-schema',
          label: 'Refresh schema',
          description: 'Reload the table / view list',
          icon: RefreshCw,
          group: 'Session',
          run: () => {
            if (activeTab.sessionId) {
              void refreshSchema(activeTabId, activeTab.sessionId);
            }
          },
        },
        {
          id: 'disconnect',
          label: 'Disconnect',
          description: 'Close the active session',
          icon: LogOut,
          group: 'Session',
          run: () => void handleDisconnect(),
        },
      );
      if (activeTab.selectedProfileId !== null) {
        list.push({
          id: 'history',
          label: 'Show query history',
          description: 'Browse and replay statements run under this profile',
          icon: History,
          group: 'Session',
          run: () => void openHistory(),
        });
      }
    }
    return list;
  }, [
    activeTab,
    activeTabId,
    handleConnect,
    handleDisconnect,
    handleExecute,
    handleSaveProfile,
    handleTabClose,
    mod,
    newTab,
    openHistory,
    themeMode,
    toggleMode,
    toggleSidebar,
  ]);

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
      <StatusBar
        sessionId={activeTab.sessionId}
        health={activeTab.health}
        user={activeTab.form.user}
        host={activeTab.form.host}
        port={activeTab.form.port}
        database={activeTab.form.database}
        executedSql={activeTab.executedSql}
        results={activeTab.results}
        recentKey={recentKeyOf(activeTab.form, activeTab.profileName)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <ShortcutsCheatSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SearchPalette
        open={searchOpen}
        schema={activeTab.schema}
        onClose={() => setSearchOpen(false)}
        onPick={(id) =>
          patchTab(activeTabId, {
            sql:
              activeTab.sql.length > 0 && !activeTab.sql.endsWith(' ')
                ? `${activeTab.sql} ${id}`
                : `${activeTab.sql}${id}`,
          })
        }
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
  onApplyFilter: (sql: string) => Promise<void>;
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
              onSelect={(id) =>
                onSqlChange(
                  tab.sql.length > 0 && !tab.sql.endsWith(' ')
                    ? `${tab.sql} ${id}`
                    : `${tab.sql}${id}`,
                )
              }
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
