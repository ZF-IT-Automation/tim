import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const MAX_STDIN_BYTES = 1024 * 1024;

interface HookPayload {
  session_id?: string;
  prompt?: string;
  cwd?: string;
  [key: string]: unknown;
}

describe('tim hook prompt-submit', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-prompt-submit-hook-'));
    home = path.join(root, 'home');
    cwd = path.join(root, 'workspace');
    dbPath = path.join(root, 'tim.db');
    fs.mkdirSync(home);
    fs.mkdirSync(cwd);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(
    input: string | HookPayload,
    env: Record<string, string> = {},
  ): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [CLI, 'hook', 'prompt-submit'], {
      cwd,
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        TIM_DB_PATH: dbPath,
        TIM_EMBEDDING_DISABLED: '1',
        ...env,
      },
    });
  }

  async function seedProject(label: string, lesson: string): Promise<void> {
    const store = new TimStore(dbPath);
    const project = await store.createProject(label, { content: `${label} project` });
    await store.write(lesson, { parentId: project.id });
    store.close();
  }

  function writeMarker(dir: string, project: string): void {
    fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
      version: 2,
      project,
      session: 'prompt-submit-test',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    }));
  }

  it('emits only the exact Claude UserPromptSubmit envelope for Unicode input', async () => {
    await seedProject('P0001', 'SQLite WAL Größe\nUnicode retrieval context.');
    writeMarker(cwd, 'P0001');

    const result = run({
      session_id: 's-unicode',
      prompt: 'sqlite WAL Größe',
      cwd,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          'TIM erinnert: SQLite WAL Größe — Unicode retrieval context.',
      },
    });
  });

  it('passes only the cwd-local marker project to prompt retrieval', async () => {
    await seedProject('P0001', 'Needle local memory\nKeep this project context.');
    await seedProject('P0002', 'Needle foreign memory\nDo not inject this project context.');
    writeMarker(cwd, 'P0001');

    const result = run({ session_id: 's-local', prompt: 'Needle', cwd });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Needle local memory');
    expect(result.stdout).not.toContain('Needle foreign memory');
  });

  it('does not walk up to a parent marker', async () => {
    const child = path.join(cwd, 'child');
    fs.mkdirSync(child);
    await seedProject('P0001', 'Needle parent memory\nParent-scoped context.');
    await seedProject('P0002', 'Needle global memory\nGlobal context remains visible.');
    writeMarker(cwd, 'P0001');

    const result = run({ session_id: 's-child', prompt: 'Needle', cwd: child });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Needle global memory');
  });

  it('treats shell metacharacters as prompt data without executing them', () => {
    const sentinel = path.join(root, 'shell-interpolation-ran');
    const result = run({
      session_id: 's-shell',
      prompt: `$(touch ${sentinel})`,
      cwd,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it.each([
    ['empty stdin', ''],
    ['malformed JSON', '{"prompt":'],
    ['array JSON', '[]'],
    ['empty prompt', JSON.stringify({ session_id: 's1', prompt: '  ', cwd })],
    ['missing cwd', JSON.stringify({ session_id: 's1', prompt: 'sqlite WAL' })],
  ])('%s exits zero with no output', (_name, input) => {
    const blockedParent = path.join(root, 'not-a-directory');
    fs.writeFileSync(blockedParent, 'store must not be opened');

    const result = run(input, { TIM_DB_PATH: path.join(blockedParent, 'tim.db') });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('rejects JSON stdin larger than 1 MiB without opening the store', () => {
    const blockedParent = path.join(root, 'not-a-directory');
    fs.writeFileSync(blockedParent, 'store must not be opened');
    const oversized = JSON.stringify({
      prompt: 'x'.repeat(MAX_STDIN_BYTES),
      cwd,
    });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_STDIN_BYTES);

    const result = run(oversized, { TIM_DB_PATH: path.join(blockedParent, 'tim.db') });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits zero with no output when prompt submit is disabled', async () => {
    await seedProject('P0001', 'SQLite WAL lesson\nDisabled context.');
    writeMarker(cwd, 'P0001');
    const timDir = path.join(home, '.tim');
    fs.mkdirSync(timDir);
    fs.writeFileSync(
      path.join(timDir, 'config.json'),
      JSON.stringify({ hooks: { promptSubmit: { enabled: false } } }),
    );

    const result = run({ session_id: 's-disabled', prompt: 'sqlite WAL', cwd });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits zero with no output when the store cannot be opened', () => {
    const blockedParent = path.join(root, 'not-a-directory');
    fs.writeFileSync(blockedParent, 'not a directory');

    const result = run(
      { session_id: 's-store-error', prompt: 'sqlite WAL', cwd },
      { TIM_DB_PATH: path.join(blockedParent, 'tim.db') },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
