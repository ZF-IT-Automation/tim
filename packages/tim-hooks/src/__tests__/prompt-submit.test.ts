import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import * as timCore from 'tim-core';
import { recallUnits, runPromptSubmit } from '../prompt-submit.js';

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
    expect(result!.lines.some(l => l.startsWith('TIM erinnert ('))).toBe(true);
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
    expect(result!.lines.some(l => /TIM erinnert \(\d{4}-\d{2}-\d{2}\): SQLite tips/.test(l))).toBe(true);
    expect(result!.lines.some(l => l.includes('task-notification'))).toBe(false);
  });

  it('keeps transcript turns out of recall and drops duplicate lines', async () => {
    await store.write('Ja, mach mal. Nodes per SQL weghauen, PDCA loop.', {
      metadata: { kind: 'exchange', role: 'user' },
    });
    await store.write('Session checkpoint\nTopics: PDCA loop', { metadata: { kind: 'checkpoint' } });
    await store.write('PDCA loop rules\nEach loop iteration rescored.', { metadata: { kind: 'decision' } });

    const result = await runPromptSubmit(store, { prompt: 'Wir sind in einem PDCA loop', timeoutMs: 5000 });
    expect(result!.lines).toHaveLength(1);
    expect(result!.lines[0]).toContain('PDCA loop rules');

    const rule = (await store.search({ query: 'PDCA', topK: 5 })).find(e => e.title.startsWith('PDCA loop rules'))!;
    vi.spyOn(store, 'search').mockResolvedValue([rule, rule]);
    expect((await runPromptSubmit(store, { prompt: 'PDCA loop' }))!.lines).toHaveLength(1);
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
  describe('with Jev', () => {
    const summary = [
      '- **Soak:** 20h stable, RSS 116 MB.',
      '- **WorldClock:** Decay now runs on WorldClock events; stopped clocks cause no decay.',
      '- **Open:** review large clock jumps.',
    ].join('\n');

    async function twoHits() {
      const batch = await store.write(`Batch 2\n${summary}`, { metadata: { kind: 'batch-summary' } });
      const noise = await store.write('Ledger hash for iteration 3\nNothing else.', { metadata: { kind: 'commit' } });
      vi.spyOn(store, 'search').mockResolvedValue([noise, batch]);
      return { batch, noise };
    }

    it('keeps only hits Jev judges relevant and shows the part it picked', async () => {
      const { batch } = await twoHits();
      const ask = vi.spyOn(timCore, 'askJev').mockImplementation(async (_c, state) => {
        const relevant = String((state as { memory: string }).memory).startsWith('Batch 2');
        return relevant
          ? { rel: { type: 'noul', noul: 0.9 }, focus: { type: 'choice', choice: 's1', probabilities: {}, confidence: 0.95 } }
          : { rel: { type: 'noul', noul: 0.1 } };
      });

      const result = await runPromptSubmit(store, { prompt: 'decay an die worldclock knüpfen', jev: true });
      expect(ask).toHaveBeenCalledTimes(2);
      expect(result!.lines).toHaveLength(1);
      expect(result!.lines[0]).toContain('Decay now runs on WorldClock events');
      expect(result!.lines[0]).not.toContain('Soak');
      expect(result!.lines[0]).toContain(`[${batch.id}]`);
    });

    it('stays silent when Jev finds nothing relevant', async () => {
      await twoHits();
      vi.spyOn(timCore, 'askJev').mockResolvedValue({ rel: { type: 'noul', noul: 0.2 } });
      expect(await runPromptSubmit(store, { prompt: 'decay worldclock', jev: true })).toBeNull();
    });

    it('falls back to the plain lines when Jev does not answer', async () => {
      await twoHits();
      vi.spyOn(timCore, 'askJev').mockResolvedValue(null);
      const result = await runPromptSubmit(store, { prompt: 'decay worldclock', jev: true });
      expect(result!.lines).toHaveLength(2);
      expect(result!.lines[0]).toContain('Ledger hash');
    });

    it('never sends secret entries to Jev', async () => {
      const secret = await store.write('Vault note\nroot password is hunter2', { metadata: { kind: 'note', secret: true } });
      vi.spyOn(store, 'search').mockResolvedValue([secret]);
      const ask = vi.spyOn(timCore, 'askJev');
      await runPromptSubmit(store, { prompt: 'vault password note', jev: true });
      expect(ask).not.toHaveBeenCalled();
    });

    it('does not call Jev unless enabled', async () => {
      await twoHits();
      const ask = vi.spyOn(timCore, 'askJev');
      await runPromptSubmit(store, { prompt: 'decay worldclock' });
      expect(ask).not.toHaveBeenCalled();
    });

    it('splits summaries at bullets and prose at sentences, not at German abbreviations', () => {
      expect(recallUnits(summary)).toHaveLength(3);
      expect(recallUnits('Wir nutzen z. B. die API ggf. mit v1.2.3 weiter. Danach kommt der Rest vom Plan.')).toEqual([
        'Wir nutzen z. B. die API ggf. mit v1.2.3 weiter.',
        'Danach kommt der Rest vom Plan.',
      ]);
    });
  });
});
