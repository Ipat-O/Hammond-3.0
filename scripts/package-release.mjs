#!/usr/bin/env node
/**
 * The one documented, reproducible release path for the packaged desktop app *with* the bundled
 * MCP adapter (HAM3-015). Ordinary development — `cargo test`, `cargo clippy`, `tauri dev`,
 * `npm run tauri:build` on its own — deliberately does NOT need any of this and never touches a
 * hand-built adapter binary: the adapter is a bundle resource only for this release build, added
 * via `src-tauri/tauri.bundle.windows.conf.json` (which is not auto-merged).
 *
 * Prerequisite: dependencies installed in both the repo root and `mcp/` (`npm ci` in each).
 *
 * Steps:
 *   1. build the MCP adapter bundle and its single-file executable (`mcp/` package)
 *   2. verify the executable exists and passes its real-protocol check
 *   3. `tauri build` with the Windows release bundle overlay applied
 *
 * If step 2's executable is missing this stops with a clear error — and `tauri build` itself
 * would also fail loudly on the missing bundle resource — so a release can never silently ship
 * without the adapter.
 *
 * Every child process is `node <script>` or `node <cli.js>` invoked as `process.execPath` with an
 * args array and no shell: never an `npm` / `npx` / `.cmd` shim (which `execFileSync` cannot
 * launch on Windows — the same class of defect this release fixes in `package-sea.mjs`).
 *
 * Usage: `npm run package:release` from the repo root. Windows is the supported target; on
 * another platform it still builds/verifies the adapter, then runs a plain `tauri build`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpDir = path.join(repoRoot, 'mcp');
const isWindows = process.platform === 'win32';
const adapterName = isWindows ? 'hammond-mcp.exe' : 'hammond-mcp';
const adapterPath = path.join(mcpDir, 'dist', adapterName);

function node(label, scriptOrCli, args, cwd) {
  console.log(`\n=== ${label} ===`);
  execFileSync(process.execPath, [scriptOrCli, ...args], { stdio: 'inherit', cwd });
}

/** The real JS entry of a package's `bin`, resolved from this repo's node_modules. */
function resolveBin(pkgName, binName) {
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  const pkg = require(`${pkgName}/package.json`);
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName];
  if (!rel) throw new Error(`${pkgName} exposes no "${binName}" bin — run "npm ci".`);
  return path.join(path.dirname(pkgJsonPath), rel);
}

node('mcp: build bundle', path.join('build.mjs'), [], mcpDir);
node('mcp: package single-file executable', path.join('scripts', 'package-sea.mjs'), [], mcpDir);

if (!existsSync(adapterPath)) {
  console.error(
    `\nRelease aborted: ${adapterPath} was not produced. The MCP adapter is a required bundle ` +
      `resource for the release build.`,
  );
  process.exit(1);
}
node(
  'mcp: verify packaged executable speaks MCP',
  path.join('scripts', 'verify-sea.mjs'),
  [],
  mcpDir,
);

const tauriCli = resolveBin('@tauri-apps/cli', 'tauri');
const tauriArgs = ['build'];
if (isWindows) {
  tauriArgs.push('--config', path.join('src-tauri', 'tauri.bundle.windows.conf.json'));
}
node('desktop: tauri build', tauriCli, tauriArgs, repoRoot);

console.log(`\nRelease build complete. The installer carries ${adapterName} in the install root.`);
