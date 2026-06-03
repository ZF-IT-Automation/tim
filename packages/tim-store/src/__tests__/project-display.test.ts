import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TimStore } from '../store.js';
import {
  cropDisplayName,
  projectDisplayNameFromEntry,
  resolveProjectDisplayName,
  resolveProjectBindingLabel,
} from '../project-display.js';

describe('project-display', () => {
  let dbPath: string;
  let store: TimStore;

  afterEach(() => {
    store?.close();
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('cropDisplayName limits to maxLen including ellipsis', () => {
    expect(cropDisplayName('short')).toBe('short');
    expect(cropDisplayName('abcdefghijklmnopqrst', 20)).toBe('abcdefghijklmnopqrst');
    expect(cropDisplayName('abcdefghijklmnopqrstu', 20)).toBe('abcdefghijklmnopqrs…');
  });

  it('projectDisplayNameFromEntry strips label prefix from title', async () => {
    dbPath = path.join(os.tmpdir(), `tim-pd-${Date.now()}.db`);
    store = new TimStore(dbPath);
    const entry = await store.createProject('P0062', {
      content: 'P0062 — TIM | Active | memory system\nbody',
    });
    expect(projectDisplayNameFromEntry(entry)).toBe('TIM');
  });

  it('resolveProjectDisplayName resolves alias and crops', async () => {
    dbPath = path.join(os.tmpdir(), `tim-pd2-${Date.now()}.db`);
    store = new TimStore(dbPath);
    await store.createProject('P0048', {
      content: 'Its Over 9000 Memory | Active\nx',
      aliases: ['o9k'],
    });
    expect(await resolveProjectDisplayName(store, 'o9k')).toBe('Its Over 9000 Memory');
    expect(await resolveProjectDisplayName(store, 'P0048', 10)).toBe('Its Over …');
  });

  it('resolveProjectBindingLabel returns label — title uncropped', async () => {
    dbPath = path.join(os.tmpdir(), `tim-pd3-${Date.now()}.db`);
    store = new TimStore(dbPath);
    await store.createProject('P0062', {
      content: 'bbbee PM Workflow | Active\nx',
    });
    expect(await resolveProjectBindingLabel(store, 'P0062')).toBe('P0062 — bbbee PM Workflow');
  });
});
