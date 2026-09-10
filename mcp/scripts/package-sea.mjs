#!/usr/bin/env node
// Packages `dist/hammond-mcp.cjs` (built by `npm run build`) into a single, dependency-free
// native executable using Node's built-in Single Executable Application (SEA) support, so the
// packaged Windows app can ship one binary instead of a Node install plus a `node_modules` tree.
//
// This has been run and verified end to end on Linux (this development machine) — see
// docs/AGENT_ACCESS.md for the exact commands and their output. It has NOT been re-verified on
// Windows in this environment (no Windows machine was available); running this same script with
// Node for Windows installed produces `dist/hammond-mcp.exe` by the identical mechanism per
// Node's own SEA documentation, but that has not been independently confirmed here — see the
// worker report's limitations section.
//
// To update the embedded Node runtime later: re-run this script with a newer Node installed (or
// pointed at via PATH) — there is nothing else to update, since the runtime is embedded directly
// in the produced binary rather than referenced externally.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';
const outputPath = path.join('dist', `hammond-mcp${isWindows ? '.exe' : ''}`);
const blobPath = path.join('dist', 'hammond-mcp.blob');
const seaConfigPath = 'sea-config.json';

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit' });
}

if (!existsSync('dist/hammond-mcp.cjs')) {
  console.error('dist/hammond-mcp.cjs not found — run "npm run build" first.');
  process.exit(1);
}

mkdirSync('dist', { recursive: true });

run('node', ['--experimental-sea-config', seaConfigPath]);

copyFileSync(process.execPath, outputPath);
if (!isWindows) chmodSync(outputPath, 0o755);

const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const postjectArgs = [
  '--yes',
  'postject',
  outputPath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  sentinelFuse,
];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('npx', postjectArgs);

console.log(`\nBuilt standalone executable: ${outputPath}`);
console.log(
  'Verify it launches with: HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH=/path/to/agent-access-credentials.json ' +
    outputPath,
);
