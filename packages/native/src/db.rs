//! NAPI bindings to `plamenix-db`.
//!
//! Exposes the [`DbDriver`] trait surface (connect, execute, ping, close)
//! to Node.js as `@plamenix/fbclient-node`. The binding owns a single
//! shared [`RsfbDriver`] instance whose session registry survives across
//! NAPI calls. Async work is dispatched through napi-rs's `tokio_rt`
//! integration, which runs Rust futures on a tokio runtime spawned by
//! napi-rs at module load time.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use plamenix_db::export::{
    CsvDelimiter, ExportPart, format_csv as fmt_csv, format_json as fmt_json,
    format_sql as fmt_sql, format_xml as fmt_xml,
};
use plamenix_db::{
    ColumnValue, ConnectMode, ConnectionConfig as DbConnectionConfig, CryptState, DbDriver,
    QueryResult, RsfbDriver, SessionId as DbSessionId, StatementOutcome, TxConfig, TxMode,
    accepts_row_limit, inject_row_limit, split_statements,
};
use plamenix_types::TableInfo;
use plamenix_types::{
    DatabaseAlias as DbAlias, ListAliasesResult as ListAliases, TestConnectionResult as TestResult,
};

/// Hard cap on rows surfaced per SELECT statement. Mirrors the desktop
/// edition's behaviour; the web shell may relax it later for power users.
const ROW_LIMIT: u32 = 10_000;

/// The process-wide driver. Cheap to clone; cloning shares the session
/// registry through an internal `Arc`. We construct it lazily so the
/// module does not panic on simple `import` if rsfbclient initialisation
/// fails on some exotic platform; instead the first call surfaces the
/// error.
/// The one driver this process has.
///
/// Public rather than private because `services` needs it and
/// `tests/one_driver.rs` asserts on it: a plugin's `db` imports must
/// reach the same sessions the HTTP routes opened, and two of these
/// existing is the whole reason the packages merged.
pub fn driver() -> RsfbDriver {
    static DRIVER: OnceLock<RsfbDriver> = OnceLock::new();
    DRIVER.get_or_init(RsfbDriver::new).clone()
}

/// Returns a static pong string. Smoke test that the binding loaded.
/// Connection configuration mirrored from [`plamenix_db::ConnectionConfig`].
///
/// Field names use `camelCase` on the JS side; `serde` keeps the Rust
/// names. The two representations stay in sync because `From<JsConfig>`
/// performs the rename explicitly.
#[napi(object)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u32,
    pub database: String,
    pub user: String,
    pub password: String,
    pub encryption_key: Option<String>,
    pub fbclient_path: Option<String>,
    pub charset: Option<String>,
    pub encryption_required: bool,
    pub pure_rust: Option<bool>,
    pub embedded: Option<bool>,
}

#[napi(object)]
pub struct ConnectionHandle {
    pub session_id: String,
}

#[napi(object)]
pub struct PingResult {
    pub engine_version: String,
}

#[napi]
pub async fn connect(config: ConnectionConfig) -> Result<ConnectionHandle> {
    if config.host.is_empty() || config.database.is_empty() {
        return Err(Error::from_reason("host and database are required"));
    }

    let port = u16::try_from(config.port)
        .map_err(|_| Error::from_reason(format!("port {} out of range", config.port)))?;
    let pure_rust = config.pure_rust.unwrap_or(false);
    let mode = if pure_rust {
        ConnectMode::PureRust
    } else {
        ConnectMode::Native
    };

    let db_config = DbConnectionConfig {
        host: config.host,
        port,
        database: config.database,
        user: config.user,
        password: config.password,
        encryption_key: config.encryption_key,
        fbclient_path: config.fbclient_path,
        charset: config.charset,
        encryption_required: config.encryption_required,
        embedded: config.embedded.unwrap_or(false),
    };

    let session_id = driver()
        .connect(db_config, mode)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;

    Ok(ConnectionHandle {
        session_id: session_id.0.to_string(),
    })
}

#[napi]
pub async fn execute(session_id: String, sql: String) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let result = driver()
        .execute(session, sql)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(&result).map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub async fn ping_session(session_id: String) -> Result<PingResult> {
    let session = parse_session(&session_id)?;
    let version = driver()
        .ping(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    Ok(PingResult {
        engine_version: version,
    })
}

#[napi]
pub async fn close(session_id: String) -> Result<()> {
    let session = parse_session(&session_id)?;
    driver()
        .close(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Switches a session between autocommit and manual commit.
///
/// `config` is the JSON form of `TxConfig`; omit it to keep the
/// session's current settings. Refused while a transaction is open, so
/// a mode change cannot silently commit or discard outstanding work.
#[napi(js_name = "setTransactionMode")]
pub async fn set_transaction_mode(
    session_id: String,
    mode: serde_json::Value,
    config: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let mode: TxMode =
        serde_json::from_value(mode).map_err(|err| Error::from_reason(err.to_string()))?;
    let config: TxConfig = match config {
        Some(value) => {
            serde_json::from_value(value).map_err(|err| Error::from_reason(err.to_string()))?
        }
        None => {
            driver()
                .transaction_status(session)
                .await
                .map_err(|err| Error::from_reason(err.to_string()))?
                .config
        }
    };
    let status = driver()
        .set_transaction_mode(session, mode, config)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(status).map_err(|err| Error::from_reason(err.to_string()))
}

/// Opens an explicit transaction. Manual mode opens one on the first
/// statement, so this is only for starting one deliberately.
#[napi(js_name = "beginTransaction")]
pub async fn begin_transaction(session_id: String) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let status = driver()
        .begin_transaction(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(status).map_err(|err| Error::from_reason(err.to_string()))
}

/// Commits the open transaction.
#[napi(js_name = "commitTransaction")]
pub async fn commit_transaction(session_id: String) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let status = driver()
        .commit(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(status).map_err(|err| Error::from_reason(err.to_string()))
}

/// Rolls back the open transaction, discarding every statement since it
/// opened — DDL included.
#[napi(js_name = "rollbackTransaction")]
pub async fn rollback_transaction(session_id: String) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let status = driver()
        .rollback(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(status).map_err(|err| Error::from_reason(err.to_string()))
}

/// Current transaction state. Answered from driver state without
/// touching the engine, so it is safe to poll for the age readout.
#[napi(js_name = "transactionStatus")]
pub async fn transaction_status(session_id: String) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let status = driver()
        .transaction_status(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(status).map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub async fn describe_schema(session_id: String) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let schema = driver()
        .describe_schema(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(&schema).map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub async fn database_stats(session_id: String) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let stats = driver()
        .database_stats(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(&stats).map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub async fn fetch_blob(session_id: String, blob_id: String) -> Result<String> {
    use std::fmt::Write as _;
    let session = parse_session(&session_id)?;
    let bytes = driver()
        .fetch_blob(session, blob_id)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in &bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

#[napi]
pub async fn crypt_state(session_id: String) -> Result<String> {
    let session = parse_session(&session_id)?;
    let state = driver()
        .crypt_state(session)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    Ok(match state {
        CryptState::Unencrypted => "unencrypted",
        CryptState::Encrypted => "encrypted",
        CryptState::DecryptInProgress => "decrypt_in_progress",
        CryptState::EncryptInProgress => "encrypt_in_progress",
    }
    .to_owned())
}

fn parse_session(raw: &str) -> Result<DbSessionId> {
    let uuid = raw
        .parse::<uuid::Uuid>()
        .map_err(|err| Error::from_reason(format!("invalid sessionId: {err}")))?;
    Ok(DbSessionId(uuid))
}

/// Splits `sql` into statements, applies the per-statement row cap to
/// SELECT-like queries, executes each in order, and returns one
/// [`StatementOutcome`] per parsed statement. Aborts after the first
/// failure (mirroring the Tauri command).
#[napi]
pub async fn execute_batch(session_id: String, sql: String) -> Result<serde_json::Value> {
    let session = parse_session(&session_id)?;
    let stmts = split_statements(&sql);
    if stmts.is_empty() {
        return Err(Error::from_reason(
            "No executable statements in the buffer.",
        ));
    }
    let drv = driver();
    let mut outcomes: Vec<StatementOutcome> = Vec::with_capacity(stmts.len());
    for stmt in stmts {
        let started = Instant::now();
        // See the desktop shell: ROWS is SELECT-only grammar, so an
        // EXECUTE statement must go through untouched.
        let exec_sql = if accepts_row_limit(&stmt) {
            inject_row_limit(&stmt, ROW_LIMIT)
        } else {
            stmt.clone()
        };
        match drv.execute(session, exec_sql).await {
            Ok(mut result) => {
                if let QueryResult::Rows {
                    rows, truncated, ..
                } = &mut result
                {
                    if rows.len() > ROW_LIMIT as usize {
                        rows.truncate(ROW_LIMIT as usize);
                        *truncated = true;
                    }
                }
                outcomes.push(StatementOutcome::Ok {
                    sql: stmt,
                    result,
                    duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                });
            }
            Err(err) => {
                outcomes.push(StatementOutcome::Err {
                    sql: stmt,
                    error: err.to_string(),
                    duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                });
                break;
            }
        }
    }
    serde_json::to_value(&outcomes).map_err(|err| Error::from_reason(err.to_string()))
}

/// Runs the export pipeline server-side: executes one or more SELECTs,
/// then builds a CSV / JSON / SQL / XML deliverable using the shared
/// `plamenix-db::export` formatters. Returns the full text. The
/// HTTP route on top is responsible for chunked transfer to the
/// client.
#[napi]
pub async fn export_query(
    session_id: String,
    format: String,
    csv_delimiter: String,
    // `scope_json` is a JSON-encoded `ExportScope`: either
    // `{ kind: "statement", sql, label?, table? }` or
    // `{ kind: "tables", tables: [TableInfo] }`. Passed as a string so
    // the Specta-less napi binding doesn't need an enum struct.
    scope_json: String,
    include_ddl: Option<bool>,
) -> Result<String> {
    let include_ddl = include_ddl.unwrap_or(true);
    #[derive(serde::Deserialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    enum Scope {
        Statement {
            sql: String,
            #[serde(default)]
            label: Option<String>,
            #[serde(default)]
            table: Option<TableInfo>,
        },
        Tables {
            tables: Vec<TableInfo>,
        },
    }
    let session = parse_session(&session_id)?;
    let delim: CsvDelimiter = match csv_delimiter.as_str() {
        "comma" => CsvDelimiter::Comma,
        "semicolon" => CsvDelimiter::Semicolon,
        "tab" => CsvDelimiter::Tab,
        other => return Err(Error::from_reason(format!("invalid csvDelimiter: {other}"))),
    };
    let scope: Scope = serde_json::from_str(&scope_json)
        .map_err(|e| Error::from_reason(format!("invalid scope: {e}")))?;
    let stmts: Vec<(Option<TableInfo>, Option<String>, String)> = match scope {
        Scope::Statement { sql, label, table } => vec![(table, label, sql)],
        Scope::Tables { tables } => tables
            .into_iter()
            .map(|t| {
                let ident = if t
                    .name
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                    && !t.name.is_empty()
                    && !t.name.chars().next().is_some_and(|c| c.is_ascii_digit())
                {
                    t.name.clone()
                } else {
                    format!("\"{}\"", t.name.replace('"', "\"\""))
                };
                let sql = format!("SELECT * FROM {ident}");
                let label = Some(t.name.clone());
                (Some(t), label, sql)
            })
            .collect(),
    };

    let drv = driver();
    let mut payloads: Vec<(
        Option<TableInfo>,
        Option<String>,
        Vec<plamenix_db::Column>,
        Vec<plamenix_db::Row>,
    )> = Vec::with_capacity(stmts.len());
    for (table, label, sql) in stmts {
        let result = drv
            .execute(session, sql)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
        if let QueryResult::Rows { columns, rows, .. } = result {
            payloads.push((table, label, columns, rows));
        }
    }
    let parts: Vec<ExportPart<'_>> = payloads
        .iter()
        .map(|(table, label, columns, rows)| ExportPart {
            table: table.as_ref(),
            label: label.clone(),
            columns,
            rows,
        })
        .collect();
    let out = match format.as_str() {
        "csv" => fmt_csv(&parts, delim),
        "json" => fmt_json(&parts),
        "sql" => fmt_sql(&parts, include_ddl),
        "xml" => fmt_xml(&parts),
        other => return Err(Error::from_reason(format!("invalid format: {other}"))),
    };
    Ok(out)
}

/// Tries to attach with the supplied configuration, fetches the engine
/// version, then closes the session. Always resolves with a structured
/// result (no thrown error on a clean failure); the `ok` flag tells the
/// caller whether the attempt succeeded.
#[napi]
pub async fn test_connection(config: ConnectionConfig) -> Result<serde_json::Value> {
    let port = u16::try_from(config.port)
        .map_err(|_| Error::from_reason(format!("port {} out of range", config.port)))?;
    let pure_rust = config.pure_rust.unwrap_or(false);
    let mode = if pure_rust {
        ConnectMode::PureRust
    } else {
        ConnectMode::Native
    };
    let db_config = DbConnectionConfig {
        host: config.host,
        port,
        database: config.database,
        user: config.user,
        password: config.password,
        encryption_key: config.encryption_key,
        fbclient_path: config.fbclient_path,
        charset: config.charset,
        encryption_required: config.encryption_required,
        embedded: config.embedded.unwrap_or(false),
    };
    let drv = driver();
    let started = Instant::now();
    let result = match drv.connect(db_config, mode).await {
        Ok(session) => {
            let version = match drv
                .execute(
                    session,
                    "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') FROM rdb$database"
                        .to_string(),
                )
                .await
            {
                Ok(QueryResult::Rows { rows, .. }) => rows
                    .first()
                    .and_then(|r| r.cells.first())
                    .and_then(|cell| match cell {
                        ColumnValue::Text(s) => Some(s.trim().to_string()),
                        _ => None,
                    }),
                _ => None,
            };
            let _ = drv.close(session).await;
            TestResult {
                ok: true,
                firebird_version: version,
                error: None,
                duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            }
        }
        Err(err) => TestResult {
            ok: false,
            firebird_version: None,
            error: Some(err.to_string()),
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        },
    };
    serde_json::to_value(&result).map_err(|err| Error::from_reason(err.to_string()))
}

/// Reads the host's `databases.conf` (when one is found at a known
/// install path) and returns the simple-form alias entries declared in
/// it. When no candidate file exists, returns an empty list with
/// `sourcePath = null`.
#[napi]
pub fn list_aliases() -> Result<serde_json::Value> {
    let result = candidate_databases_conf_paths()
        .into_iter()
        .find_map(|path| {
            let text = std::fs::read_to_string(&path).ok()?;
            Some(ListAliases {
                source_path: Some(path.display().to_string()),
                aliases: parse_databases_conf(&text),
            })
        })
        .unwrap_or(ListAliases {
            source_path: None,
            aliases: Vec::new(),
        });
    serde_json::to_value(&result).map_err(|err| Error::from_reason(err.to_string()))
}

fn candidate_databases_conf_paths() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    v.push("/Library/Frameworks/Firebird.framework/Resources/databases.conf".into());
    v.push("/opt/firebird/databases.conf".into());
    for major in [3u32, 4, 5] {
        v.push(format!("/etc/firebird/{major}/databases.conf").into());
    }
    v.push("C:/Program Files/Firebird/Firebird_5_0/databases.conf".into());
    v.push("C:/Program Files/Firebird/Firebird_4_0/databases.conf".into());
    v.push("C:/Program Files/Firebird/Firebird_3_0/databases.conf".into());
    v
}

fn parse_databases_conf(text: &str) -> Vec<DbAlias> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let alias = line[..eq].trim();
        let path_part = line[eq + 1..].trim();
        if alias.is_empty() || path_part.is_empty() || path_part.starts_with('{') {
            continue;
        }
        if alias.chars().any(char::is_whitespace) {
            continue;
        }
        out.push(DbAlias {
            alias: alias.to_string(),
            path: path_part.to_string(),
        });
    }
    out
}
