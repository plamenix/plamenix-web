//! NAPI bindings to `plamenix-plugin-host`.
//!
//! Exposes plugin lifecycle (load → activate → deactivate) to the
//! Plamenix web edition's Fastify server. The binding owns a single
//! shared [`PluginHost`] (the wasmtime engine) plus a process-wide
//! registry of currently active plugins. Async work is dispatched via
//! napi-rs's `tokio_rt` integration, which spawns its own tokio
//! runtime at module load.
//!
//! Mirrors the desktop edition's `plamenix-desktop/src-tauri/src/plugins.rs`
//! responsibilities, ported to a multi-tenant server context. Grants
//! and storage scoping (Sections I1.5 + I1.6) layer on top via the
//! Fastify route handlers; this crate stays focused on the runtime
//! lifecycle.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use plamenix_plugin_host::{
    ActivationOutcome, DispatchOutcome, EpochTicker, EventBus, ExtensionPoint, FailureKind,
    HostState, InstanceRegistry, InterceptorRegistration, InterceptorRegistry, LogSink, Permission,
    PluginError, PluginHost, SessionSlot, StagedPlugin, Supervisor, activate_into_registry,
    dispatch_event_supervised, load,
};
use semver::Version;

/// Host version surfaced to plugins via the `host.host-version` import.
/// Mirrored from the workspace `1.0.0-beta` line; bump in lockstep when
/// the host version moves.
const HOST_VERSION: &str = "1.0.0-beta";

/// Edition string returned to plugins via the `host.edition` import.
const EDITION: &str = "web";

/// Returns the process-wide plugin host. Constructed lazily on first
/// call; cloned cheaply on subsequent ones.
fn host() -> Result<&'static PluginHost> {
    static HOST: OnceLock<PluginHost> = OnceLock::new();
    if let Some(existing) = HOST.get() {
        return Ok(existing);
    }
    let built = PluginHost::new().map_err(plugin_err_to_napi)?;
    Ok(HOST.get_or_init(|| built))
}

/// Process-wide registry of active plugin entries, keyed by plugin id.
/// Live wasmtime instances, keyed by plugin id.
///
/// Separate from the staging registry above, which holds bundles and
/// metadata. Activation used to drop its `Store` as soon as
/// `activate()` returned, so no plugin code could ever be called
/// again — the per-session context plumbing had nothing to run
/// against. Instances live here for the process lifetime instead.
/// Topic subscriptions declared by plugin manifests.
fn bus() -> &'static EventBus {
    static BUS: OnceLock<EventBus> = OnceLock::new();
    BUS.get_or_init(EventBus::new)
}

/// Crash budget and restart policy per plugin.
fn supervisor() -> &'static Supervisor {
    static SUPERVISOR: OnceLock<Supervisor> = OnceLock::new();
    SUPERVISOR.get_or_init(Supervisor::new)
}

fn instances() -> &'static InstanceRegistry {
    static INSTANCES: OnceLock<InstanceRegistry> = OnceLock::new();
    INSTANCES.get_or_init(InstanceRegistry::new)
}

/// Root for per-plugin data directories.
///
/// `PLUGIN_DATA_ROOT` is what the server already allocates per plugin
/// (see its `env.ts`); reading the same variable here keeps the host
/// and the server pointing at one directory rather than two.
fn plugin_data_dir(plugin_id: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(
        std::env::var("PLUGIN_DATA_ROOT").unwrap_or_else(|_| "./plugin-data".to_owned()),
    )
    .join(plugin_id)
    .join("data")
}

/// Capability strings the user has approved for one plugin.
///
/// Read by [`crate::services::WebHostServices::granted_for`] once per
/// plugin call. The metadata database is the authority and this
/// in-memory set is what it replays into at boot and on grant.
pub(crate) fn granted_for(plugin_id: &str) -> std::collections::HashSet<String> {
    registry()
        .lock()
        .ok()
        .and_then(|reg| reg.get(plugin_id).map(|entry| entry.granted.clone()))
        .unwrap_or_default()
}

/// Which plugins asked to be consulted before an operation commits.
fn interceptors() -> &'static InterceptorRegistry {
    static INTERCEPTORS: OnceLock<InterceptorRegistry> = OnceLock::new();
    INTERCEPTORS.get_or_init(InterceptorRegistry::new)
}

/// Starts wasmtime's epoch ticker once, on first use.
///
/// Every plugin store is created with an epoch deadline, but a deadline
/// is measured against a clock that something has to advance. Without
/// this the deadlines were inert and a plugin that looped ran until the
/// process died.
///
/// Called from async entry points only: `EpochTicker::spawn` needs a
/// Tokio runtime, and napi-rs provides one to async exports.
fn ensure_epoch_ticker(host: &PluginHost) {
    static TICKER: OnceLock<EpochTicker> = OnceLock::new();
    let mut started = false;
    let _ = TICKER.get_or_init(|| {
        started = true;
        EpochTicker::spawn(host.engine().clone())
    });
    if started {
        tracing::info!("epoch ticker started; plugin CPU deadlines are live");
    }
}

fn registry() -> &'static Mutex<HashMap<String, ActivePluginEntry>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, ActivePluginEntry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One entry per loaded plugin. Activation populates the log sink + the
/// activation outcome; grants accumulate over the plugin's lifetime.
///
/// `staged` is wrapped in [`Arc`] because [`StagedPlugin`] is not
/// [`Clone`] (it owns a `wasmtime::Component` that doesn't expose a
/// safe clone); the registry shares the staged bundle across activate
/// calls without copying.
///
/// `session_slot` is the multi-tenant context channel — see
/// [`SessionSlot`]. The napi binding and the [`HostState`] inside the
/// wasmtime [`wasmtime::Store`] both hold `Arc` clones of the same
/// slot; the binding mutates it via `setCallContext` before each
/// plugin invocation, and host imports read from it during the call.
struct ActivePluginEntry {
    staged: Arc<StagedPlugin>,
    log_sink: LogSink,
    session_slot: SessionSlot,
    activation: Option<ActivationOutcome>,
    granted: HashSet<String>,
}

/// Returns a static pong string. Smoke test that the binding loaded.
/// Loads a plugin bundle from disk. Validates the manifest, compiles
/// the WASM component, registers the plugin in the process-wide
/// registry, and returns a snapshot of staged-plugin metadata.
#[napi]
pub async fn load_plugin(bundle_path: String) -> Result<StagedPluginInfo> {
    let host_ref = host()?;
    let host_version =
        Version::parse(HOST_VERSION).map_err(|err| Error::from_reason(err.to_string()))?;
    let path = PathBuf::from(&bundle_path);

    let host_clone = host_ref.clone();
    let staged = tokio::task::spawn_blocking(move || load(&host_clone, &host_version, &path))
        .await
        .map_err(|err| Error::from_reason(format!("plugin load task panicked: {err}")))?
        .map_err(plugin_err_to_napi)?;

    let info = StagedPluginInfo::from(&staged);

    let log_sink: LogSink = Arc::new(Mutex::new(Vec::new()));
    let session_slot: SessionSlot = Arc::new(Mutex::new(None));
    let entry = ActivePluginEntry {
        staged: Arc::new(staged),
        log_sink,
        session_slot,
        activation: None,
        granted: HashSet::new(),
    };

    let mut reg = registry().lock().expect("registry mutex");
    if reg.contains_key(&info.id) {
        return Err(Error::from_reason(format!(
            "plugin `{id}` already loaded; deactivate first to reload",
            id = info.id
        )));
    }
    reg.insert(info.id.clone(), entry);

    Ok(info)
}

/// Activates a previously loaded plugin. Spawns the wasmtime Store,
/// links the host imports, runs the plugin's `activate()` export,
/// captures contributed sidebar panels + emitted logs.
#[napi]
pub async fn activate_plugin(plugin_id: String) -> Result<ActivatedPluginInfo> {
    let (staged_arc, log_sink_clone, session_slot_clone) = {
        let reg = registry().lock().expect("registry mutex");
        let entry = reg.get(&plugin_id).ok_or_else(|| {
            Error::from_reason(format!(
                "plugin `{plugin_id}` not loaded; call loadPlugin first"
            ))
        })?;
        (
            Arc::clone(&entry.staged),
            Arc::clone(&entry.log_sink),
            Arc::clone(&entry.session_slot),
        )
    };

    let host_ref = host()?.clone();
    ensure_epoch_ticker(&host_ref);
    // Everything a plugin may reach. Until this existed the web
    // edition handed the host `NoServices` and every import beyond
    // logging refused.
    let data_dir = plugin_data_dir(&staged_arc.manifest.plugin.id);
    if let Err(err) = std::fs::create_dir_all(&data_dir) {
        tracing::warn!(
            plugin = %staged_arc.manifest.plugin.id,
            ?err,
            "could not create the plugin's data directory; its fs and settings imports will fail",
        );
    }
    let state = HostState::new(&staged_arc.manifest.plugin.id, HOST_VERSION)
        .with_edition(EDITION)
        .with_log_sink(Arc::clone(&log_sink_clone))
        .with_session_slot(Arc::clone(&session_slot_clone))
        .with_services(Arc::new(crate::services::WebHostServices))
        .with_world(staged_arc.manifest.plugin.world_tier)
        .with_declared_permissions(staged_arc.manifest.permissions.clone())
        .with_data_dir(&data_dir);

    // Registers the live store rather than dropping it. A failed
    // activation is not registered — the activator drops that store
    // itself — so the registry only holds instances that can be called.
    supervisor()
        .register(
            &staged_arc.manifest.plugin.id,
            staged_arc.manifest.plugin.restart_policy,
        )
        .map_err(plugin_err_to_napi)?;

    let outcome = activate_into_registry(&host_ref, state, &staged_arc, instances())
        .await
        .map_err(plugin_err_to_napi)?;

    // Recorded only on success: a plugin that failed to activate must
    // not sit in the bus collecting events it has no instance to
    // receive.
    if matches!(outcome, ActivationOutcome::Ok) {
        let plugin_id = &staged_arc.manifest.plugin.id;
        supervisor()
            .mark_active(plugin_id, std::time::Instant::now())
            .map_err(plugin_err_to_napi)?;
        for pattern in &staged_arc.manifest.contributions.event_subscriptions {
            if let Err(err) = bus().subscribe(plugin_id, pattern) {
                tracing::warn!(
                    plugin = %plugin_id,
                    pattern,
                    %err,
                    "ignoring an event subscription the bus rejected",
                );
            }
        }
        // Interceptors are the control surface, so only a plugin that
        // actually activated may join a chain — being consulted about
        // an operation it cannot answer for is worse than not being
        // consulted at all.
        for entry in &staged_arc.manifest.contributions.interceptors {
            if let Err(err) = interceptors().register(InterceptorRegistration {
                plugin_id: plugin_id.clone(),
                point: entry.point,
                priority: entry.priority,
                purpose: entry.purpose.clone(),
            }) {
                tracing::warn!(
                    plugin = %plugin_id,
                    point = entry.point.as_str(),
                    %err,
                    "ignoring an interceptor the registry rejected",
                );
            }
        }
    }

    let mut reg = registry().lock().expect("registry mutex");
    let entry = reg.get_mut(&plugin_id).ok_or_else(|| {
        Error::from_reason(format!(
            "plugin `{plugin_id}` disappeared from registry during activation"
        ))
    })?;
    entry.activation = Some(outcome);

    Ok(activated_view(entry))
}

/// Emits `topic` to every subscribed plugin, reporting failures to the
/// supervisor.
///
/// The single entry point for host-originated events on this edition,
/// mirroring the desktop shell's. Returns one entry per subscriber so
/// the caller can see who was reached and what the supervisor made of
/// any failure — a plugin trapping on an event must not fail the
/// request that produced it.
#[napi(js_name = "emitEvent")]
pub async fn emit_event(topic: String, payload: String) -> Result<serde_json::Value> {
    let deliveries =
        dispatch_event_supervised(bus(), instances(), supervisor(), &topic, &payload).await;
    let view: Vec<serde_json::Value> = deliveries
        .into_iter()
        .map(|d| {
            let (status, reason, detail) = match &d.outcome {
                DispatchOutcome::Delivered => ("delivered", None, None),
                DispatchOutcome::NotInstantiated => ("notInstantiated", None, None),
                DispatchOutcome::Closed => ("closed", None, None),
                // `reason` separates a plugin that was too slow from one
                // that trapped. `detail` is the whole error chain, which
                // is where the wasm backtrace lives.
                DispatchOutcome::Failed(failure) => (
                    "failed",
                    Some(match failure.kind {
                        FailureKind::Deadline => "deadline",
                        FailureKind::Trapped => "trapped",
                        FailureKind::Host => "host",
                    }),
                    Some(failure.message.clone()),
                ),
            };
            serde_json::json!({
                "pluginId": d.plugin_id,
                "status": status,
                "reason": reason,
                "detail": detail,
                // Present only when the plugin failed; the supervisor
                // does not weigh in on a successful delivery.
                "disabled": matches!(
                    d.decision,
                    Some(plamenix_plugin_host::RestartDecision::Disable { .. })
                ),
            })
        })
        .collect();
    serde_json::to_value(view).map_err(|err| Error::from_reason(err.to_string()))
}

/// Which plugins are wired into which interceptor chain, in resolved
/// order.
///
/// The server reads this once after boot so it only pays a round trip
/// on chains a plugin actually registered for.
#[napi(js_name = "listInterceptors")]
pub fn list_interceptors() -> Result<serde_json::Value> {
    let registrations = interceptors()
        .all()
        .map_err(|err| Error::from_reason(err.to_string()))?;
    let view: Vec<serde_json::Value> = registrations
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "pluginId": entry.plugin_id,
                "extensionPoint": entry.point.as_str(),
                "priority": entry.priority,
                "purpose": entry.purpose,
            })
        })
        .collect();
    serde_json::to_value(view).map_err(|err| Error::from_reason(err.to_string()))
}

/// Runs the plugin segment of an interceptor chain and returns its
/// verdict.
///
/// An interceptor that traps, overruns its deadline, or cancels without
/// a reason is skipped and the operation proceeds. That is deliberate:
/// a third-party plugin crashing must not be able to stop someone
/// running a query against their own database. Skipped plugins are
/// reported rather than swallowed so a broken one can be attributed.
#[napi(js_name = "runInterceptors")]
pub async fn run_interceptors(
    extension_point: String,
    context_json: String,
) -> Result<serde_json::Value> {
    let point = ExtensionPoint::parse(&extension_point)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    let registrations = interceptors()
        .for_point(point)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    let (verdict, steps) =
        plamenix_plugin_host::run_chain(instances(), &registrations, point, &context_json).await;

    let skipped: Vec<serde_json::Value> = steps
        .into_iter()
        .filter_map(|step| {
            step.failure.map(|failure| {
                serde_json::json!({
                    "pluginId": step.plugin_id,
                    "reason": format!("{}: {}", failure.kind, failure.message),
                })
            })
        })
        .collect();

    serde_json::to_value(serde_json::json!({ "verdict": verdict, "skipped": skipped }))
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Drops the plugin's registry entry, releasing the wasmtime Store and
/// staged bundle. Subsequent `activatePlugin` calls require a fresh
/// `loadPlugin` to re-stage.
#[napi]
pub async fn deactivate_plugin(plugin_id: String) -> Result<()> {
    // Drop subscriptions before the instance: an event dispatched
    // between the two would find a plugin the bus still lists and the
    // registry no longer holds.
    bus().unsubscribe_by_plugin(&plugin_id);
    // Same ordering argument for the control surface, and more urgent:
    // a chain that still lists a plugin whose instance is gone would
    // consult something that cannot answer.
    if let Err(err) = interceptors().unregister_by_plugin(&plugin_id) {
        tracing::warn!(plugin = %plugin_id, %err, "interceptor registry would not release the plugin");
    }

    // Drop the live instance first: removing it releases the wasmtime
    // Store, and with it the plugin's linear memory and tables. Doing
    // this after the staging entry went away would leave the instance
    // orphaned but still resident.
    instances().remove(&plugin_id).map_err(plugin_err_to_napi)?;

    let mut reg = registry().lock().expect("registry mutex");
    if reg.remove(&plugin_id).is_none() {
        return Err(Error::from_reason(format!(
            "plugin `{plugin_id}` not loaded; nothing to deactivate"
        )));
    }
    Ok(())
}

/// Atomically reloads a plugin from its on-disk bundle without
/// requiring a shell restart. Captures the bundle path from the
/// current registry entry, deactivates the existing instance (drops
/// the wasmtime Store, freeing memory), re-stages from disk, and
/// re-activates.
///
/// Used by `POST /api/plugins/:id/reload` to pick up bundle changes
/// (manifest edits, fresh `ui.mjs` after a plugin author's `pnpm
/// build`, etc.) without restarting the host. The reload is **not
/// transactional** — if the re-stage fails after the deactivate, the
/// plugin is left unloaded, surfaced as a normal load error to the
/// caller. The next call to `loadPlugin` (or another `reloadPlugin`
/// attempt) puts it back.
#[napi]
pub async fn reload_plugin(plugin_id: String) -> Result<ActivatedPluginInfo> {
    let bundle_dir = {
        let reg = registry().lock().expect("registry mutex");
        let entry = reg.get(&plugin_id).ok_or_else(|| {
            Error::from_reason(format!(
                "plugin `{plugin_id}` not loaded; nothing to reload"
            ))
        })?;
        entry.staged.bundle_dir.clone()
    };

    deactivate_plugin(plugin_id.clone()).await?;
    let _ = load_plugin(bundle_dir.to_string_lossy().into_owned()).await?;
    activate_plugin(plugin_id).await
}

/// Snapshot of every currently active plugin. Cheap clone of in-memory
/// state; safe to call from any Fastify request handler.
#[napi]
pub async fn list_active() -> Result<Vec<ActivatedPluginInfo>> {
    let reg = registry().lock().expect("registry mutex");
    Ok(reg.values().map(activated_view).collect())
}

/// Persists an optional-permission grant on the plugin's registry
/// entry. No-op when already granted. Returns the updated activated
/// view so callers can refresh their cached UI state.
#[napi]
pub async fn grant_permission(plugin_id: String, permission: String) -> Result<()> {
    // Validate the capability syntax before persisting; refusing
    // garbage at the entry point catches typos.
    let _ = Permission::parse(&permission).map_err(plugin_err_to_napi)?;
    let mut reg = registry().lock().expect("registry mutex");
    let entry = reg
        .get_mut(&plugin_id)
        .ok_or_else(|| Error::from_reason(format!("plugin `{plugin_id}` not loaded")))?;
    entry.granted.insert(permission);
    Ok(())
}

/// Revokes a previously granted optional permission. No-op when the
/// permission was not granted.
#[napi]
pub async fn revoke_permission(plugin_id: String, permission: String) -> Result<()> {
    let mut reg = registry().lock().expect("registry mutex");
    let entry = reg
        .get_mut(&plugin_id)
        .ok_or_else(|| Error::from_reason(format!("plugin `{plugin_id}` not loaded")))?;
    entry.granted.remove(&permission);
    Ok(())
}

/// Sets the calling session identifier for the named plugin's next
/// invocation. Multi-tenant Fastify handlers call this before invoking
/// any plugin-side function so host imports such as
/// `db.current-session()` reflect the caller's session, not a value
/// baked in at activation time.
///
/// Always pair with `clearCallContext` (or call `setCallContext` again
/// for the next caller); leaving stale context risks one session
/// seeing another's identifier on a subsequent unrelated call.
#[napi]
pub async fn set_call_context(plugin_id: String, session_id: String) -> Result<()> {
    let reg = registry().lock().expect("registry mutex");
    let entry = reg
        .get(&plugin_id)
        .ok_or_else(|| Error::from_reason(format!("plugin `{plugin_id}` not loaded")))?;
    *entry.session_slot.lock().expect("session slot mutex") = Some(session_id);
    Ok(())
}

/// Clears the per-call session identifier for the named plugin.
/// Always called after a plugin invocation completes (success or
/// error) to prevent leakage into the next caller's context.
#[napi]
pub async fn clear_call_context(plugin_id: String) -> Result<()> {
    let reg = registry().lock().expect("registry mutex");
    let entry = reg
        .get(&plugin_id)
        .ok_or_else(|| Error::from_reason(format!("plugin `{plugin_id}` not loaded")))?;
    *entry.session_slot.lock().expect("session slot mutex") = None;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Wire types — kept narrow + camelCase for the JS surface.
// ─────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct StagedPluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub world: String,
    pub targets: Vec<String>,
    pub restart_policy: String,
    /// Absolute path to the plugin's on-disk bundle directory. Server
    /// route handlers use this to resolve `<bundle>/ui.mjs` for the
    /// `GET /api/plugins/:id/ui.mjs` endpoint (I2.5) without going
    /// through a NAPI hop per request.
    pub bundle_dir: String,
    pub required_permissions: Vec<String>,
    pub optional_permissions: Vec<String>,
}

impl From<&StagedPlugin> for StagedPluginInfo {
    fn from(s: &StagedPlugin) -> Self {
        let m = &s.manifest.plugin;
        Self {
            id: m.id.clone(),
            name: m.name.clone(),
            version: m.version.to_string(),
            description: m.description.clone(),
            world: m.world.clone(),
            targets: m.targets.iter().map(|e| e.as_token().to_string()).collect(),
            restart_policy: format!("{:?}", m.restart_policy).to_lowercase(),
            bundle_dir: s.bundle_dir.to_string_lossy().into_owned(),
            required_permissions: s
                .manifest
                .permissions
                .required_caps()
                .map(Permission::to_string)
                .collect(),
            optional_permissions: s
                .manifest
                .permissions
                .optional_caps()
                .map(Permission::to_string)
                .collect(),
        }
    }
}

#[napi(object)]
pub struct ActivatedPluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub bundle_dir: String,
    pub sidebar_panels: Vec<SidebarPanelInfo>,
    pub logs: Vec<PluginLogEntry>,
    pub activation: ActivationInfo,
    pub required_permissions: Vec<String>,
    pub optional_permissions: Vec<String>,
    pub granted_permissions: Vec<String>,
    pub pending_permissions: Vec<String>,
}

#[napi(object)]
pub struct SidebarPanelInfo {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
}

#[napi(object)]
pub struct PluginLogEntry {
    pub level: String,
    pub message: String,
}

#[napi(object)]
pub struct ActivationInfo {
    pub status: String,
    pub message: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

fn activated_view(entry: &ActivePluginEntry) -> ActivatedPluginInfo {
    let m = &entry.staged.manifest.plugin;
    let sidebar_panels = entry
        .staged
        .manifest
        .contributions
        .sidebar_panels
        .iter()
        .map(|p| SidebarPanelInfo {
            id: p.id.clone(),
            label: p.label.clone(),
            icon: p.icon.clone(),
        })
        .collect();

    let logs = entry
        .log_sink
        .lock()
        .map(|buf| {
            buf.iter()
                .map(|r| PluginLogEntry {
                    level: log_level_str(r.level).to_string(),
                    message: r.message.clone(),
                })
                .collect()
        })
        .unwrap_or_default();

    let activation = match &entry.activation {
        Some(ActivationOutcome::Ok) => ActivationInfo {
            status: "ok".to_string(),
            message: None,
        },
        Some(ActivationOutcome::Failed(msg)) => ActivationInfo {
            status: "failed".to_string(),
            message: Some(msg.clone()),
        },
        None => ActivationInfo {
            status: "pending".to_string(),
            message: None,
        },
    };

    let required: Vec<String> = entry
        .staged
        .manifest
        .permissions
        .required_caps()
        .map(Permission::to_string)
        .collect();
    let optional: Vec<String> = entry
        .staged
        .manifest
        .permissions
        .optional_caps()
        .map(Permission::to_string)
        .collect();
    let granted: Vec<String> = entry.granted.iter().cloned().collect();
    let pending: Vec<String> = required
        .iter()
        .filter(|r| !entry.granted.contains(*r))
        .cloned()
        .collect();

    ActivatedPluginInfo {
        id: m.id.clone(),
        name: m.name.clone(),
        version: m.version.to_string(),
        description: m.description.clone(),
        bundle_dir: entry.staged.bundle_dir.to_string_lossy().into_owned(),
        sidebar_panels,
        logs,
        activation,
        required_permissions: required,
        optional_permissions: optional,
        granted_permissions: granted,
        pending_permissions: pending,
    }
}

const fn log_level_str(level: plamenix_plugin_host::LogLevel) -> &'static str {
    match level {
        plamenix_plugin_host::LogLevel::Trace => "trace",
        plamenix_plugin_host::LogLevel::Debug => "debug",
        plamenix_plugin_host::LogLevel::Info => "info",
        plamenix_plugin_host::LogLevel::Warn => "warn",
        plamenix_plugin_host::LogLevel::Error => "error",
    }
}

fn plugin_err_to_napi(err: PluginError) -> Error {
    Error::from_reason(err.to_string())
}
