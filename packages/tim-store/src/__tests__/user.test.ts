import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from '../store.js';
import {
  ensureHumanProfile,
  getHumanProfileSummary,
  HUMAN_ROOT_LABEL,
  HUMAN_SECTIONS,
} from '../user.js';

describe('human profile', () => {
  let dbPath: string;
  let store: TimStore;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tim-user-')), 'tim.db');
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('ensureHumanProfile creates H0000 root and sections', async () => {
    const profile = await ensureHumanProfile(store);
    expect(profile.root.title).toBe(HUMAN_ROOT_LABEL);
    expect(profile.root.metadata.kind).toBe('human');
    expect(profile.sections).toHaveLength(HUMAN_SECTIONS.length);
    const again = await ensureHumanProfile(store);
    expect(again.sections).toHaveLength(HUMAN_SECTIONS.length);
  });

  it('getHumanProfileSummary lists section child counts', async () => {
    await ensureHumanProfile(store);
    const summary = await getHumanProfileSummary(store);
    expect(summary).toContain(HUMAN_ROOT_LABEL);
    expect(summary).toContain('Identity:');
  });
});
