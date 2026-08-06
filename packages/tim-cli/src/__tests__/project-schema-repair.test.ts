import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PROJECT_SCHEMA } from 'tim-core';
import { TimStore, ensureProjectSchema } from 'tim-store';
import {
  collectProjectSchemaReport,
  formatProjectSchemaFindingLine,
  formatProjectSchemaOutcomeLine,
  repairProjectSchemas,
} from '../project-schema-repair.js';

const EXPECTED_TOP_LEVEL = PROJECT_SCHEMA.sections
  .filter(s => !s.managed)
  .map(s => s.name);

/** A project as the pre-schema `tim new-project` would have left it. */
async function seedLegacyProject(store: TimStore, label: string): Promise<string> {
  const project = await store.createProject(label, { content: `${label} | Active` });
  for (const name of ['Tasks', 'Ideas', 'Errors', 'Decisions', 'Learnings', 'Log', 'Testing']) {
    await store.write(`legacy body for ${name}`, {
      parentId: project.id,
      title: name,
      metadata: { kind: 'section', label: name },
    });
  }
  return project.id;
}

describe('project schema repair (tim doctor --repair-schema)', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('reports missing and custom sections without writing', async () => {
    const projectId = await seedLegacyProject(store, 'P0301');
    const before = (await store.getChildren(projectId)).length;

    const report = await collectProjectSchemaReport(store);
    expect(report).toHaveLength(1);
    expect(report[0]!.label).toBe('P0301');
    expect(report[0]!.missing).toContain('Overview');
    expect(report[0]!.missing).not.toContain('Tasks');
    expect(report[0]!.unknown.sort()).toEqual(['Errors', 'Learnings', 'Testing']);
    expect((await store.getChildren(projectId)).length).toBe(before);
  });

  it('limits the report to one project when a filter is given', async () => {
    await seedLegacyProject(store, 'P0302');
    await seedLegacyProject(store, 'P0303');

    const report = await collectProjectSchemaReport(store, 'P0303');
    expect(report.map(f => f.label)).toEqual(['P0303']);
  });

  it('adds missing sections and keeps custom ones on repair', async () => {
    const projectId = await seedLegacyProject(store, 'P0304');
    const report = await collectProjectSchemaReport(store);
    const outcomes = await repairProjectSchemas(store, report);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.added).toContain('Overview');
    expect(outcomes[0]!.error).toBeUndefined();

    const titles = (await store.getChildren(projectId)).map(c => c.title);
    for (const name of EXPECTED_TOP_LEVEL) expect(titles).toContain(name);
    // Untouched, not renamed and not deleted.
    expect(titles).toEqual(expect.arrayContaining(['Errors', 'Learnings', 'Testing']));
  });

  it('is a no-op for a project that already matches the schema', async () => {
    const project = await store.createProject('P0305', { content: 'Fresh | Active' });
    await ensureProjectSchema(store, project.id);

    const report = await collectProjectSchemaReport(store);
    expect(report[0]!.missing).toEqual([]);
    expect(await repairProjectSchemas(store, report)).toEqual([]);
  });

  it('formats findings and outcomes for the doctor output', () => {
    expect(
      formatProjectSchemaFindingLine({
        label: 'P0306', title: 'Demo', missing: ['Overview'], unknown: ['Errors'],
      }),
    ).toBe('  P0306 Demo — 1 missing: Overview | custom (kept): Errors');

    expect(
      formatProjectSchemaFindingLine({ label: 'P0307', title: 'Demo', missing: [], unknown: [] }),
    ).toBe('  P0307 Demo — ✓ complete');

    expect(formatProjectSchemaOutcomeLine({ label: 'P0308', added: ['Bugs'] }))
      .toBe('  ✓ P0308: added Bugs');
    expect(formatProjectSchemaOutcomeLine({ label: 'P0309', added: [], error: 'boom' }))
      .toBe('  ✗ P0309: boom');
  });
});
