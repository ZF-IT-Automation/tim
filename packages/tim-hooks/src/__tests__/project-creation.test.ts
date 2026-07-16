import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import {
  MODE_ERROR,
  canonicalDirectory,
  createProjectCoordinated,
  preflightProjectDirectory,
  validateMode,
} from '../project-creation.js';

describe('project creation', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-project-creation-'));
    store = new TimStore(path.join(dir, 'tim.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['neither mode', { label: 'P1001' }],
    ['memoryOnly false without a path', { label: 'P1001', memoryOnly: false }],
  ])('rejects %s before creating a project', async (_name, args) => {
    expect(() => validateMode(args)).toThrow(MODE_ERROR);
    await expect(createProjectCoordinated(store, args)).rejects.toThrow(MODE_ERROR);
    expect(await store.loadProject('P1001')).toBeNull();
  });

  it('rejects both modes before creating a project', async () => {
    const args = { label: 'P1001', path: dir, memoryOnly: true } as const;
    expect(() => validateMode(args)).toThrow(MODE_ERROR);
    await expect(createProjectCoordinated(store, args)).rejects.toThrow(MODE_ERROR);
    expect(await store.loadProject('P1001')).toBeNull();
  });

  it.each([
    ['a relative path', 'workspace'],
    ['home shorthand', '~/workspace'],
    ['environment shorthand', '$HOME/workspace'],
  ])('rejects %s before creating a project', async (_name, projectPath) => {
    await expect(createProjectCoordinated(store, {
      label: 'P1002',
      path: projectPath,
    })).rejects.toThrow();
    expect(await store.loadProject('P1002')).toBeNull();
  });

  it('rejects the home directory before creating a project', async () => {
    await expect(createProjectCoordinated(store, {
      label: 'P1003',
      path: os.homedir(),
    })).rejects.toThrow(/home directory/i);
    expect(await store.loadProject('P1003')).toBeNull();
  });

  it('rejects a non-directory before creating a project', async () => {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'not a directory');

    await expect(createProjectCoordinated(store, {
      label: 'P1004',
      path: file,
    })).rejects.toThrow(/directory/i);
    expect(await store.loadProject('P1004')).toBeNull();
  });

  it('rejects caller-owned metadata.path in memory-only mode', async () => {
    await expect(createProjectCoordinated(store, {
      label: 'P1005',
      memoryOnly: true,
      metadata: { path: '/caller/value' },
    })).rejects.toThrow(/metadata\.path/);
    expect(await store.loadProject('P1005')).toBeNull();
  });

  it('creates an intentional memory-only project and preserves normal entry fields', async () => {
    const result = await createProjectCoordinated(store, {
      label: 'P1006',
      content: 'Project body',
      metadata: { name: 'Demo' },
      aliases: ['Demo Alias'],
      memoryOnly: true,
    });

    expect(result).toMatchObject({
      mode: 'memory-only',
      title: 'Project body',
      content: '',
      metadata: {
        kind: 'project',
        label: 'P1006',
        name: 'Demo',
        aliases: ['demo alias'],
      },
    });
    expect(result).toHaveProperty('id');
    expect(result).not.toHaveProperty('projectPath');
    expect(result).not.toHaveProperty('markerPath');
  });

  it('canonicalizes an existing directory through realpath', () => {
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);

    expect(canonicalDirectory(link)).toBe(fs.realpathSync(target));
  });

  it('preflights writability without leaving its unique probe behind', () => {
    preflightProjectDirectory(dir);

    expect(fs.readdirSync(dir).filter(name => name.startsWith('.tim-write-probe.'))).toEqual([]);
  });

  it('rejects a target-local marker before preflight', async () => {
    fs.writeFileSync(path.join(dir, '.tim-project'), '{}');
    const preflight = vi.fn();

    await expect(createProjectCoordinated(store, {
      label: 'P1007',
      path: dir,
    }, { preflight })).rejects.toThrow(/marker already exists/i);
    expect(preflight).not.toHaveBeenCalled();
    expect(await store.loadProject('P1007')).toBeNull();
  });

  it('preflights a bound directory then defers verified marker publication', async () => {
    const preflight = vi.fn();
    const canonical = fs.realpathSync(dir);

    await expect(createProjectCoordinated(store, {
      label: 'P1008',
      path: dir,
    }, { preflight })).rejects.toThrow(
      `Bound project creation requires verified marker publication at ${canonical}`,
    );
    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith(canonical);
    expect(await store.loadProject('P1008')).toBeNull();
  });
});
