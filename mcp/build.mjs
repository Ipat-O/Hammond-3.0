import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

/**
 * Bundles the adapter into a single, dependency-free ESM file so the packaged Windows app can
 * ship one artifact plus a Node runtime, rather than a `node_modules` tree. `platform: 'node'`
 * keeps Node built-ins (fs, os, path) external/native; `@modelcontextprotocol/sdk` and its own
 * dependencies (zod, etc.) are inlined.
 *
 * This produces the entry point a bundled runtime launches directly
 * (`node dist/hammond-mcp.mjs`) — see `docs/AGENT_ACCESS.md` for how that is packaged as a
 * standalone executable (Node's Single Executable Application feature) for distribution with the
 * Windows build, which was not re-verified end-to-end on this Linux development machine.
 */
const shared = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

// The general-purpose artifact: `node dist/hammond-mcp.mjs`, usable anywhere Node itself is
// available. `src/index.ts` already carries its own `#!/usr/bin/env node` shebang, which esbuild
// passes through as the file's first line — a `banner` here too would duplicate it, and Node only
// strips a *single* leading shebang line before parsing an ESM entry point.
await build({ ...shared, outfile: 'dist/hammond-mcp.mjs', format: 'esm' });
chmodSync('dist/hammond-mcp.mjs', 0o755);

// A CJS twin exists solely as input to Node's Single Executable Application (SEA) packaging
// (`scripts/package-sea.mjs`), which currently requires a CommonJS main script.
await build({ ...shared, outfile: 'dist/hammond-mcp.cjs', format: 'cjs' });
chmodSync('dist/hammond-mcp.cjs', 0o755);
