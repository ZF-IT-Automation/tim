import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_SCHEMA } from 'tim-core';
import { TimStore, ensureProjectForPath, ensureProjectSchema } from 'tim-store';
import { createProjectCoordinated } from '../project-creation.js';

/** Section titles the schema materializes at the project root (managed ones excluded). */
const EXPECTED_TOP_LEVEL = PROJECT_SCHEMA.sections
  .filter(s => !s.managed)
  .map(s => s.name);

async function topLevelSectionTitles(store: TimStore, projectId: string): Promise<string[]> {
  const children = await store.getChildren(projectId);
  return children.filter(c => c.metadata.kind === 'section').map(c => c.title);
}

const TEST_ROOT = path.resolve(import.meta.dirname, '../../../../tmp');

describe('project creation paths converge on the schema', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    // In the repo's gitignored tmp/, not /tmp and not $HOME: ensureProjectForPath
    // refuses to auto-create under /tmp, and $HOME is itself /tmp/… under a scratch HOME.
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'tim-test-schema-converge-'));
    store = new TimStore(path.join(dir, 'tim.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('createProjectCoordinated (bound) materializes the schema', async () => {
    const target = path.join(dir, 'bound');
    fs.mkdirSync(target);
    const result = await createProjectCoordinated(store, { label: 'P1201', path: target });

    expect(await topLevelSectionTitles(store, result.id)).toEqual(EXPECTED_TOP_LEVEL);
  });

  it('createProjectCoordinated (memory-only) materializes the schema', async () => {
    const result = await createProjectCoordinated(store, { label: 'P1202', memoryOnly: true });
    expect(await topLevelSectionTitles(store, result.id)).toEqual(EXPECTED_TOP_LEVEL);
  });

  it('ensureProjectForPath materializes the same schema', async () => {
    const target = path.join(dir, 'auto-created');
    fs.mkdirSync(target);
    const auto = await ensureProjectForPath(store, target);

    expect(auto?.created).toBe(true);
    expect(await topLevelSectionTitles(store, auto!.entry.id)).toEqual(EXPECTED_TOP_LEVEL);
  });

  it('all three paths produce identical section trees', async () => {
    const boundDir = path.join(dir, 'p-bound');
    const autoDir = path.join(dir, 'p-auto');
    fs.mkdirSync(boundDir);
    fs.mkdirSync(autoDir);

    const bound = await createProjectCoordinated(store, { label: 'P1203', path: boundDir });
    const memory = await createProjectCoordinated(store, { label: 'P1204', memoryOnly: true });
    const auto = (await ensureProjectForPath(store, autoDir))!;

    // Compare the full nested shape, not just the top level.
    const shape = async (id: string): Promise<string[]> => {
      const out: string[] = [];
      const walk = async (parentId: string, prefix: string): Promise<void> => {
        for (const child of await store.getChildren(parentId)) {
          if (child.metadata.kind !== 'section') continue;
          const label = prefix ? `${prefix}/${child.title}` : child.title;
          out.push(label);
          await walk(child.id, label);
        }
      };
      await walk(id, '');
      return out;
    };

    const boundShape = await shape(bound.id);
    expect(await shape(memory.id)).toEqual(boundShape);
    expect(await shape(auto.entry.id)).toEqual(boundShape);
    expect(boundShape).toContain('Codebase/Modules/Functions');
  });

  it('re-running ensureProjectSchema over a created project adds nothing', async () => {
    const result = await createProjectCoordinated(store, { label: 'P1205', memoryOnly: true });
    const again = await ensureProjectSchema(store, result.id);
    expect(again.created).toEqual([]);
    expect(await topLevelSectionTitles(store, result.id)).toEqual(EXPECTED_TOP_LEVEL);
  });
});
