//! Proves that the main-window capability actually grants the command the installed
//! `@tauri-apps/api` invokes on an owner-approved close.
//!
//! `Window.onCloseRequested` (in the installed `@tauri-apps/api` package, not our own code) does
//! `await handler(evt); if (!evt.isPreventDefault()) await this.destroy();` — so an allowed
//! Save/Discard/clean-close decision reaches `invoke("plugin:window|destroy", { label: "main" })`.
//! That call is authorized (or ACL-denied) against `src-tauri/capabilities/default.json`, not
//! against anything the frontend test suite can see. This test resolves the ACL the exact same
//! way `tauri::generate_context!()` does in `lib.rs` — using the same `Resolved::resolve` call
//! and the same build-time-generated `acl-manifests.json` / `capabilities.json` that
//! `tauri-build` writes into `OUT_DIR` from the real, installed core-window plugin manifest and
//! the real `capabilities/default.json` file — so it fails if either the capability grant or the
//! plugin's own command wiring regresses.
use std::{collections::BTreeMap, path::PathBuf};

use tauri::utils::acl::{
    capability::Capability, manifest::Manifest, resolved::Resolved, ExecutionContext,
    ACL_MANIFESTS_FILE_NAME, CAPABILITIES_FILE_NAME,
};
use tauri::utils::platform::Target;

/// The exact command `Window.destroy()` invokes (see `@tauri-apps/api/window.js`).
const DESTROY_COMMAND: &str = "plugin:window|destroy";
/// The only window label declared in `tauri.conf.json` and `capabilities/default.json`.
const MAIN_WINDOW: &str = "main";

fn read_out_dir_json<T: serde::de::DeserializeOwned>(file_name: &str) -> T {
    let path = PathBuf::from(env!("OUT_DIR")).join(file_name);
    let contents = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "tauri-build should have generated {path:?} during `cargo build`/`cargo test`: {error}"
        )
    });
    serde_json::from_str(&contents)
        .unwrap_or_else(|error| panic!("failed to parse generated {path:?}: {error}"))
}

fn resolve_production_acl() -> Resolved {
    let acl: BTreeMap<String, Manifest> = read_out_dir_json(ACL_MANIFESTS_FILE_NAME);
    let capabilities: BTreeMap<String, Capability> = read_out_dir_json(CAPABILITIES_FILE_NAME);

    assert!(
        capabilities.contains_key("default"),
        "expected the \"default\" capability from src-tauri/capabilities/default.json to be \
         present in the generated capability set"
    );

    Resolved::resolve(&acl, capabilities, Target::current())
        .expect("the production capability set must resolve against the installed Tauri ACL")
}

#[test]
fn main_window_capability_grants_the_owner_approved_close_destroy_command() {
    let resolved = resolve_production_acl();

    let denied_for_main = resolved
        .denied_commands
        .get(DESTROY_COMMAND)
        .is_some_and(|entries| {
            entries.iter().any(|cmd| {
                cmd.windows
                    .iter()
                    .any(|pattern| pattern.matches(MAIN_WINDOW))
            })
        });
    assert!(
        !denied_for_main,
        "`{DESTROY_COMMAND}` must not be explicitly denied for the \"{MAIN_WINDOW}\" window: a \
         deny would ACL-block the owner-approved close path the same as a missing grant"
    );

    let allowed_for_main = resolved
        .allowed_commands
        .get(DESTROY_COMMAND)
        .into_iter()
        .flatten()
        .any(|cmd| {
            matches!(cmd.context, ExecutionContext::Local)
                && cmd
                    .windows
                    .iter()
                    .any(|pattern| pattern.matches(MAIN_WINDOW))
        });

    assert!(
        allowed_for_main,
        "src-tauri/capabilities/default.json must grant `core:window:allow-destroy` (or an \
         equivalent) to the \"{MAIN_WINDOW}\" window — without it, Tauri's own installed \
         `Window.onCloseRequested` calls `this.destroy()` on an allowed Save/Discard/clean-close \
         decision, that invoke is ACL-denied, and the window never actually closes"
    );
}
