import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import {
  MODE_ERROR,
  ProjectCreationPartialFailureError,
  canonicalDirectory,
  createProjectCoordinated,
  preflightProjectDirectory,
  recoverProjectBinding,
  validateMode,
  type ProjectCreationArgs,
} from '../project-creation.js';
import { readMarker, writeMarkerExclusive } from '../marker.js';

const preflightIo = vi.hoisted(() => ({
  removeProbeAfterWrite: false,
  uuid: null as string | null,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => preflightIo.uuid ?? actual.randomUUID(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const result = actual.writeFileSync(...args);
      if (preflightIo.removeProbeAfterWrite && String(args[0]).split('/').pop()?.startsWith('.tim-write-probe.')) {
        actual.rmSync(args[0], { force: true });
      }
      return result;
    },
  };
});

describe('project creation', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    preflightIo.removeProbeAfterWrite = false;
    preflightIo.uuid = null;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-project-creation-'));
    const dbDir = path.join(dir, "database dir's");
    fs.mkdirSync(dbDir);
    store = new TimStore(path.join(dbDir, 'custom tim.db'));
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

  it('rejects an empty path as a missing creation mode', async () => {
    const args = { label: 'P1001', path: '' };
    expect(() => validateMode(args)).toThrow(MODE_ERROR);
    await expect(createProjectCoordinated(store, args)).rejects.toThrow(MODE_ERROR);
    expect(await store.loadProject('P1001')).toBeNull();
  });

  it.each([
    ['home shorthand', '~/workspace'],
    ['environment shorthand', '$HOME/workspace'],
    ['braced environment shorthand', '${HOME}/workspace'],
    ['embedded environment shorthand', '/tmp/repo-$HOME'],
    ['embedded braced environment shorthand', '/tmp/repo-${HOME}'],
    ['Windows environment shorthand in an absolute path', '/tmp/%HOME%/workspace'],
  ])('rejects %s before creating a project', async (_name, projectPath) => {
    await expect(createProjectCoordinated(store, {
      label: 'P1002',
      path: projectPath,
    })).rejects.toThrow(/shorthand/);
    expect(await store.loadProject('P1002')).toBeNull();
  });

  it('gives actionable guidance for a relative path', async () => {
    await expect(createProjectCoordinated(store, {
      label: 'P1002',
      path: 'workspace',
    })).rejects.toThrow(/Pass an absolute project path/);
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
    const args = {
      label: 'P1005',
      memoryOnly: true,
      metadata: { path: '/caller/value' },
    } as const;
    expect(() => validateMode(args)).toThrow(/metadata\.path/);
    await expect(createProjectCoordinated(store, args)).rejects.toThrow(/metadata\.path/);
    expect(await store.loadProject('P1005')).toBeNull();
  });

  it('creates an intentional memory-only project and preserves normal entry fields', async () => {
    const metadata: Record<string, unknown> = { name: 'Demo' };
    const args: ProjectCreationArgs = {
      label: 'P1006',
      content: 'Project body',
      metadata,
      aliases: ['Demo Alias'],
      memoryOnly: true,
    };
    const result = await createProjectCoordinated(store, {
      ...args,
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

  it('allows a dollar not followed by an environment variable name', () => {
    const target = path.join(dir, 'cash$5');
    fs.mkdirSync(target);

    expect(canonicalDirectory(target)).toBe(fs.realpathSync(target));
  });

  it('preflights writability without leaving its unique probe behind', () => {
    preflightProjectDirectory(dir);

    expect(fs.readdirSync(dir).filter(name => name.startsWith('.tim-write-probe.'))).toEqual([]);
  });

  it('tolerates a probe that is concurrently absent during cleanup', () => {
    preflightIo.removeProbeAfterWrite = true;

    expect(() => preflightProjectDirectory(dir)).not.toThrow();
  });

  it('preserves a colliding probe that it did not create', () => {
    preflightIo.uuid = 'fixed-probe';
    const probe = path.join(dir, `.tim-write-probe.${process.pid}.fixed-probe`);
    fs.writeFileSync(probe, 'winner');

    expect(() => preflightProjectDirectory(dir)).toThrow(/EEXIST/);
    expect(fs.readFileSync(probe, 'utf8')).toBe('winner');
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

  it('preflights a bound directory before verified marker publication', async () => {
    const preflight = vi.fn();
    const canonical = fs.realpathSync(dir);

    const result = await createProjectCoordinated(store, {
      label: 'P1008',
      path: dir,
    }, { preflight, sessionId: () => 'session-1008' });
    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith(canonical);
    expect(result).toMatchObject({ mode: 'bound', projectPath: canonical });
    expect(readMarker(canonical)?.project).toBe('P1008');
  });

  it('retains the default preflight when an override is explicitly undefined', async () => {
    const canonical = fs.realpathSync(dir);

    const result = await createProjectCoordinated(store, {
      label: 'P1009',
      path: dir,
    }, { preflight: undefined, sessionId: () => 'session-1009' });
    expect(result).toMatchObject({ mode: 'bound', projectPath: canonical });
    expect(fs.readdirSync(dir).filter(name => name.startsWith('.tim-write-probe.'))).toEqual([]);
  });

  it('creates a verified target-local v2 binding at the canonical path', async () => {
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    writeMarkerExclusive(dir, {
      project: 'P1111', session: 'ancestor', exchanges: 1, batch_size: 2, batches_summarized: 3,
    });

    const result = await createProjectCoordinated(store, {
      label: 'P1010',
      content: 'Canonical project',
      path: link,
      metadata: { path: '/caller-must-not-win', name: 'Canonical' },
    }, { sessionId: () => 'injected-session' });
    const canonical = fs.realpathSync(target);

    expect(result).toMatchObject({
      mode: 'bound',
      projectPath: canonical,
      markerPath: path.join(canonical, '.tim-project'),
      metadata: { label: 'P1010', path: canonical, name: 'Canonical' },
    });
    expect(readMarker(canonical)).toEqual({
      version: 2,
      project: 'P1010',
      session: 'injected-session',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    expect(readMarker(dir)?.project).toBe('P1111');
  });

  it('preserves an existing target-local marker and does not mutate the DB', async () => {
    writeMarkerExclusive(dir, {
      project: 'P1011', session: 'winner', exchanges: 4, batch_size: 5, batches_summarized: 6,
    });
    const before = fs.readFileSync(path.join(dir, '.tim-project'), 'utf8');

    await expect(createProjectCoordinated(store, { label: 'P1012', path: dir }))
      .rejects.toThrow(/remove.*rebind|rebind.*remove/i);
    expect(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8')).toBe(before);
    expect(await store.loadProject('P1012')).toBeNull();
  });

  it('leaves no marker when the exact DB label already exists', async () => {
    await store.createProject('P1013');

    await expect(createProjectCoordinated(store, { label: 'P1013', path: dir }))
      .rejects.toThrow(/already exists/i);
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it.each(['not-a-project', 'P9999'])('rejects marker-invalid bound label %s before DB or marker mutation', async (label) => {
    const error = await createProjectCoordinated(store, { label, path: dir })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/invalid project label/i);
    expect((error as Error).message).not.toContain('tim bind-project');
    expect(await store.loadProject(label)).toBeNull();
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('treats a dangling target-local marker symlink as an existing unknown marker', async () => {
    const marker = path.join(dir, '.tim-project');
    fs.symlinkSync(path.join(dir, 'missing-marker-target'), marker);

    await expect(createProjectCoordinated(store, { label: 'P1089', path: dir }))
      .rejects.toThrow(/unknown or corrupt/i);
    expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(marker)).toBe(path.join(dir, 'missing-marker-target'));
    expect(await store.loadProject('P1089')).toBeNull();
  });

  it('treats a special target-local marker pathname as existing without reading it', async () => {
    const marker = path.join(dir, '.tim-project');
    fs.mkdirSync(marker);

    await expect(createProjectCoordinated(store, { label: 'P1088', path: dir }))
      .rejects.toThrow(/unknown or corrupt/i);
    expect(fs.lstatSync(marker).isDirectory()).toBe(true);
    expect(await store.loadProject('P1088')).toBeNull();
  });

  it('leaves no marker when the requested label already resolves as an alias', async () => {
    await store.createProject('P1090', { aliases: ['P1091'] });

    await expect(createProjectCoordinated(store, { label: 'P1091', path: dir }))
      .rejects.toThrow(/already resolves|conflict/i);
    expect(await store.resolveProjectLabel('P1091')).toEqual({ status: 'found', label: 'P1090' });
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('leaves no marker when the requested label resolves ambiguously', async () => {
    await store.createProject('P1092', { aliases: ['P1094'] });
    await store.createProject('P1093', { aliases: ['P1094'] });

    await expect(createProjectCoordinated(store, { label: 'P1094', path: dir }))
      .rejects.toThrow(/ambiguous|conflict/i);
    expect(await store.loadProject('P1094')).toBeNull();
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('leaves no marker when the DB create fails', async () => {
    vi.spyOn(store, 'createProject').mockRejectedValueOnce(new Error('sqlite busy'));

    await expect(createProjectCoordinated(store, { label: 'P1014', path: dir }))
      .rejects.toThrow('sqlite busy');
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('leaves DB and marker unchanged when preflight fails', async () => {
    const preflight = vi.fn(() => { throw new Error('read-only filesystem'); });

    await expect(createProjectCoordinated(store, { label: 'P1015', path: dir }, { preflight }))
      .rejects.toThrow('read-only filesystem');
    expect(await store.loadProject('P1015')).toBeNull();
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('reports a shell-safe recovery command when marker publication fails after DB commit', async () => {
    const quoted = path.join(dir, "repo's worktree");
    fs.mkdirSync(quoted);
    const canonical = fs.realpathSync(quoted);
    const writeExclusive = vi.fn(() => { throw new Error('disk full'); });

    const error = await createProjectCoordinated(store, {
      label: 'P1016', path: quoted,
    }, { writeExclusive }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectCreationPartialFailureError);
    expect(error).toMatchObject({ createdLabel: 'P1016', projectPath: canonical });
    const databasePath = fs.realpathSync(store.getDatabasePath());
    expect((error as Error).message).toContain(
      `TIM_DB_PATH='${databasePath.replaceAll("'", "'\"'\"'")}' tim bind-project`,
    );
    expect((error as Error).message).toContain("tim bind-project --label 'P1016'");
    expect((error as Error).message).toContain(`--cwd '${canonical.replaceAll("'", "'\"'\"'")}'`);
    expect((error as Error).message).toContain('disk full');
    expect(await store.loadProject('P1016')).not.toBeNull();
    expect(fs.existsSync(path.join(canonical, '.tim-project'))).toBe(false);
  });

  it('preserves a racing winner and requires explicit reconciliation without unsafe bind advice', async () => {
    const raceWriter = () => {
      writeMarkerExclusive(dir, {
        project: 'P1018', session: 'winner', exchanges: 0, batch_size: 0, batches_summarized: 0,
      });
      return writeMarkerExclusive(dir, {
        project: 'P1017', session: 'loser', exchanges: 0, batch_size: 0, batches_summarized: 0,
      });
    };

    const error = await createProjectCoordinated(store, {
      label: 'P1017', path: dir,
    }, { writeExclusive: raceWriter }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectCreationPartialFailureError);
    expect((error as Error).message).toMatch(/P1017.*P1018|P1018.*P1017/);
    expect((error as Error).message).toMatch(/reconcil/i);
    expect((error as Error).message).not.toContain('tim bind-project');
    expect(readMarker(dir)?.project).toBe('P1018');
    expect(await store.loadProject('P1017')).not.toBeNull();
  });

  it('reports recovery when publication returns without a readable verified marker', async () => {
    const writeExclusive = vi.fn(() => ({
      version: 2 as const, project: 'P1019', session: 'lost', exchanges: 0, batch_size: 0, batches_summarized: 0,
    }));

    await expect(createProjectCoordinated(store, {
      label: 'P1019', path: dir,
    }, { writeExclusive })).rejects.toThrow(/tim bind-project/);
    expect(await store.loadProject('P1019')).not.toBeNull();
  });

  it('recovers an exact live project binding and is idempotent for the same label', async () => {
    await store.createProject('P1020', { metadata: { path: '/stale' } });

    const first = await recoverProjectBinding(store, {
      label: 'P1020', path: dir, sessionId: 'recovery-session',
    });
    const second = await recoverProjectBinding(store, {
      label: 'P1020', path: dir, sessionId: 'ignored-on-idempotence',
    });

    expect(first).toEqual({
      label: 'P1020', projectPath: fs.realpathSync(dir), markerPath: path.join(fs.realpathSync(dir), '.tim-project'), alreadyBound: false,
    });
    expect(second).toEqual({ ...first, alreadyBound: true });
    expect(readMarker(dir)).toMatchObject({ session: 'recovery-session', batch_size: 5 });
  });

  it('recovery rejects a missing label and never overwrites a different marker', async () => {
    await expect(recoverProjectBinding(store, { label: 'P1021', path: dir }))
      .rejects.toThrow(/not found/i);
    await store.createProject('P1021');
    writeMarkerExclusive(dir, {
      project: 'P1022', session: 'winner', exchanges: 7, batch_size: 8, batches_summarized: 9,
    });
    const before = fs.readFileSync(path.join(dir, '.tim-project'), 'utf8');

    await expect(recoverProjectBinding(store, { label: 'P1021', path: dir }))
      .rejects.toThrow(/P1021.*P1022|P1022.*P1021/);
    expect(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8')).toBe(before);
  });

  it('recovery preserves and rejects a corrupt target-local marker', async () => {
    await store.createProject('P1023');
    const marker = path.join(dir, '.tim-project');
    fs.writeFileSync(marker, '{not json');

    await expect(recoverProjectBinding(store, { label: 'P1023', path: dir }))
      .rejects.toThrow(/unknown or corrupt/i);
    expect(fs.readFileSync(marker, 'utf8')).toBe('{not json');
  });

  it('recovery preserves a marker that wins after its initial local check', async () => {
    await store.createProject('P1024');
    const lateWinner = () => {
      writeMarkerExclusive(dir, {
        project: 'P1025', session: 'winner', exchanges: 2, batch_size: 5, batches_summarized: 1,
      });
      return writeMarkerExclusive(dir, {
        project: 'P1024', session: 'loser', exchanges: 0, batch_size: 5, batches_summarized: 0,
      });
    };

    await expect(recoverProjectBinding(store, { label: 'P1024', path: dir }, {
      writeExclusive: lateWinner,
    })).rejects.toThrow(/P1024.*P1025|P1025.*P1024/);
    expect(readMarker(dir)).toMatchObject({ project: 'P1025', session: 'winner' });
  });
});
