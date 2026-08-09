#!/usr/bin/env node
// Regenerate docs/project-schema.json from the authoritative schema in tim-core.
// The JSON is a human-readable mirror only — nothing reads it at runtime.
// Run after editing packages/tim-core/src/project-schema.ts (requires a build).
//
// packages/tim-core/src/__tests__/project-schema.test.ts fails if the two drift.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PROJECT_SCHEMA } = await import(
  path.join(repoRoot, 'packages/tim-core/dist/project-schema.js')
);

const target = path.join(repoRoot, 'docs/project-schema.json');
writeFileSync(target, `${JSON.stringify(PROJECT_SCHEMA, null, 2)}\n`);
console.log(`✓ Wrote ${path.relative(repoRoot, target)}`);
