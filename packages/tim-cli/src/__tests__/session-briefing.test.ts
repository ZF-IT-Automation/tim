import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, TimStore } from 'tim-store';
import { clampSummary, collectDirectiveBriefing, buildNowBlock } from 'tim-hooks';

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

  // The collector, called the way the deliberate path calls it. The automatic
  // path is the subprocess above; wiring it to `true` must break the test below.
  async function pastWorkBriefing(projectLabel: string) {
    const store = new TimStore(dbPath);
    try {
      return await collectDirectiveBriefing(store, projectLabel, 4000, true);
    } finally {
      store.close();
    }
  }

  it('resolve-project --format directive carries open work but no past work', async () => {
    await seed();
    const out = run(['resolve-project', '--cwd', cwd, '--format', 'directive']).stdout;

    // Criterion 8: the automatic session start stops asking for past work. The
    // previous session was picked by recency alone, so it was noise in every
    // session that was about something else. /tim-continue renders it on demand.
    expect(out).not.toContain('── Previous session');
    expect(out).not.toContain('next: install the SessionStart hook');
    expect(out).not.toContain('question 10');

    // Structure and open work stay — they are what a fresh session needs.
    expect(out).toContain('── Open work ──');
    expect(out).toContain('Ship the SessionStart hook');
    // Closed tasks are not open work.
    expect(out).not.toContain('Already handled');
    // Binding still has to happen.
    expect(out).toContain('tim_load_project(label="P0063")');
  });

  it('the same collector still returns past work when asked for it deliberately', async () => {
    await seed();
    const briefing = await pastWorkBriefing('P0063');

    expect(briefing?.previousSessionSummary).toContain('next: install the SessionStart hook');
    expect(briefing?.openWork?.join('\n')).toContain('Ship the SessionStart hook');
  });

  it('reads handoff note from summary root metadata (checkpoint path)', async () => {
    await seed();
    const briefing = await pastWorkBriefing('P0063');
    expect(briefing?.previousSessionSummary).toContain(
      'handoff: done: wired the reader | next: watch it render in a live session',
    );
  });

  it('skips a trivial newest session and shows the prior substantive one', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0070', { content: 'trivial skip project' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-substantive',
      projectId: 'P0070',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    for (let i = 1; i <= 3; i++) {
      await sessions.logExchange('sess-substantive', [
        { role: 'user', content: `question ${i}` },
        { role: 'agent', content: `answer ${i}` },
      ]);
    }
    await sessions.updateSessionSummary('sess-substantive', '- substantive work done');
    await sessions.startProjectSession({
      sessionId: 'sess-trivial',
      projectId: 'P0070',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    await sessions.logExchange('sess-trivial', [
      { role: 'user', content: 'update mal claude code' },
      { role: 'agent', content: 'ok' },
    ]);
    store.close();

    const briefing = await pastWorkBriefing('P0070');
    expect(briefing?.trivialSessionNote).toBeUndefined();
    expect(briefing?.previousSessionSummary).toContain('substantive work done');
    expect(briefing?.previousSessionSummary).not.toContain('update mal claude code');
  });

  it('renders latest handoff from an older session when shown session differs', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0071', { content: 'handoff older project' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-with-handoff',
      projectId: 'P0071',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    for (let i = 1; i <= 3; i++) {
      await sessions.logExchange('sess-with-handoff', [
        { role: 'user', content: `q${i}` },
        { role: 'agent', content: `a${i}` },
      ]);
    }
    await sessions.checkpoint('sess-with-handoff', {
      handoffNote: 'done: memory program | next: briefing loop',
    });
    await sessions.updateSessionSummary('sess-with-handoff', '- older substantive session');

    await sessions.startProjectSession({
      sessionId: 'sess-newer-no-handoff',
      projectId: 'P0071',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    for (let i = 1; i <= 3; i++) {
      await sessions.logExchange('sess-newer-no-handoff', [
        { role: 'user', content: `n${i}` },
        { role: 'agent', content: `m${i}` },
      ]);
    }
    await sessions.updateSessionSummary('sess-newer-no-handoff', '- newer substantive, no handoff');

    await sessions.startProjectSession({
      sessionId: 'sess-trivial-2',
      projectId: 'P0071',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    await sessions.logExchange('sess-trivial-2', [
      { role: 'user', content: 'tiny' },
      { role: 'agent', content: 'ok' },
    ]);
    store.close();

    const briefing = await pastWorkBriefing('P0071');
    expect(briefing?.previousSessionSummary).toContain('newer substantive, no handoff');
    expect(briefing?.latestHandoffNote).toContain('memory program');
    expect(briefing?.latestHandoffLabel).toBeTruthy();
    expect(briefing?.trivialSessionNote).toBeUndefined();
  });

  it('finds the substantive session and the handoff behind a burst of 60 short sessions', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0074', { content: 'burst project' });
    const sessions = new SessionManager(store);
    const start = (id: string) => sessions.startProjectSession({
      sessionId: id, projectId: 'P0074', agentName: 'test', cwd, harness: 'test',
    });
    await start('sess-real');
    for (let i = 1; i <= 3; i++) {
      await sessions.logExchange('sess-real', [
        { role: 'user', content: `q${i}` },
        { role: 'agent', content: `a${i}` },
      ]);
    }
    await sessions.checkpoint('sess-real', { handoffNote: 'done: burst test | next: keep going' });
    await sessions.updateSessionSummary('sess-real', '- the real work');
    for (let i = 0; i < 60; i++) {
      await start(`sess-auto-${i}`);
      await sessions.logExchange(`sess-auto-${i}`, [
        { role: 'user', content: 'summarize this' },
        { role: 'agent', content: 'ok' },
      ]);
    }
    store.close();

    const briefing = await pastWorkBriefing('P0074');
    expect(briefing?.previousSessionSummary).toContain('the real work');
  });

  it('still shows the newest handoff when no session qualifies as substantive', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0075', { content: 'handoff-only project' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-short-handoff-src', projectId: 'P0075', agentName: 'test', cwd, harness: 'test',
    });
    await sessions.logExchange('sess-short-handoff-src', [
      { role: 'user', content: 'q' },
      { role: 'agent', content: 'a' },
    ]);
    await sessions.checkpoint('sess-short-handoff-src', { handoffNote: 'done: x | next: y' });
    await sessions.startProjectSession({
      sessionId: 'sess-short-2', projectId: 'P0075', agentName: 'test', cwd, harness: 'test',
    });
    await sessions.logExchange('sess-short-2', [
      { role: 'user', content: 'tiny' },
      { role: 'agent', content: 'ok' },
    ]);
    store.close();

    const briefing = await pastWorkBriefing('P0075');
    // The handoff session itself is substantive (handoff note) and is shown as previous session;
    // either way the note must reach the agent.
    const text = `${briefing?.previousSessionSummary ?? ''} ${briefing?.latestHandoffNote ?? ''}`;
    expect(text).toContain('next: y');
  });

  it('shows newest project handoff with age label even when older than 30 days', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0072', { content: 'old handoff project' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-old-handoff',
      projectId: 'P0072',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    for (let i = 1; i <= 3; i++) {
      await sessions.logExchange('sess-old-handoff', [
        { role: 'user', content: `old q${i}` },
        { role: 'agent', content: `old a${i}` },
      ]);
    }
    await sessions.checkpoint('sess-old-handoff', {
      handoffNote: 'done: September handoff | next: resume briefing loop',
    });
    await sessions.updateSessionSummary('sess-old-handoff', '- older session with handoff');
    const oldSession = await store.read('sess-old-handoff');
    if (oldSession) {
      await store.update('sess-old-handoff', {
        metadata: {
          ...oldSession.metadata,
          date: '2026-09-09',
        },
      });
    }

    await sessions.startProjectSession({
      sessionId: 'sess-new-substantive',
      projectId: 'P0072',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    for (let i = 1; i <= 4; i++) {
      await sessions.logExchange('sess-new-substantive', [
        { role: 'user', content: `new q${i}` },
        { role: 'agent', content: `new a${i}` },
      ]);
    }
    await sessions.updateSessionSummary('sess-new-substantive', '- newest substantive, no handoff');
    store.close();

    const briefing = await pastWorkBriefing('P0072');
    expect(briefing?.previousSessionSummary).toContain('newest substantive, no handoff');
    expect(briefing?.latestHandoffNote).toContain('September handoff');
    expect(briefing?.latestHandoffLabel).toMatch(/2026-09-09 · \d+d ago/);
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
    for (let i = 1; i <= 3; i++) {
      await sessions.logExchange('sess-checkpoint-only', [
        { role: 'user', content: `do the thing ${i}` },
        { role: 'agent', content: `done ${i}` },
      ]);
    }
    await sessions.checkpoint('sess-checkpoint-only', {
      summarize: async () => 'Session checkpoint: 1 exchange\nTopics: 1. do the thing',
    });
    store.close();
    fs.writeFileSync(
      path.join(cwd, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0065' }),
    );

    const briefing = await pastWorkBriefing('P0065');
    expect(briefing?.previousSessionSummary).toContain('Topics: 1. do the thing');
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

    const raw = (await pastWorkBriefing('P0066'))?.recentExchanges?.join('\n') ?? '';
    expect(raw).toContain('question 10');
    expect(raw).toContain('answer 10');
    // Eight turns are uncovered, six fit: the cap drops the oldest of them.
    expect(raw).toContain('question 5');
    expect(raw).not.toContain('question 4');
    // Summarized turns are not repeated raw.
    expect(raw).not.toContain('question 2');
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

// The briefing's source cascade ends at the batch summaries. Measured across 336
// sessions in the live database: 45 have no rollup, 35 of those have no usable
// checkpoint either, and for 13 of them the raw tail is empty too — every
// exchange is already covered by a batch summary. Those 13 produced an entirely
// empty briefing while carrying up to 3010 characters of summaries nothing read.
describe('briefing falls back to batch summaries when a session has no rollup', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-briefing-fallback-'));
    dbPath = path.join(root, 'tim.db');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function seedBatchesOnly(): Promise<void> {
    const store = new TimStore(dbPath);
    await store.createProject('P0064', { content: 'fallback test project' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-nobody-rolled-up',
      projectId: 'P0064',
      agentName: 'test',
      cwd: root,
      harness: 'test',
      batchSize: 2,
    });
    // Every exchange covered by the batch summary below, so the raw tail — the
    // last thing the cascade could have fallen back to — is empty.
    for (let i = 1; i <= 3; i++) {
      await sessions.logExchange('sess-nobody-rolled-up', [
        { role: 'user', content: `question ${i}` },
        { role: 'agent', content: `answer ${i}` },
      ]);
    }
    await sessions.writeBatchSummary(
      'sess-nobody-rolled-up', 1,
      'BATCH ONE: the parser was rewritten', { seqFrom: 1, seqTo: 2 }, ['#parser'],
    );
    await sessions.writeBatchSummary(
      'sess-nobody-rolled-up', 2,
      'BATCH TWO: and then the tests were fixed', { seqFrom: 3, seqTo: 3 }, ['#parser'],
    );
    // No updateSessionSummary and no checkpoint: that is the whole point.
    store.close();
  }

  it('uses the batch summaries instead of returning nothing', async () => {
    await seedBatchesOnly();
    const store = new TimStore(dbPath);
    try {
      const briefing = await collectDirectiveBriefing(store, 'P0064', 4000, true);
      const text = JSON.stringify(briefing);
      expect(text).toContain('BATCH ONE');
      expect(text).toContain('BATCH TWO');
    } finally {
      store.close();
    }
  });

  it('keeps them in the order they happened', async () => {
    await seedBatchesOnly();
    const store = new TimStore(dbPath);
    try {
      const briefing = await collectDirectiveBriefing(store, 'P0064', 4000, true);
      const text = JSON.stringify(briefing);
      expect(text.indexOf('BATCH ONE')).toBeLessThan(text.indexOf('BATCH TWO'));
    } finally {
      store.close();
    }
  });
});

describe('handoff lookup (review #5)', () => {
  let root: string;
  let cwd: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-handoff-lookup-'));
    cwd = path.join(root, 'workspace');
    dbPath = path.join(root, 'tim.db');
    fs.mkdirSync(cwd);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('orders sessions by exchanges and handoffs, not repeat checkpoints', async () => {
    const store = new TimStore(dbPath);
    const sessions = new SessionManager(store);
    const project = await store.createProject('P0096', { content: 'activity order' });
    for (const id of ['sess-old', 'sess-new']) {
      await sessions.startProjectSession({ sessionId: id, projectId: 'P0096', agentName: 'test', cwd, harness: 'test' });
      await sessions.logExchange(id, [{ role: 'user', content: `work in ${id}` }, { role: 'agent', content: 'ok' }]);
    }
    const order = () => store.listProjectSessionsByActivity(project.id, 10).map(r => r.id);

    await sessions.checkpoint('sess-old', {});
    expect(order()).toEqual(['sess-new', 'sess-old']);

    await sessions.checkpoint('sess-old', { handoffNote: 'next: resume here' });
    expect(order()).toEqual(['sess-old', 'sess-new']);
    store.close();
  });

  it('puts a triage instruction above stale tasks, and tim_verify clears it', async () => {
    const store = new TimStore(dbPath);
    const project = await store.createProject('P0095', { content: 'stale triage' });
    const task = await store.write('Old plan', {
      parentId: project.id,
      metadata: { task: { status: 'todo', priority: 'high' } },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 30 * 86400_000);
      const stale = (await buildNowBlock(store, 'P0095')).join('\n');
      expect(stale).toMatch(/Stale = untouched[^\n]*\n- \[todo, high\] Old plan · stale since/);
      expect(stale).toContain('tim_verify');

      await store.touchVerified([task.id]);
      expect((await buildNowBlock(store, 'P0095')).join('\n')).not.toContain('Stale =');
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

  it('says so when a project has no open work and no handoff', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0097', { content: 'empty project' });
    const now = (await buildNowBlock(store, 'P0097')).join('\n');
    expect(now).toContain('── Now ──');
    expect(now).toContain('No open work or handoff recorded');
    store.close();
  });

  it('finds handoff in a zero-exchange session via buildNowBlock', async () => {
    const store = new TimStore(dbPath);
    const sessions = new SessionManager(store);
    await store.createProject('P0099', { content: 'zero exchange handoff' });
    await sessions.startProjectSession({
      sessionId: 'sess-zero-handoff',
      projectId: 'P0099',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    await sessions.checkpoint('sess-zero-handoff', {
      handoffNote: 'done: setup only | next: log first exchange',
    });
    const now = await buildNowBlock(store, 'P0099');
    expect(now.join('\n')).toContain('setup only');
    store.close();
  });

  it('finds handoff stored only on a legacy checkpoint child', async () => {
    const store = new TimStore(dbPath);
    const sessions = new SessionManager(store);
    const { findChildByKind, KIND_SUMMARY_ROOT } = await import('tim-store');
    await store.createProject('P0098', { content: 'legacy child handoff' });
    await sessions.startProjectSession({
      sessionId: 'sess-legacy-child',
      projectId: 'P0098',
      agentName: 'test',
      cwd,
      harness: 'test',
    });
    await sessions.logExchange('sess-legacy-child', [
      { role: 'user', content: 'one turn' },
      { role: 'agent', content: 'ok' },
    ]);
    const summaryRoot = await findChildByKind(store, 'sess-legacy-child', KIND_SUMMARY_ROOT);
    expect(summaryRoot).toBeTruthy();
    await store.write('legacy checkpoint', {
      parentId: summaryRoot!.id,
      metadata: { kind: 'checkpoint', handoff_note: 'legacy child-only note' },
    });
    await store.update(summaryRoot!.id, {
      metadata: { ...summaryRoot!.metadata, handoff_note: undefined },
    });
    const now = await buildNowBlock(store, 'P0098');
    expect(now.join('\n')).toContain('legacy child-only note');
    store.close();
  });
});
