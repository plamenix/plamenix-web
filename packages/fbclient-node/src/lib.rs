#![deny(clippy::all)]
//! NAPI bindings to `plamenix-db`.
//!
//! Exposes the [`DbDriver`] trait surface (connect, execute, ping, close)
//! to Node.js as `@plamenix/fbclient-node`. The binding owns a single
//! shared [`RsfbDriver`] instance whose session registry survives across
//! NAPI calls. Async work is dispatched through napi-rs's `tokio_rt`
//! integration, which runs Rust futures on a tokio runtime spawned by
//! napi-rs at module load time.

use std::sync::OnceLock;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use plamenix_db::{
    ConnectMode, ConnectionConfig as DbConnectionConfig, DbDriver, RsfbDriver,
    SessionId as DbSessionId,
};

/// The process-wide driver. Cheap to clone; cloning shares the session
/// registry through an internal `Arc`. We construct it lazily so the
/// module does not panic on simple `import` if rsfbclient initialisation
/// fails on some exotic platform; instead the first call surfaces the
/// error.
fn driver() -> RsfbDriver {
    static DRIVER: OnceLock<RsfbDriver> = OnceLock::new();
    DRIVER.get_or_init(RsfbDriver::new).clone()
}

/// Returns a static pong string. Smoke test that the binding loaded.
#[napi]
#[must_use]
pub const fn ping() -> &'static str {
    "pong from @plamenix/fbclient-node"
}

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
    pub encryption_required: bool,
    pub pure_rust: Option<bool>,
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
        encryption_required: config.encryption_required,
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

fn parse_session(raw: &str) -> Result<DbSessionId> {
    let uuid = raw
        .parse::<uuid::Uuid>()
        .map_err(|err| Error::from_reason(format!("invalid sessionId: {err}")))?;
    Ok(DbSessionId(uuid))
}
