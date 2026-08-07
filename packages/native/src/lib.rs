//! The web edition's native module: Firebird driver and plugin host.
//!
//! These were two separate npm packages compiled to two separate
//! `.node` binaries, and that was a correctness problem rather than an
//! organisational one. Each linked its own copy of the Rust code it
//! needed, so each got its own `OnceLock<RsfbDriver>` — Rust statics do
//! not cross a dynamic library boundary. A session opened through
//! `connect()` lived in the driver inside one binary, and a plugin
//! calling `db.query-read` looked it up in the *other* one and found
//! nothing.
//!
//! Nothing about that was visible in either package on its own. Both
//! had passing tests. It only appears when a plugin tries to read the
//! database the user is looking at, which nothing could do until the
//! host interfaces were implemented.
//!
//! One module, one driver, and [`db::driver`] is the single place it
//! comes from.
//!
//! ## Layout
//!
//! * [`db`] — the driver surface: connect, execute, transactions,
//!   schema, export.
//! * [`plugins`] — the plugin host: load, activate, events,
//!   interceptors, grants.
//! * [`services`] — what plugins may reach, implemented over the
//!   driver in `db`. This is the join the split made impossible.

pub mod db;
pub mod plugins;
pub mod services;

use napi_derive::napi;

/// Returns a static pong string. Smoke test that the binding loaded.
#[napi]
#[must_use]
pub const fn ping() -> &'static str {
    "pong from @plamenix/native"
}

/// Initialises the global `tracing` subscriber for the Node process.
///
/// Idempotent: subsequent calls return `"already_initialised"`.
///
/// One function rather than the two the split packages each exported.
/// The subscriber is process-global, so a second initialiser was never
/// doing anything except making it unclear which one mattered.
/// # Errors
///
/// When the tracing subscriber could not be installed.
#[napi(js_name = "initTracing")]
pub fn init_tracing() -> napi::Result<String> {
    static TRACING_GUARD: std::sync::OnceLock<
        std::sync::Mutex<Option<plamenix_tracing::TracingGuard>>,
    > = std::sync::OnceLock::new();

    let slot = TRACING_GUARD.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard_slot = slot
        .lock()
        .map_err(|_| napi::Error::from_reason("tracing lock poisoned"))?;
    if guard_slot.is_some() {
        return Ok("already_initialised".to_owned());
    }
    let (guard, outcome) =
        plamenix_tracing::init().map_err(|err| napi::Error::from_reason(err.to_string()))?;
    let status = match &outcome {
        plamenix_tracing::InitOutcome::FmtOnly => "fmt_only".to_owned(),
        plamenix_tracing::InitOutcome::OtlpEnabled { endpoint, .. } => format!("otlp:{endpoint}"),
        _ => "ok".to_owned(),
    };
    *guard_slot = Some(guard);
    tracing::info!(status = %status, "native module tracing initialised");
    Ok(status)
}
