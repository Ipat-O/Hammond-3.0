//! Regression coverage for HAM3-014 Correction 1: proves `build.rs` builds and stages the
//! `hammond-mcp-companion` sidecar automatically, so a clean checkout's `cargo check`/`cargo
//! build`/`cargo clippy` need no manual step first (no `npm run companion:build`, no checked-in
//! binary, no placeholder) before `tauri_build::build()`'s eager `externalBin` resource
//! validation — the ordering gap this correction closes. See `build.rs`'s module doc and
//! docs/AGENT_ACCESS.md "Packaging".

use std::path::PathBuf;
use std::process::Command;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The triple a plain, non-cross `cargo check` compiles this package for — the same one
/// `build.rs` receives via the `TARGET` env var cargo sets for build scripts.
fn host_triple() -> String {
    let output = Command::new("rustc")
        .arg("-vV")
        .output()
        .expect("failed to run `rustc -vV`");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("host: ").map(str::to_owned))
        .expect("`rustc -vV` always prints a host line")
}

/// A real, from-scratch `cargo check` (sidecar target-dir and staged `binaries/` wiped first)
/// must both succeed and leave the correctly-named companion sidecar staged where
/// `tauri.conf.json`'s `externalBin` expects it — with no `npm run companion:build` and no
/// preexisting binary. This is exactly the "clean checkout" scenario Tauri's own eager resource
/// validation would otherwise break.
#[test]
fn clean_checkout_cargo_check_stages_the_companion_sidecar() {
    let manifest_dir = manifest_dir();
    let triple = host_triple();

    let sidecar_target_dir = manifest_dir.join("target").join("companion-sidecar");
    let staged_path = manifest_dir
        .join("binaries")
        .join(format!("hammond-mcp-companion-{triple}"));
    let _ = std::fs::remove_dir_all(&sidecar_target_dir);
    let _ = std::fs::remove_file(&staged_path);
    assert!(
        !staged_path.exists(),
        "test setup failed to clear the previously staged sidecar"
    );

    let status = Command::new(env!("CARGO"))
        .current_dir(&manifest_dir)
        .args(["check", "--package", "hammond-desktop"])
        .status()
        .expect("failed to launch `cargo check -p hammond-desktop`");
    assert!(
        status.success(),
        "a clean-checkout `cargo check -p hammond-desktop` must succeed on its own, with no \
manual companion build step first"
    );

    assert!(
        staged_path.exists(),
        "build.rs should have staged {} during that `cargo check`, matching tauri.conf.json's \
`externalBin: [\"binaries/hammond-mcp-companion\"]`",
        staged_path.display()
    );
}
