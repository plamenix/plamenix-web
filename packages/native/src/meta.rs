//! The metadata database, exposed to the Fastify server.
//!
//! `plamenix-meta` is Rust and the server is Node, so the audit log —
//! and, once history and grants move, everything else that used to be
//! SQLite — reaches it through here.
//!
//! One store for the process, opened once. Firebird's embedded engine
//! takes the file exclusively, so opening per call would not merely be
//! slow; the second open would fail.

use std::sync::OnceLock;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use plamenix_meta::{AuditEntry, MetaStore};
use tokio::sync::OnceCell;

/// Where the metadata database lives, set once at boot.
static META_PATH: OnceLock<String> = OnceLock::new();
/// The `fbclient` install embedded mode needs.
static META_FBCLIENT: OnceLock<Option<String>> = OnceLock::new();

async fn store() -> Result<&'static MetaStore> {
    static STORE: OnceCell<MetaStore> = OnceCell::const_new();
    STORE
        .get_or_try_init(|| async {
            let path = META_PATH
                .get()
                .ok_or_else(|| Error::from_reason("metadata store used before initMeta"))?;
            let fbclient = META_FBCLIENT.get().cloned().flatten();
            MetaStore::open(path, fbclient)
                .await
                .map_err(|err| Error::from_reason(err.to_string()))
        })
        .await
}

/// Points the metadata store at a file. Call once, before anything else
/// here.
///
/// Separate from opening so a failure to open surfaces on the first
/// real use with the reason attached, rather than at import time where
/// there is no request to attribute it to.
#[napi(js_name = "initMeta")]
pub fn init_meta(path: String, fbclient_path: Option<String>) {
    let _ = META_PATH.set(path);
    let _ = META_FBCLIENT.set(fbclient_path);
}

/// Appends one entry to the audit log.
///
/// # Errors
///
/// When the metadata database cannot be reached. Callers on a request
/// path should log and continue: an unwritable audit log is worth
/// knowing about and is not worth refusing to serve over, or a full
/// disk becomes a denial of service.
#[napi(js_name = "auditRecord")]
pub async fn audit_record(
    action: String,
    outcome: String,
    actor: Option<String>,
    remote_addr: Option<String>,
    target: Option<String>,
    detail: Option<String>,
) -> Result<()> {
    let store = store().await?;
    store
        .record(&AuditEntry {
            actor,
            remote_addr,
            action,
            target,
            outcome,
            detail,
        })
        .await
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Reads recent audit entries, newest first.
///
/// A log nobody can read is a log nobody keeps. This is what makes the
/// table answerable without opening the file in another tool — though
/// it is a Firebird database, so opening it in Plamenix works too.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "auditRecent")]
pub async fn audit_recent(limit: Option<u32>) -> Result<serde_json::Value> {
    let store = store().await?;
    let limit = limit.unwrap_or(100).min(1000);
    // `DETAIL` is included deliberately. It carries the part a reader
    // actually needs — which domain attempted a rebind, what status a
    // write returned — and omitting it made the log answer "something
    // was refused" without saying what.
    let sql = format!(
        "SELECT FIRST {limit} OCCURRED_AT, ACTOR, REMOTE_ADDR, ACTION, TARGET, OUTCOME, DETAIL \
         FROM AUDIT_LOG ORDER BY OCCURRED_AT DESC"
    );
    let result = plamenix_db::DbDriver::execute(store.driver(), store.session(), sql)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(result).map_err(|err| Error::from_reason(err.to_string()))
}
