// Hand-maintained declarations. `napi build` overwrites this with
// generated types after the first build; this stub keeps TypeScript
// callers compiling before the native binary exists.

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encryptionKey?: string;
  fbclientPath?: string;
  encryptionRequired: boolean;
  pureRust?: boolean;
}

export interface ConnectionHandle {
  sessionId: string;
}

export interface PingResult {
  engineVersion: string;
}

export interface ColumnDescription {
  name: string;
}

export type ColumnValue =
  | { type: 'null' }
  | { type: 'text'; value: string }
  | { type: 'integer'; value: number }
  | { type: 'float'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'blob'; value: string };

export interface Row {
  cells: ColumnValue[];
}

export type QueryResult =
  | { Rows: { columns: ColumnDescription[]; rows: Row[] } }
  | { Affected: { rows: number } };

export function ping(): string;
export function connect(config: ConnectionConfig): Promise<ConnectionHandle>;
export function execute(sessionId: string, sql: string): Promise<QueryResult>;
export function pingSession(sessionId: string): Promise<PingResult>;
export function close(sessionId: string): Promise<void>;
