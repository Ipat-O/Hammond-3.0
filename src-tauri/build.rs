use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    build_companion_sidecar();
    tauri_build::build();
}

/// Builds and stages `hammond-mcp-companion` (`crates/companion`) as a Tauri `externalBin`
/// sidecar (see `tauri.conf.json`'s `bundle.externalBin`) before `tauri_build::build()` below
/// validates that the sidecar file exists — it does so unconditionally, on every `cargo check`,
/// `cargo build`, or `cargo clippy` of this package, not only during `tauri build`. Building it
/// here, rather than relying on a `beforeBuildCommand` (which only runs for the Tauri CLI's own
/// `dev`/`build`, never for a plain `cargo` invocation) or a checked-in binary, is what keeps a
/// clean checkout's `cargo check` working without a manual step. See docs/AGENT_ACCESS.md
/// "Packaging" for the full rationale and its disclosed limitations.
fn build_companion_sidecar() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("set by cargo"));
    let target_triple = env::var("TARGET").expect("set by cargo for build scripts");
    let profile = env::var("PROFILE").expect("set by cargo for build scripts");
    let is_release = profile == "release";

    // Cargo only auto-reruns build scripts on changes to files inside this package's own
    // manifest directory; the companion and its shared library live in sibling packages, so they
    // need explicit rerun-if-changed coverage or edits there would go unnoticed here.
    println!("cargo:rerun-if-changed=crates/companion/src");
    println!("cargo:rerun-if-changed=crates/companion/Cargo.toml");
    println!("cargo:rerun-if-changed=crates/agent-access/src");
    println!("cargo:rerun-if-changed=crates/agent-access/Cargo.toml");

    let cargo_bin = env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    // A target-dir distinct from the outer build's own keeps this nested `cargo build`'s
    // `.cargo-lock` independent of the one the outer cargo invocation (running this very build
    // script) already holds for the duration of the build — sharing one target-dir would
    // deadlock: the nested build would block waiting for a lock the outer build cannot release
    // until this script returns.
    let sidecar_target_dir = manifest_dir.join("target").join("companion-sidecar");

    let mut cmd = Command::new(&cargo_bin);
    cmd.current_dir(&manifest_dir)
        .arg("build")
        .arg("--package")
        .arg("hammond-mcp-companion")
        .arg("--target")
        .arg(&target_triple)
        .arg("--target-dir")
        .arg(&sidecar_target_dir);
    if is_release {
        cmd.arg("--release");
    }

    let status = cmd.status().unwrap_or_else(|error| {
        panic!("failed to launch `{cargo_bin} build -p hammond-mcp-companion`: {error}")
    });
    if !status.success() {
        panic!(
            "building the hammond-mcp-companion sidecar failed ({status}). The Tauri bundle \
cannot include a companion binary that does not build; fix crates/companion or \
crates/agent-access and re-run."
        );
    }

    let exe_suffix = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let built_path = sidecar_target_dir
        .join(&target_triple)
        .join(if is_release { "release" } else { "debug" })
        .join(format!("hammond-mcp-companion{exe_suffix}"));
    if !built_path.exists() {
        panic!(
            "cargo reported success building hammond-mcp-companion but {} does not exist; the \
sidecar target-dir layout may have changed",
            built_path.display()
        );
    }

    let binaries_dir = manifest_dir.join("binaries");
    fs::create_dir_all(&binaries_dir).unwrap_or_else(|error| {
        panic!("failed to create {}: {error}", binaries_dir.display())
    });
    // Matches tauri-utils's `external_binaries()` naming convention exactly: `tauri.conf.json`
    // declares `externalBin: ["binaries/hammond-mcp-companion"]`, and Tauri appends
    // `-<target-triple>` (plus `.exe` on Windows) to resolve the actual file it copies in.
    let staged_path = binaries_dir.join(format!(
        "hammond-mcp-companion-{target_triple}{exe_suffix}"
    ));
    fs::copy(&built_path, &staged_path).unwrap_or_else(|error| {
        panic!(
            "failed to stage the companion sidecar from {} to {}: {error}",
            built_path.display(),
            staged_path.display()
        )
    });
}
