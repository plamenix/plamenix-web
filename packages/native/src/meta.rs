//! The metadata database, exposed to the Fastify server.
//!
//! `plamenix-meta` is Rust and the server is Node, so the audit log,
//! the query history, and plugin grants — everything that used to be
//! SQLite — reach it through here.
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


// ---------------------------------------------------------------------
// Query history and plugin grants.
//
// Both were `better-sqlite3` in the Fastify server and `rusqlite` in the
// desktop shell — the same schema written twice. One Rust
// implementation now, reached from Node through here.
// ---------------------------------------------------------------------

/// Records one executed statement, then trims the profile to `limit`.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "historyRecord")]
#[allow(clippy::too_many_arguments)]
pub async fn history_record(
    profile_id: String,
    sql: String,
    executed_at: i64,
    duration_ms: i64,
    status: String,
    error: Option<String>,
    rows_returned: Option<i64>,
    label: Option<String>,
    limit: Option<i64>,
) -> Result<()> {
    let store = store().await?;
    store
        .record_history(&plamenix_meta::NewHistoryEntry {
            profile_id: &profile_id,
            sql: &sql,
            executed_at,
            duration_ms,
            status: &status,
            error: error.as_deref(),
            rows_returned,
            label: label.as_deref(),
        })
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;

    if let Some(cap) = limit.filter(|n| *n > 0) {
        // A failed trim is not worth failing the write over: the
        // statement already ran and the only cost is a longer history
        // than was asked for.
        if let Err(err) = store.trim_history(&profile_id, cap).await {
            tracing::warn!(%err, profile_id, "could not trim query history");
        }
    }
    Ok(())
}

/// Most recent statements for one profile, newest first.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "historyList")]
pub async fn history_list(profile_id: String, limit: i64) -> Result<serde_json::Value> {
    let store = store().await?;
    let entries = store
        .list_history(&profile_id, limit)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(entries).map_err(|err| Error::from_reason(err.to_string()))
}

/// Removes every entry for one profile, returning how many went.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "historyClear")]
pub async fn history_clear(profile_id: String) -> Result<i64> {
    let store = store().await?;
    store
        .clear_history(&profile_id)
        .await
        .map(|n| i64::try_from(n).unwrap_or(i64::MAX))
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Sets or clears one entry's label.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "historySetLabel")]
pub async fn history_set_label(id: i64, label: Option<String>) -> Result<bool> {
    let store = store().await?;
    store
        .set_history_label(id, label.as_deref())
        .await
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Deletes one entry.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "historyDelete")]
pub async fn history_delete(id: i64) -> Result<bool> {
    let store = store().await?;
    store
        .delete_history(id)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Deletes several entries.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "historyDeleteMany")]
pub async fn history_delete_many(ids: Vec<i64>) -> Result<i64> {
    let store = store().await?;
    store
        .delete_history_many(&ids)
        .await
        .map(|n| i64::try_from(n).unwrap_or(i64::MAX))
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Records a capability grant. Re-granting is a no-op.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "grantAdd")]
pub async fn grant_add(plugin_id: String, permission: String) -> Result<()> {
    let store = store().await?;
    store
        .grant(&plugin_id, &permission)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Withdraws a grant. Revoking one never granted is a no-op.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "grantRemove")]
pub async fn grant_remove(plugin_id: String, permission: String) -> Result<()> {
    let store = store().await?;
    store
        .revoke(&plugin_id, &permission)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Capabilities granted to one plugin.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "grantList")]
pub async fn grant_list(plugin_id: String) -> Result<Vec<String>> {
    let store = store().await?;
    store
        .granted_for(&plugin_id)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Every grant, by plugin — replayed into the plugin host at boot so a
/// plugin's approved capabilities survive a restart.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "grantListAll")]
pub async fn grant_list_all() -> Result<serde_json::Value> {
    let store = store().await?;
    let all = store
        .all_grants()
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?;
    serde_json::to_value(all).map_err(|err| Error::from_reason(err.to_string()))
}

/// Drops every grant for one plugin, for uninstall.
///
/// # Errors
///
/// When the metadata database cannot be reached.
#[napi(js_name = "grantPurgePlugin")]
pub async fn grant_purge_plugin(plugin_id: String) -> Result<()> {
    let store = store().await?;
    store
        .purge_plugin(&plugin_id)
        .await
        .map_err(|err| Error::from_reason(err.to_string()))
}
