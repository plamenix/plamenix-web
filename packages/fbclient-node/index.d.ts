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
}

export interface ConnectionHandle {
  sessionId: string;
}

export function ping(): string;
export function connect(config: ConnectionConfig): Promise<ConnectionHandle>;
