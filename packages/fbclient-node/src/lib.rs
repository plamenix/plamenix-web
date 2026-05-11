#![deny(clippy::all)]

use napi_derive::napi;

/// Returns a static pong string. Smoke test that the binding loaded.
#[napi]
pub fn ping() -> &'static str {
    "pong from @plamenix/fbclient-node"
}

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
}

#[napi(object)]
pub struct ConnectionHandle {
    pub session_id: String,
}

/// Stub: real attach lands when `plamenix-db` crate exists. For now this
/// validates the binding boundary and returns a synthesised session id.
#[napi]
pub async fn connect(config: ConnectionConfig) -> napi::Result<ConnectionHandle> {
    if config.host.is_empty() || config.database.is_empty() {
        return Err(napi::Error::from_reason("host and database are required"));
    }
    Ok(ConnectionHandle {
        session_id: format!("stub-{}-{}", config.host, config.port),
    })
}
