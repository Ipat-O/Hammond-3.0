#!/usr/bin/env node
// Packages `dist/hammond-mcp.cjs` (built by `npm run build`) into a single, dependency-free
// native executable using Node's built-in Single Executable Application (SEA) support, so the
// packaged desktop app can ship one binary instead of a Node install plus a `node_modules` tree.
//
// Cross-platform. It never shells out and never builds a command string: every child process is
// spawned with `execFileSync(file, argsArray)` (no `shell`), so a path containing spaces or shell
// metacharacters is passed through literally. It invokes `node` as `process.execPath` (the exact
// interpreter running this script, which is also the runtime embedded into the produced binary)
// and `postject` by its resolved package entry point rather than via `npx` — a Windows `npx` is
// the `npx.cmd` shim, which `execFileSync` cannot launch (the defect fixed here).
//
// To update the embedded Node runtime later, re-run this script with a newer Node: the runtime
// lives inside the produced binary, nothing external is referenced.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const isWindows = process.platform === 'win32';
const outputPath = path.join('dist', `hammond-mcp${isWindows ? '.exe' : ''}`);
const blobPath = path.join('dist', 'hammond-mcp.blob');
const seaConfigPath = 'sea-config.json';

function run(file, args) {
  console.log(`$ ${file} ${args.join(' ')}`);
  execFileSync(file, args, { stdio: 'inherit' });
}

/** The real JS entry point of the `postject` dev-dependency (never the `.bin` shim). */
function resolvePostjectCli() {
  const pkgJsonPath = require.resolve('postject/package.json');
  const pkg = require('postject/package.json');
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.postject;
  if (!binRel) {
    throw new Error('postject is installed but exposes no CLI entry point — run "npm ci" in mcp/.');
  }
  return path.join(path.dirname(pkgJsonPath), binRel);
}

if (!existsSync('dist/hammond-mcp.cjs')) {
  console.error('dist/hammond-mcp.cjs not found — run "npm run build" first.');
  process.exit(1);
}

mkdirSync('dist', { recursive: true });

// 1. Generate the SEA blob from the CJS bundle.
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

// 2. Copy this interpreter to the output path; it becomes the shell the blob is injected into.
copyFileSync(process.execPath, outputPath);
if (!isWindows) chmodSync(outputPath, 0o755);

// 3. Inject the blob with postject.
const postjectArgs = [
  resolvePostjectCli(),
  outputPath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, postjectArgs);

console.log(`\nBuilt standalone executable: ${outputPath}`);
console.log(
  'Verify it launches with: HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH=/path/to/agent-access-credentials.json ' +
    outputPath,
);
