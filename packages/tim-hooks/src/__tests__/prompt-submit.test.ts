import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import { runPromptSubmit } from '../prompt-submit.js';

const LIVE_TASK_NOTIFICATION =
  '<task-notification><status>completed</status></task-notification>';

describe('runPromptSubmit', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-prompt-submit-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('injects top retrieval hits as TIM erinnert lines', async () => {
    const lesson = await store.write('SQLite WAL mode pitfalls\nAlways enable WAL.', {
      tags: ['#sqlite', '#db'],
      metadata: { kind: 'lesson' },
    });

    vi.spyOn(store, 'search').mockResolvedValue([lesson]);

    const result = await runPromptSubmit(store, { prompt: 'sqlite WAL database' });
    expect(result).not.toBeNull();
    expect(result!.lines.some(l => l.startsWith('TIM erinnert:'))).toBe(true);
    expect(result!.context).toMatch(/sqlite|WAL/i);
  });

  it('appends guard warnings for action-like prompts', async () => {
    await store.write('rmapi upload failed\nToken expired.', {
      tags: ['#error', '#rmapi'],
      metadata: { kind: 'error' },
    });

    vi.spyOn(store, 'search').mockResolvedValue([]);
    vi.spyOn(store, 'searchFailures').mockResolvedValue([
      {
        id: 'E0001',
        title: 'rmapi upload failed',
        content: 'Token expired.',
        parentId: null,
        contentType: 'text',
        depth: 1,
        confidence: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        decayRate: 0,
        visibility: 1,
        tags: ['#error'],
        irrelevant: false,
        favorite: false,
        tombstonedAt: null,
        metadata: { kind: 'error' },
      },
    ]);

    const result = await runPromptSubmit(store, { prompt: 'upload PDF via rmapi now' });
    expect(result).not.toBeNull();
    expect(result!.lines.some(l => l.includes('TIM guard'))).toBe(true);
    expect(result!.context).toMatch(/E0001/);
  });

  it('returns null on timeout skip', async () => {
    vi.spyOn(store, 'search').mockImplementation(() => new Promise(() => {}));

    const result = await runPromptSubmit(store, {
      prompt: 'slow query test',
      timeoutMs: 50,
    });
    expect(result).toBeNull();
  });

  it('filters harness hits before applying top-K (m6)', async () => {
    const harnessHits = await Promise.all(
      Array.from({ length: 3 }, (_, i) => store.write(`harness ${i}`, {
        metadata: { kind: 'exchange', role: 'user', system_turn: true },
        content: '<task-notification>background task completed output</task-notification>',
      })),
    );
    const lesson = await store.write('Real match\nWorker output paths documented.', {
      tags: ['#worker'],
      metadata: { kind: 'lesson' },
    });
    const searchSpy = vi.spyOn(store, 'search').mockResolvedValue([...harnessHits, lesson]);

    const result = await runPromptSubmit(store, {
      prompt: 'background task completed output paths',
    });
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ topK: 12 }));
    expect(result).not.toBeNull();
    expect(result!.lines.some(l => l.includes('Real match'))).toBe(true);
    expect(result!.lines.length).toBeLessThanOrEqual(3);
  });

  it('skips harness-only prompts and flagged exchange hits', async () => {
    const harness = await store.write(LIVE_TASK_NOTIFICATION, {
      metadata: { kind: 'exchange', role: 'user', system_turn: true },
    });
    const lesson = await store.write('SQLite tips\nEnable WAL.', {
      tags: ['#sqlite'],
      metadata: { kind: 'lesson' },
    });

    vi.spyOn(store, 'search').mockResolvedValue([harness, lesson]);

    const harnessOnly = await runPromptSubmit(store, {
      prompt: '<task-notification><status>done</status></task-notification>',
    });
    expect(harnessOnly).toBeNull();

    const result = await runPromptSubmit(store, { prompt: 'sqlite WAL tuning' });
    expect(result).not.toBeNull();
    expect(result!.lines.some(l => l.includes('TIM erinnert: SQLite tips'))).toBe(true);
    expect(result!.lines.some(l => l.includes('task-notification'))).toBe(false);
  });

  it('drops transcript turns and duplicate lines', async () => {
    const oldPrompt = await store.write('Ja, mach mal. Nodes per SQL weghauen, wir sind fertig.', {
      metadata: { kind: 'exchange', role: 'user' },
    });
    const echo = await store.write('Session checkpoint\nTopics: PDCA loop', {
      metadata: { kind: 'checkpoint' },
    });
    const rule = await store.write('PDCA loop rules\nEach loop iteration rescored.', {
      metadata: { kind: 'decision' },
    });
    vi.spyOn(store, 'search').mockResolvedValue([oldPrompt, echo, rule, rule]);

    const result = await runPromptSubmit(store, { prompt: 'Wir sind in einem PDCA loop' });
    expect(result!.lines).toHaveLength(1);
    expect(result!.lines[0]).toContain('PDCA loop rules');
  });

  it('returns null when disabled via config', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({
      dbPath: ':memory:',
      deviceId: '',
      hooks: { promptSubmit: { enabled: false } },
    });

    const result = await runPromptSubmit(store, { prompt: 'anything' });
    expect(result).toBeNull();
  });
});
