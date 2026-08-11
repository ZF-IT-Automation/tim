import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, TimStore } from 'tim-store';
import { clampSummary } from 'tim-hooks';

const CLI = path.resolve(__dirname, '../../dist/cli.js');

const CONDENSED_SUMMARY = [
  '- Repaired the summarization chain end to end.',
  '- Added a default summarizer config so the CLI chain resolves.',
  '- next: install the SessionStart hook so the briefing is actually emitted.',
].join('\n');

describe('clampSummary', () => {
  it('returns the summary untouched when it fits, keeping line structure', () => {
    expect(clampSummary(CONDENSED_SUMMARY, 500)).toBe(CONDENSED_SUMMARY);
  });

  it('drops the oldest lines, never the handoff at the end', () => {
    const clamped = clampSummary(CONDENSED_SUMMARY, 90);
    expect(clamped).toContain('next: install the SessionStart hook');
    expect(clamped).not.toContain('Repaired the summarization chain');
    expect(clamped.startsWith('…')).toBe(true);
  });

  it('keeps the tail of a single-line summary', () => {
    const clamped = clampSummary('a'.repeat(50) + 'TAIL', 20);
    expect(clamped.endsWith('TAIL')).toBe(true);
    expect(clamped.length).toBeLessThanOrEqual(20);
  });
});

describe('session-start directive carries content', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-session-briefing-'));
    home = path.join(root, 'home');
    cwd = path.join(root, 'workspace');
    dbPath = path.join(root, 'tim.db');
    fs.mkdirSync(home);
    fs.mkdirSync(cwd);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[], input?: string): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      ...(input === undefined ? {} : { input }),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        TIM_DB_PATH: dbPath,
        TIM_MARKER_MAX_ROOT: root,
        TIM_EMBEDDING_DISABLED: '1',
      },
    });
  }

  async function seed(): Promise<void> {
    const store = new TimStore(dbPath);
    const project = await store.createProject('P0063', { content: 'Briefing test project' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-previous',
      projectId: 'P0063',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    await sessions.logExchange('sess-previous', [
      { role: 'user', content: 'do the thing' },
      { role: 'agent', content: 'done' },
    ]);
    await sessions.updateSessionSummary('sess-previous', CONDENSED_SUMMARY);
    await sessions.checkpoint('sess-previous', {
      summarize: async () => 'checkpoint stub',
      handoffNote: 'done: wired the reader | next: watch it render in a live session',
    });
    await store.write('Ship the SessionStart hook', {
      parentId: project.id,
      metadata: { task: { status: 'in_progress', priority: 'high' } },
    });
    await store.write('Already handled', {
      parentId: project.id,
      metadata: { task: { status: 'done' } },
    });
    store.close();
    fs.writeFileSync(
      path.join(cwd, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0063' }),
    );
  }

  it('resolve-project --format directive injects the previous summary and open work', async () => {
    await seed();
    const out = run(['resolve-project', '--cwd', cwd, '--format', 'directive']).stdout;

    expect(out).toContain('── Previous session');
    expect(out).toContain('next: install the SessionStart hook');
    // Handoff note now lives on summary root; briefing reader updates in topic-recall spec.
    expect(out).toContain('── Open work ──');
    expect(out).toContain('Ship the SessionStart hook');
    // Closed tasks are not open work.
    expect(out).not.toContain('Already handled');
    // Binding still has to happen.
    expect(out).toContain('tim_load_project(label="P0063")');
  });

  it('falls back to the checkpoint text when nothing rolled it up into the summary root', async () => {
    // The shape the automatic session-end hook leaves behind: a checkpoint child and
    // an untouched summary root, because only the summarizer writes metadata.summary.
    const store = new TimStore(dbPath);
    await store.createProject('P0065', { content: 'Checkpoint-only project' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-checkpoint-only',
      projectId: 'P0065',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    await sessions.logExchange('sess-checkpoint-only', [
      { role: 'user', content: 'do the thing' },
      { role: 'agent', content: 'done' },
    ]);
    await sessions.checkpoint('sess-checkpoint-only', {
      summarize: async () => 'Session checkpoint: 1 exchange\nTopics: 1. do the thing',
    });
    store.close();
    fs.writeFileSync(
      path.join(cwd, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0065' }),
    );

    const out = run(['resolve-project', '--cwd', cwd, '--format', 'directive']).stdout;
    expect(out).toContain('── Previous session');
    expect(out).toContain('Topics: 1. do the thing');
  });

  it('renders the newest unsummarized turns, not the oldest uncovered batch', async () => {
    // Two uncovered batches is the case that discriminates: a reader that returns the
    // first uncovered batch (what the summarizer wants) would show turns 3-4 and drop
    // the newest ones, which are the turns carrying "next: …".
    const store = new TimStore(dbPath);
    await store.createProject('P0066', { content: 'Raw tail project' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-raw-tail',
      projectId: 'P0066',
      agentName: 'test',
      cwd,
      harness: 'test',
      batchSize: 2,
    });
    for (let turn = 1; turn <= 10; turn++) {
      await sessions.logExchange('sess-raw-tail', [
        { role: 'user', content: `question ${turn}` },
        { role: 'agent', content: `answer ${turn}` },
      ]);
    }
    // Only batch 1 (turns 1-2) ever got summarized; batches 2 and 3 are uncovered.
    await sessions.writeBatchSummary('sess-raw-tail', 1, 'covered turns 1 and 2', {
      seqFrom: 1,
      seqTo: 2,
    });
    store.close();
    fs.writeFileSync(
      path.join(cwd, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0066' }),
    );

    const out = run(['resolve-project', '--cwd', cwd, '--format', 'directive']).stdout;
    expect(out).toContain('not yet summarized');
    expect(out).toContain('question 10');
    expect(out).toContain('answer 10');
    // Eight turns are uncovered, six fit: the cap drops the oldest of them.
    expect(out).toContain('question 5');
    expect(out).not.toContain('question 4');
    // Summarized turns are not repeated raw.
    expect(out).not.toContain('question 2');
  });

  it('falls back to the instruction-only directive when the project has no history', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0064', { content: 'Empty project' });
    store.close();
    fs.writeFileSync(
      path.join(cwd, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0064' }),
    );

    const out = run(['resolve-project', '--cwd', cwd, '--format', 'directive']).stdout;
    expect(out).toContain('tim_load_project(label="P0064")');
    expect(out).not.toContain('── Previous session');
    expect(out).not.toContain('── Open work ──');
  });
});

describe('tim hook claude-session-start', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-claude-session-start-'));
    home = path.join(root, 'home');
    cwd = path.join(root, 'workspace');
    dbPath = path.join(root, 'tim.db');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(cwd, 'nested'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(input: string): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [CLI, 'hook', 'claude-session-start'], {
      cwd,
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        TIM_DB_PATH: dbPath,
        TIM_MARKER_MAX_ROOT: root,
        TIM_EMBEDDING_DISABLED: '1',
      },
    });
  }

  it('emits a Claude SessionStart envelope with the directive as additionalContext', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0063', { content: 'Hook test project' });
    store.close();
    fs.writeFileSync(
      path.join(cwd, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0063' }),
    );

    const result = run(JSON.stringify({ hook_event_name: 'SessionStart', cwd }));
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'tim_load_project(label="P0063")',
    );
  });

  it('walks up from a subdirectory of the marked repo', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0063', { content: 'Hook test project' });
    store.close();
    fs.writeFileSync(
      path.join(cwd, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0063' }),
    );

    const result = run(JSON.stringify({ cwd: path.join(cwd, 'nested') }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('P0063');
  });

  it('stays silent and exits 0 without a marker or with unusable stdin', () => {
    const noMarker = run(JSON.stringify({ cwd }));
    expect(noMarker.status).toBe(0);
    expect(noMarker.stdout.trim()).toBe('');

    const garbage = run('not json');
    expect(garbage.status).toBe(0);
    expect(garbage.stdout.trim()).toBe('');
  });
});
