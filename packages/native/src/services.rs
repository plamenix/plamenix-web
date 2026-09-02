//! What the web edition provides to plugins.
//!
//! The join the two-package split made impossible. `db_query_read`
//! below reaches [`crate::db::driver`] — the same driver the HTTP
//! routes use, in the same binary, holding the same sessions. When
//! these were separate `.node` files this function could not have been
//! written correctly: it would have looked up a session in a driver
//! that had never seen it.
//!
//! Thin, like the desktop's. No capability decision is made here; the
//! host's `gate` made it, and its `check_net` decided the URL, before
//! any of this runs.
//!
//! ## What this edition does not have
//!
//! `clipboard`, `notify`, and `keyring` are left at their trait
//! defaults, which report `Unsupported`. A server has no clipboard and
//! no notification centre, and an OS keyring on a shared host would be
//! one keychain for every user of the deployment — the wrong shape
//! rather than a missing feature. The world check already refuses
//! `plugin-integrated-desktop` on a web target, so a plugin needing the
//! keyring cannot install here in the first place.

use std::collections::HashSet;

use plamenix_db::DbDriver;
use plamenix_plugin_host::{
    CallCtx, HostCell, HostColumn, HostHttpRequest, HostHttpResponse, HostQueryResult, HostRow,
    HostSchema, HostServices, HostStatementOutcome, HostTable, ServiceError,
};
use plamenix_types::SessionId;

/// The web edition's implementation.
pub struct WebHostServices;

impl WebHostServices {
    /// The session the host says this call is for.
    fn session(ctx: &CallCtx) -> Result<SessionId, ServiceError> {
        let raw = ctx.session_id.as_ref().ok_or(ServiceError::NoSession)?;
        raw.parse::<uuid::Uuid>()
            .map(SessionId)
            .map_err(|_| ServiceError::NoSession)
    }
}

/// Converts a driver cell, keeping `Decimal` exact.
///
/// Firebird stores NUMERIC as a scaled integer and this repo vendors a
/// patched `rsfbclient-rust` to stop it being coerced to a double.
/// Mapping it to `Float` here would undo that for every plugin on this
/// edition, quietly.
fn to_host_cell(cell: plamenix_db::ColumnValue) -> HostCell {
    use plamenix_db::ColumnValue;
    match cell {
        ColumnValue::Null => HostCell::Null,
        ColumnValue::Text(text) => HostCell::Text(text),
        ColumnValue::Integer(value) => HostCell::Integer(value),
        ColumnValue::Decimal(text) => HostCell::Decimal(text),
        ColumnValue::Float(value) => HostCell::Float(value),
        ColumnValue::Bool(value) => HostCell::Bool(value),
        ColumnValue::Blob(blob) => HostCell::Blob {
            id: blob.id,
            size: u64::try_from(blob.size_bytes).unwrap_or_default(),
            peek_hex: blob.peek_hex,
        },
    }
}

fn to_host_result(result: plamenix_db::QueryResult, row_cap: usize) -> HostStatementOutcome {
    match result {
        plamenix_db::QueryResult::Affected { rows } => HostStatementOutcome::Affected(rows),
        plamenix_db::QueryResult::Rows {
            columns,
            rows,
            truncated,
        } => {
            let capped = rows.len() > row_cap;
            HostStatementOutcome::Rows(HostQueryResult {
                columns: columns
                    .into_iter()
                    .map(|column| HostColumn {
                        // The driver carries a name and nothing else.
                        // `None` beats inventing a type a plugin would
                        // branch on.
                        name: column.name,
                        sql_type: None,
                        nullable: None,
                    })
                    .collect(),
                rows: rows
                    .into_iter()
                    .take(row_cap)
                    .map(|row| HostRow {
                        cells: row.cells.into_iter().map(to_host_cell).collect(),
                    })
                    .collect(),
                truncated: truncated || capped,
            })
        }
    }
}

#[async_trait::async_trait]
impl HostServices for WebHostServices {
    fn granted_for(&self, plugin_id: &str) -> HashSet<String> {
        crate::plugins::granted_for(plugin_id)
    }

    async fn db_query_read(
        &self,
        ctx: &CallCtx,
        sql: &str,
        row_cap: u32,
    ) -> Result<HostQueryResult, ServiceError> {
        let session = Self::session(ctx)?;
        let result = crate::db::driver()
            .execute(session, sql.to_owned())
            .await
            .map_err(|err| ServiceError::Backend(err.to_string()))?;

        // A statement returning no rows is not a read. Passing it off as
        // an empty result would let a plugin holding only read access
        // run an UPDATE and see nothing amiss.
        match to_host_result(result, row_cap as usize) {
            HostStatementOutcome::Rows(rows) => Ok(rows),
            HostStatementOutcome::Affected(_) => Err(ServiceError::Backend(
                "query-read is for statements that return rows; use db-write.execute".to_owned(),
            )),
        }
    }

    async fn db_execute(
        &self,
        ctx: &CallCtx,
        sql: &str,
    ) -> Result<HostStatementOutcome, ServiceError> {
        let session = Self::session(ctx)?;
        let result = crate::db::driver()
            .execute(session, sql.to_owned())
            .await
            .map_err(|err| ServiceError::Backend(err.to_string()))?;
        Ok(to_host_result(result, usize::MAX))
    }

    async fn db_describe_schema(&self, ctx: &CallCtx) -> Result<HostSchema, ServiceError> {
        let session = Self::session(ctx)?;
        let schema = crate::db::driver()
            .describe_schema(session)
            .await
            .map_err(|err| ServiceError::Backend(err.to_string()))?;
        Ok(HostSchema {
            tables: schema
                .tables
                .into_iter()
                .map(|table| HostTable {
                    name: table.name,
                    kind: "table".to_owned(),
                })
                .collect(),
        })
    }

    async fn db_tx_begin(&self, ctx: &CallCtx) -> Result<(), ServiceError> {
        let session = Self::session(ctx)?;
        crate::db::driver()
            .begin_transaction(session)
            .await
            .map(|_| ())
            .map_err(|err| ServiceError::Backend(err.to_string()))
    }

    async fn db_tx_commit(&self, ctx: &CallCtx) -> Result<(), ServiceError> {
        let session = Self::session(ctx)?;
        crate::db::driver()
            .commit(session)
            .await
            .map(|_| ())
            .map_err(|err| ServiceError::Backend(err.to_string()))
    }

    async fn db_tx_rollback(&self, ctx: &CallCtx) -> Result<(), ServiceError> {
        let session = Self::session(ctx)?;
        crate::db::driver()
            .rollback(session)
            .await
            .map(|_| ())
            .map_err(|err| ServiceError::Backend(err.to_string()))
    }

    async fn net_fetch(
        &self,
        _ctx: &CallCtx,
        _request: HostHttpRequest,
    ) -> Result<HostHttpResponse, ServiceError> {
        // Deliberately not implemented yet rather than reached for.
        //
        // The server has no HTTP client today, and adding one to a
        // process that accepts requests means deciding an egress policy
        // — private ranges, link-local metadata endpoints, the proxy the
        // deployment sits behind. Those are deployment questions, and
        // answering them badly here turns the server into an SSRF pivot
        // for anything a plugin can be talked into fetching.
        //
        // Refusing is honest. The host's allow-list already ran, so
        // reaching this means the plugin was permitted and the edition
        // still cannot serve it.
        Err(ServiceError::Unsupported("net"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Matches `plamenix/dev/firebird5/docker-compose.yml`.
    fn dev_config() -> plamenix_db::ConnectionConfig {
        plamenix_db::ConnectionConfig {
            host: "127.0.0.1".to_owned(),
            port: 3050,
            database: "/var/lib/firebird/data/test.fdb".to_owned(),
            user: "SYSDBA".to_owned(),
            password: "masterkey".to_owned(),
            charset: Some("UTF8".to_owned()),
            encryption_key: None,
            fbclient_path: None,
            encryption_required: false,
            embedded: false,
        }
    }

    fn container_is_up() -> bool {
        std::net::TcpStream::connect_timeout(
            &"127.0.0.1:3050".parse().expect("addr"),
            std::time::Duration::from_millis(500),
        )
        .is_ok()
    }

    /// The property this whole package merge exists for.
    ///
    /// `@plamenix/fbclient-node` and `@plamenix/plugin-host-node`
    /// compiled to two `.node` binaries, each statically linking its own
    /// copy of the driver, so each had its own `OnceLock<RsfbDriver>` —
    /// Rust statics do not cross a dynamic library boundary. A session
    /// opened by the HTTP routes lived in one and a plugin's
    /// `db.query-read` looked in the other and found nothing.
    ///
    /// Both packages passed their own tests throughout. The failure only
    /// appears where the two meet, which is here.
    ///
    /// Skipped without the dev container, and it says so rather than
    /// passing quietly — a skip that looks like a pass is how this kind
    /// of thing goes unnoticed in the first place.
    #[tokio::test]
    async fn a_session_opened_by_the_driver_is_visible_to_a_plugin() {
        if !container_is_up() {
            println!("SKIPPED: firebird5 dev container is not listening on 3050");
            return;
        }

        // Through the module's own accessor, not a driver this test
        // built. A test that made its own would prove nothing, because
        // two of them existing was the bug.
        let driver = crate::db::driver();
        let session = driver
            .connect(dev_config(), plamenix_db::ConnectMode::PureRust)
            .await
            .expect("connect to the dev container");

        // Now ask as a plugin does. `WebHostServices` reaches for the
        // driver itself; a different one would not know this session.
        let ctx = CallCtx {
            plugin_id: "dev.plamenix.test".to_owned(),
            session_id: Some(session.0.to_string()),
        };
        let result = WebHostServices
            .db_query_read(&ctx, "SELECT 1 AS ONE FROM RDB$DATABASE", 10)
            .await
            .expect("the plugin surface must see the session the driver opened");

        assert_eq!(result.rows.len(), 1);
        let _ = driver.close(session).await;
    }

    #[tokio::test]
    async fn a_session_the_driver_never_opened_is_not_found() {
        // The control. Without it the test above would pass against a
        // service layer that answered anything at all.
        let ctx = CallCtx {
            plugin_id: "dev.plamenix.test".to_owned(),
            session_id: Some("11111111-2222-3333-4444-555555555555".to_owned()),
        };
        assert!(
            WebHostServices
                .db_query_read(&ctx, "SELECT 1 FROM RDB$DATABASE", 10)
                .await
                .is_err(),
            "an unknown session must not resolve",
        );
    }

    #[test]
    fn a_decimal_from_the_driver_stays_decimal() {
        // Same guard as the desktop's. Both editions convert cells, so
        // both can lose this independently.
        let cell = to_host_cell(plamenix_db::ColumnValue::Decimal(
            "12345678901234567.89".to_owned(),
        ));
        assert_eq!(cell, HostCell::Decimal("12345678901234567.89".to_owned()));
    }

    #[test]
    fn a_read_beyond_the_cap_is_truncated_and_says_so() {
        let rows = (0..50)
            .map(|index| plamenix_db::Row {
                cells: vec![plamenix_db::ColumnValue::Integer(index)],
            })
            .collect();
        let result = plamenix_db::QueryResult::Rows {
            columns: vec![plamenix_db::Column {
                name: "N".to_owned(),
            }],
            rows,
            truncated: false,
        };

        match to_host_result(result, 10) {
            HostStatementOutcome::Rows(rows) => {
                assert_eq!(rows.rows.len(), 10);
                assert!(rows.truncated, "a capped result must not look complete");
            }
            other => panic!("expected rows, got {other:?}"),
        }
    }
}
