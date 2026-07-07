import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from '../store.js';
import { charsToTokens, estimateProjectTokens } from '../token-budget.js';

describe('token budget', () => {
  let dbPath: string;
  let store: TimStore;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tim-tok-')), 'tim.db');
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('charsToTokens uses 4 chars per token', () => {
    expect(charsToTokens(400)).toBe(100);
  });

  it('estimateProjectTokens sums subtree chars', async () => {
    const project = await store.write('body', {
      title: 'P0099 Test Project',
      metadata: { kind: 'project', label: 'P0099' },
    });
    await store.write('x'.repeat(400), { parentId: project.id, title: 'child' });
    const est = await estimateProjectTokens(store, 'P0099', 50);
    expect(est).not.toBeNull();
    expect(est!.estTokens).toBeGreaterThan(90);
    expect(est!.overBriefingBudget).toBe(true);
  });
});
