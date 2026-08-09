import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PROJECT_SCHEMA } from 'tim-core';
import { TimStore, ensureProjectSchema } from 'tim-store';
import {
  collectProjectSchemaReport,
  formatProjectSchemaFindingLine,
  needsSchemaRepair,
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
        label: 'P0306', title: 'Demo', missing: ['Overview'], unknown: ['Errors'], renamed: [],
      }),
    ).toBe('  P0306 Demo — 1 missing: Overview | custom (kept): Errors');

    expect(
      formatProjectSchemaFindingLine({
        label: 'P0307', title: 'Demo', missing: [], unknown: [], renamed: [],
      }),
    ).toBe('  P0307 Demo — ✓ complete');

    expect(
      formatProjectSchemaFindingLine({
        label: 'P0310', title: 'Demo', missing: [], unknown: [],
        renamed: ['Actionable work items and open tasks → Tasks'],
      }),
    ).toBe(
      '  P0310 Demo — ✓ complete | 1 mistitled: Actionable work items and open tasks → Tasks',
    );

    expect(formatProjectSchemaOutcomeLine({ label: 'P0308', added: ['Bugs'], renamed: [] }))
      .toBe('  ✓ P0308: added Bugs');
    expect(
      formatProjectSchemaOutcomeLine({
        label: 'P0311', added: [], renamed: ['Bug and error tracking → Bugs'],
      }),
    ).toBe('  ✓ P0311: retitled Bug and error tracking → Bugs');
    expect(formatProjectSchemaOutcomeLine({ label: 'P0309', added: [], renamed: [], error: 'boom' }))
      .toBe('  ✗ P0309: boom');
  });
});

describe('repair of mistitled legacy sections', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('repairs a project whose sections are all present but mistitled', async () => {
    const project = await store.createProject('P0400');
    // Every schema section exists by label but under its own description, so
    // `missing` is empty — the repair must still run.
    for (const [label, description] of [
      ['Tasks', 'Actionable work items and open tasks'],
      ['Ideas', 'Brainstorming and undecided proposals'],
    ] as const) {
      await store.write(description, {
        parentId: project.id,
        metadata: { kind: 'section', label },
      });
    }

    const report = await collectProjectSchemaReport(store, 'P0400');
    expect(report).toHaveLength(1);
    expect(report[0]!.renamed.length).toBeGreaterThan(0);
    expect(needsSchemaRepair(report[0]!)).toBe(true);

    const outcomes = await repairProjectSchemas(store, report);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.renamed).toContain('Actionable work items and open tasks → Tasks');

    const titles = (await store.getChildren(project.id)).map(c => c.title);
    expect(titles).toContain('Tasks');
    expect(titles).not.toContain('Actionable work items and open tasks');
  });

  it('marks a mistitled project as needing repair in the report line', async () => {
    const project = await store.createProject('P0401');
    await store.write('Actionable work items and open tasks', {
      parentId: project.id,
      metadata: { kind: 'section', label: 'Tasks' },
    });

    const report = await collectProjectSchemaReport(store, 'P0401');
    const line = formatProjectSchemaFindingLine(report[0]!);
    expect(line).toContain('mistitled');
  });
});
