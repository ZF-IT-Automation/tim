import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PROJECT_SCHEMA, type ProjectSchema } from 'tim-core';
import { TimStore } from '../store.js';
import { ensureProjectSchema, planProjectSchema } from '../project-schema-init.js';

/** Every non-managed top-level schema section name. */
const MATERIALIZED_TOP_LEVEL = PROJECT_SCHEMA.sections
  .filter(s => !s.managed)
  .map(s => s.name);

describe('ensureProjectSchema', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  async function titlesUnder(parentId: string): Promise<string[]> {
    return (await store.getChildren(parentId)).map(c => c.title);
  }

  it('materializes every non-managed top-level section', async () => {
    const project = await store.createProject('P0101', { content: 'Demo | Active' });
    const result = await ensureProjectSchema(store, project.id);

    expect(await titlesUnder(project.id)).toEqual(MATERIALIZED_TOP_LEVEL);
    expect(result.created).toContain('Overview');
    expect(result.existing).toHaveLength(0);
  });

  it('skips Sessions and Commits — the session/commit trees own those roots', async () => {
    const project = await store.createProject('P0102', { content: 'Demo | Active' });
    await ensureProjectSchema(store, project.id);

    const titles = await titlesUnder(project.id);
    expect(titles).not.toContain('Sessions');
    expect(titles).not.toContain('Commits');
  });

  it('materializes nested children, including two levels deep', async () => {
    const project = await store.createProject('P0103', { content: 'Demo | Active' });
    const result = await ensureProjectSchema(store, project.id);

    const rules = (await store.getChildren(project.id)).find(c => c.title === 'Rules')!;
    expect(await titlesUnder(rules.id)).toEqual([
      'Agent Rules', 'Git Rules', 'Style Rules', 'Do Not',
    ]);

    const codebase = (await store.getChildren(project.id)).find(c => c.title === 'Codebase')!;
    const modules = (await store.getChildren(codebase.id)).find(c => c.title === 'Modules')!;
    expect(await titlesUnder(modules.id)).toEqual(['Functions']);

    expect(result.created).toContain('Rules/Git Rules');
    expect(result.created).toContain('Codebase/Modules/Functions');
  });

  it('carries render_depth and render_tail onto node metadata', async () => {
    const project = await store.createProject('P0104', { content: 'Demo | Active' });
    await ensureProjectSchema(store, project.id);
    const children = await store.getChildren(project.id);

    const overview = children.find(c => c.title === 'Overview')!;
    expect(overview.metadata.render_depth).toBe('full');
    expect(overview.metadata.render_tail).toBeUndefined();

    const log = children.find(c => c.title === 'Log')!;
    expect(log.metadata.render_depth).toBe(1);
    expect(log.metadata.render_tail).toBe(true);

    const nextSteps = children.find(c => c.title === 'Next Steps')!;
    const previous = (await store.getChildren(nextSteps.id))[0]!;
    expect(previous.title).toBe('Previous Steps');
    expect(previous.metadata.render_depth).toBe(0);
  });

  it('writes sections with title=name so resolveSectionByTitle finds them', async () => {
    const project = await store.createProject('P0105', { content: 'Demo | Active' });
    await ensureProjectSchema(store, project.id);

    const found = await store.resolveSectionByTitle('P0105', 'Tasks');
    expect(found.status).toBe('found');

    const children = await store.getChildren(project.id);
    const tasks = children.find(c => c.title === 'Tasks')!;
    expect(tasks.metadata.kind).toBe('section');
    expect(tasks.metadata.label).toBe('Tasks');
    // Description goes in the body, not the title — the old lists put it in the title.
    expect(tasks.content).toContain('Work-Items');
  });

  it('is idempotent — a second run creates nothing', async () => {
    const project = await store.createProject('P0106', { content: 'Demo | Active' });
    const first = await ensureProjectSchema(store, project.id);
    const before = (await store.getChildren(project.id)).length;

    const second = await ensureProjectSchema(store, project.id);
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual(first.created);
    expect((await store.getChildren(project.id)).length).toBe(before);
  });

  it('accepts a project label or alias, not only an entry id', async () => {
    await store.createProject('P0107', { content: 'Demo | Active', aliases: ['demo'] });
    await ensureProjectSchema(store, 'demo');
    const byLabel = await ensureProjectSchema(store, 'P0107');
    expect(byLabel.created).toEqual([]);
  });

  it('honours an injected schema', async () => {
    const project = await store.createProject('P0108', { content: 'Demo | Active' });
    const schema: ProjectSchema = {
      sections: [{ name: 'Only', description: 'just one', render_depth: 2 }],
    };
    await ensureProjectSchema(store, project.id, { schema });
    expect(await titlesUnder(project.id)).toEqual(['Only']);
  });
});

describe('ensureProjectSchema migration of legacy projects', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  /** A project as the pre-schema tim-cli STANDARD_SECTIONS list would have made it. */
  async function seedLegacyProject(label: string) {
    const project = await store.createProject(label, { content: 'Legacy | Active' });
    const legacy = [
      { label: 'Tasks', content: 'Actionable work items and open tasks' },
      { label: 'Ideas', content: 'Brainstorming and undecided proposals' },
      { label: 'Errors', content: 'Bug and error tracking' },
      { label: 'Decisions', content: 'Architecture and project decisions' },
      { label: 'Learnings', content: 'Lessons learned and pitfalls' },
      { label: 'Log', content: 'Project activity log and milestones' },
      { label: 'Testing', content: 'Test scenarios and coverage notes' },
    ];
    for (const section of legacy) {
      await store.write(section.content, {
        parentId: project.id,
        title: section.label,
        metadata: { kind: 'section', label: section.label },
      });
    }
    return project;
  }

  it('adds only the missing sections and reports unknown ones', async () => {
    const project = await seedLegacyProject('P0110');
    const result = await ensureProjectSchema(store, project.id);

    expect(result.existing).toEqual(
      expect.arrayContaining(['Tasks', 'Ideas', 'Decisions', 'Log']),
    );
    expect(result.created).toEqual(
      expect.arrayContaining(['Overview', 'Rules', 'Next Steps', 'Codebase', 'Usage', 'Bugs', 'Roadmap']),
    );
    expect(result.created).not.toContain('Tasks');
    expect(result.unknown.sort()).toEqual(['Errors', 'Learnings', 'Testing']);
  });

  it('leaves unknown sections completely untouched', async () => {
    const project = await seedLegacyProject('P0111');
    const before = await store.getChildren(project.id);
    const errorsBefore = before.find(c => c.title === 'Errors')!;

    await ensureProjectSchema(store, project.id);

    const after = await store.getChildren(project.id);
    const titles = after.map(c => c.title);
    expect(titles).toContain('Errors');
    expect(titles).toContain('Learnings');
    expect(titles).toContain('Testing');

    const errorsAfter = after.find(c => c.title === 'Errors')!;
    expect(errorsAfter.id).toBe(errorsBefore.id);
    expect(errorsAfter.title).toBe(errorsBefore.title);
    expect(errorsAfter.content).toBe(errorsBefore.content);
    expect(errorsAfter.parentId).toBe(errorsBefore.parentId);
    expect(errorsAfter.updatedAt).toBe(errorsBefore.updatedAt);
  });

  it('does not duplicate a section the user already has under a schema name', async () => {
    const project = await seedLegacyProject('P0112');
    await ensureProjectSchema(store, project.id);
    const children = await store.getChildren(project.id);
    expect(children.filter(c => c.title === 'Tasks')).toHaveLength(1);
    expect(children.filter(c => c.title === 'Log')).toHaveLength(1);
  });

  it('preserves user content written under an existing section', async () => {
    const project = await seedLegacyProject('P0113');
    const tasks = (await store.getChildren(project.id)).find(c => c.title === 'Tasks')!;
    const note = await store.write('Ship the thing', {
      parentId: tasks.id,
      tags: ['#ship', '#release'],
    });

    await ensureProjectSchema(store, project.id);
    const kids = await store.getChildren(tasks.id);
    expect(kids.map(k => k.id)).toContain(note.id);
  });
});

describe('planProjectSchema', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('reports what a repair would add without writing anything', async () => {
    const project = await store.createProject('P0120', { content: 'Demo | Active' });
    const plan = await planProjectSchema(store, project.id);

    expect(plan.created).toContain('Overview');
    expect(plan.created).toContain('Codebase/Modules/Functions');
    // Nothing was written — the project root still has no children.
    expect(await store.getChildren(project.id)).toHaveLength(0);
  });

  it('reports an empty plan once the schema is materialized', async () => {
    const project = await store.createProject('P0121', { content: 'Demo | Active' });
    await ensureProjectSchema(store, project.id);
    const plan = await planProjectSchema(store, project.id);
    expect(plan.created).toEqual([]);
  });
});
