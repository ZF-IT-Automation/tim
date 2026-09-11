// Build completeness guard.
//
// Until 2026-09-03 this checked seven hard-coded entry points. A build missing
// packages/tim-core/dist/maintenance-lock.js passed it, and production (which
// runs from the git working tree) died on `Cannot find module`. The presence
// check now derives from the sources: every compiled `src/**/*.ts` must have
// its `dist/**/*.js`, exactly the set `tsc -b` is configured to emit.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executableEntrypoints = [
  'packages/tim-cli/dist/cli.js',
  'packages/tim-mcp/dist/server.js',
  'packages/tim-summarizer/dist/summarize.js',
  'packages/tim-hooks/dist/summarizer-supervisor.js',
  'packages/tim-sync-server/dist/cli.js',
  'packages/tim-quality-benchmark/dist/cli.js',
];

/**
 * Does `tsc -b` emit a `.js` for this source file? Mirrors the workspace
 * tsconfigs: rootDir `src`, outDir `dist`, `exclude: ["src/**\/__tests__/**"]`.
 * Declaration files and non-TS assets emit nothing.
 *
 * @param {string} file package-relative POSIX path, e.g. `src/index.ts`
 */
export function isCompiledSource(file) {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) return false;
  if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) return false;
  return !file.split('/').includes('__tests__');
}

/**
 * The compiled counterpart of a source path — first `src/` segment becomes
 * `dist/`, `.ts` becomes `.js`.
 *
 * @param {string} file package-relative POSIX path
 */
export function distCounterpart(file) {
  return file.replace(/(^|\/)src\//, '$1dist/').replace(/\.ts$/, '.js');
}

/**
 * Pure file pairing: which compiled outputs the sources require but the build
 * did not produce.
 *
 * @param {string[]} sources package-relative POSIX paths under `src/`
 * @param {string[]} outputs package-relative POSIX paths under `dist/`
 * @returns {string[]} missing `dist/` paths, in source order
 */
export function missingBuildOutputs(sources, outputs) {
  const built = new Set(outputs);
  return sources
    .filter(isCompiledSource)
    .map(distCounterpart)
    .filter((file) => !built.has(file));
}

/** Recursively list files under `dir` as POSIX paths relative to it. */
async function listFiles(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(dir, entry.name), relative)));
    } else {
      files.push(relative);
    }
  }
  return files;
}

/**
 * Walk every workspace package and report the compiled modules the build owes.
 *
 * @param {string} root repository root
 * @returns {Promise<{ missing: string[], checked: number }>}
 */
export async function findMissingBuildOutputs(root = '.') {
  const packagesDir = path.join(root, 'packages');
  const packages = (await readdir(packagesDir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );

  const missing = [];
  let checked = 0;

  for (const pkg of packages) {
    const base = path.join(packagesDir, pkg.name);
    const sources = (await listFiles(path.join(base, 'src'))).map((file) => `src/${file}`);
    const outputs = (await listFiles(path.join(base, 'dist'))).map((file) => `dist/${file}`);

    checked += sources.filter(isCompiledSource).length;
    missing.push(
      ...missingBuildOutputs(sources, outputs).map((file) => `packages/${pkg.name}/${file}`),
    );
  }

  return { missing, checked };
}

async function main() {
  const { missing, checked } = await findMissingBuildOutputs();

  if (missing.length > 0) {
    throw new Error(
      `Build output is incomplete — ${missing.length} of ${checked} source module(s) have no compiled counterpart:\n` +
        missing.map((file) => `  missing: ${file}`).join('\n'),
    );
  }

  if (process.platform !== 'win32') {
    for (const file of executableEntrypoints) {
      const mode = (await stat(file)).mode;
      if ((mode & 0o111) === 0) {
        throw new Error(`Expected executable build output: ${file}`);
      }
    }
  }

  console.log(
    `Build outputs are complete (${checked} modules) and executable entrypoints retain execute permission.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
