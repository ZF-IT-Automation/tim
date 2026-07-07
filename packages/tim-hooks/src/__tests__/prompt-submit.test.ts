import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import { runPromptSubmit } from '../prompt-submit.js';

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
