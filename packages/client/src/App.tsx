import { useCallback, useEffect, useState } from 'react';
import {
  ConnectionPanel,
  ProfilePicker,
  QueryPanel,
  ResultTable,
  type ConnectionForm,
  type CryptState,
  type Profile,
  type QueryResult,
} from '@plamenix/ui';
import { fetchTransport } from '@/transport/fetch';
import {
  connectByProfile,
  deleteProfile,
  listProfiles,
  saveProfile,
  type ProfileConnectArgs,
  type ProfileDraft,
} from '@/profiles';

interface ConnectResponse {
  sessionId: string;
}

interface CryptStateResponse {
  state: CryptState;
}

const initialForm: ConnectionForm = {
  host: '127.0.0.1',
  port: 3050,
  database: '/var/lib/firebird/data/test.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
  pureRust: true,
  encryptionKey: '',
  encryptionRequired: false,
};

const initialSql = "SELECT 42 AS answer, 'plamenix' AS name FROM RDB$DATABASE";

export function App() {
  const [form, setForm] = useState<ConnectionForm>(initialForm);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string>('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sql, setSql] = useState<string>(initialSql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [cryptState, setCryptState] = useState<CryptState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const updateField = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const refreshProfiles = useCallback(async () => {
    try {
      setProfiles(await listProfiles());
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const handleSelectProfile = (id: string | null) => {
    setSelectedProfileId(id);
    if (id === null) {
      setProfileName('');
      return;
    }
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    setProfileName(profile.name);
    setForm({
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password: '',
      pureRust: profile.pureRust,
      encryptionKey: '',
      encryptionRequired: profile.encryptionRequired,
    });
  };

  const handleSaveProfile = async () => {
    setError(null);
    setBusy(true);
    try {
      const draft: ProfileDraft = {
        name: profileName.trim(),
        host: form.host,
        port: form.port,
        database: form.database,
        user: form.user,
        encryptionRequired: form.encryptionRequired,
        pureRust: form.pureRust,
      };
      if (selectedProfileId !== null) {
        draft.id = selectedProfileId;
      }
      const saved = await saveProfile(draft);
      await refreshProfiles();
      setSelectedProfileId(saved.id);
      setProfileName(saved.name);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (selectedProfileId === null) return;
    setError(null);
    setBusy(true);
    try {
      await deleteProfile(selectedProfileId);
      await refreshProfiles();
      setSelectedProfileId(null);
      setProfileName('');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    setCryptState(null);
    try {
      let response: ConnectResponse;
      if (selectedProfileId !== null) {
        const args: ProfileConnectArgs = {
          password: form.password,
          pureRust: form.pureRust,
          encryptionRequired: form.encryptionRequired,
        };
        if (form.encryptionKey !== '') {
          args.encryptionKey = form.encryptionKey;
        }
        response = await connectByProfile(selectedProfileId, args);
      } else {
        response = await fetchTransport.invoke<ConnectResponse>('connect', {
          host: form.host,
          port: form.port,
          database: form.database,
          user: form.user,
          password: form.password,
          encryptionKey: form.encryptionKey === '' ? undefined : form.encryptionKey,
          encryptionRequired: form.encryptionRequired,
          pureRust: form.pureRust,
        });
      }
      setSessionId(response.sessionId);
      setResult(null);
      void refreshCryptState(response.sessionId);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const refreshCryptState = async (id: string) => {
    try {
      const res = await fetchTransport.invoke<CryptStateResponse>('crypt-state', {
        sessionId: id,
      });
      setCryptState(res.state);
    } catch {
      setCryptState(null);
    }
  };

  const handleExecute = async () => {
    if (!sessionId) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetchTransport.invoke<QueryResult>('execute', { sessionId, sql });
      setResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async () => {
    if (!sessionId) return;
    setError(null);
    setBusy(true);
    try {
      await fetchTransport.invoke<{ closed: boolean }>('close', { sessionId });
      setSessionId(null);
      setResult(null);
      setCryptState(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex h-full max-w-4xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Plamenix</h1>
        <p className="text-sm text-zinc-400">Firebird IDE — web edition, 1.0.0-beta scaffold</p>
      </header>

      {!sessionId && (
        <ProfilePicker
          profiles={profiles}
          selectedId={selectedProfileId}
          name={profileName}
          busy={busy}
          onSelect={handleSelectProfile}
          onNameChange={setProfileName}
          onSave={handleSaveProfile}
          onDelete={handleDeleteProfile}
        />
      )}

      {!sessionId ? (
        <ConnectionPanel
          form={form}
          busy={busy}
          onChange={updateField}
          onSubmit={handleConnect}
        />
      ) : (
        <QueryPanel
          sessionId={sessionId}
          sql={sql}
          busy={busy}
          cryptState={cryptState}
          onSqlChange={setSql}
          onExecute={handleExecute}
          onClose={handleClose}
        />
      )}

      {error && (
        <pre className="rounded bg-red-950/40 p-3 text-xs text-red-200 whitespace-pre-wrap">
          {error}
        </pre>
      )}

      {result && <ResultTable result={result} />}
    </main>
  );
}
