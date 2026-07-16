import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore, deriveCounters } from 'tim-store';

const CLI = path.resolve(__dirname, '../../dist/cli.js');

interface StopPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

describe('tim hook claude-stop', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-claude-stop-hook-'));
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
    input: string | StopPayload,
    env: Record<string, string> = {},
  ): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [CLI, 'hook', 'claude-stop'], {
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

  async function seedProject(label: string): Promise<void> {
    const store = new TimStore(dbPath);
    await store.createProject(label, { content: `${label} project` });
    store.close();
  }

  function writeMarker(dir: string, project: string, session = 'hook-stop-sess'): void {
    fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
      version: 2,
      project,
      session,
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    }));
  }

  function writeTranscript(lines: unknown[]): string {
    const file = path.join(cwd, 'transcript.jsonl');
    fs.writeFileSync(
      file,
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    );
    return file;
  }

  it('logs a Unicode exchange through the CLI adapter with exit 0 and empty stdout', async () => {
    await seedProject('P0001');
    writeMarker(cwd, 'P0001');
    const transcript = writeTranscript([
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'sqlite WAL Größe' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Antwort mit Größe' }],
        },
      },
    ]);

    const result = run({
      session_id: 'hook-stop-sess',
      transcript_path: transcript,
      cwd,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');

    const store = new TimStore(dbPath);
    expect((await deriveCounters(store, 'hook-stop-sess')).exchangeCount).toBe(1);
    store.close();
  });

  it('is idempotent across duplicate Stop deliveries', async () => {
    await seedProject('P0001');
    writeMarker(cwd, 'P0001');
    const transcript = writeTranscript([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'once' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'only' } },
    ]);
    const payload = {
      session_id: 'hook-stop-sess',
      transcript_path: transcript,
      cwd,
    };

    expect(run(payload).status).toBe(0);
    expect(run(payload).status).toBe(0);

    const store = new TimStore(dbPath);
    expect((await deriveCounters(store, 'hook-stop-sess')).exchangeCount).toBe(1);
    store.close();
  });

  it('fail-soft: malformed JSON, missing marker, and stop_hook_active produce exit 0 with no stdout', async () => {
    await seedProject('P0001');

    const malformed = run('not-json');
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe('');

    const noMarker = run({
      session_id: 'hook-stop-sess',
      transcript_path: writeTranscript([
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'x' } },
        { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'y' } },
      ]),
      cwd,
    });
    expect(noMarker.status).toBe(0);
    expect(noMarker.stdout).toBe('');

    writeMarker(cwd, 'P0001');
    const recursive = run({
      session_id: 'hook-stop-sess',
      transcript_path: writeTranscript([
        { type: 'user', uuid: 'u2', message: { role: 'user', content: 'again' } },
        { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: 'nope' } },
      ]),
      cwd,
      stop_hook_active: true,
    });
    expect(recursive.status).toBe(0);
    expect(recursive.stdout).toBe('');

    const store = new TimStore(dbPath);
    expect(await store.read('hook-stop-sess')).toBeNull();
    store.close();
  });
});
