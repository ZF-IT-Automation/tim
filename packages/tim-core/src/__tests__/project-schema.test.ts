import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_SCHEMA,
  findSchemaSection,
  schemaSectionNames,
} from '../project-schema.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

describe('PROJECT_SCHEMA', () => {
  it('is the single source of truth — docs/project-schema.json mirrors it exactly', () => {
    // The JSON under docs/ ships in no package; it exists for humans only. If this
    // fails, run `node scripts/sync-project-schema.mjs` after rebuilding tim-core.
    const docPath = path.join(repoRoot, 'docs/project-schema.json');
    const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
    expect(doc).toEqual(JSON.parse(JSON.stringify(PROJECT_SCHEMA)));
  });

  it('declares the 12 standard sections in order', () => {
    expect(PROJECT_SCHEMA.sections.map(s => s.name)).toEqual([
      'Overview', 'Rules', 'Log', 'Decisions', 'Codebase',
      'Usage', 'Bugs', 'Roadmap', 'Ideas', 'Tasks', 'Sessions', 'Commits',
    ]);
  });

  it('marks Sessions and Commits as subsystem-managed', () => {
    const managed = PROJECT_SCHEMA.sections.filter(s => s.managed).map(s => s.name);
    expect(managed).toEqual(['Sessions', 'Commits']);
  });

  it('finds nested sections by name at any depth', () => {
    expect(findSchemaSection(PROJECT_SCHEMA.sections, 'Git Rules')?.render_depth).toBe(2);
    expect(findSchemaSection(PROJECT_SCHEMA.sections, 'Functions')?.render_depth).toBe(1);
    expect(findSchemaSection(PROJECT_SCHEMA.sections, 'Install')?.render_depth).toBe('full');
    expect(findSchemaSection(PROJECT_SCHEMA.sections, 'Errors')).toBeUndefined();
    // Next Steps and its Previous Steps child left the schema — Tasks holds every work item.
    expect(findSchemaSection(PROJECT_SCHEMA.sections, 'Next Steps')).toBeUndefined();
    expect(findSchemaSection(PROJECT_SCHEMA.sections, 'Previous Steps')).toBeUndefined();
  });

  it('flattens every section name including children', () => {
    const names = schemaSectionNames();
    expect(names).toContain('Overview');
    expect(names).toContain('Agent Rules');
    expect(names).toContain('Functions');
    expect(new Set(names).size).toBe(names.length);
  });
});
