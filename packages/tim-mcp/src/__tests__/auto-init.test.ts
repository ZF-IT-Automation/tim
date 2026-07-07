import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAutoInit } from '../auto-init.js';

describe('runAutoInit', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates database and config on fresh init', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-autoinit-'));
    const dbPath = path.join(root, 'tim.db');
    const configPath = path.join(root, '.tim', 'config.json');
    const prevHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await runAutoInit({ dbPath });
      expect(result.ok).toBe(true);
      expect(result.dbCreated).toBe(true);
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.existsSync(configPath)).toBe(true);
      expect(result.configCreated).toBe(true);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('skips when database and config already exist', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-autoinit-skip-'));
    const dbPath = path.join(root, 'tim.db');
    const prevHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const first = await runAutoInit({ dbPath });
      expect(first.dbCreated).toBe(true);

      const second = await runAutoInit({ dbPath });
      expect(second.ok).toBe(true);
      expect(second.dbCreated).toBe(false);
      expect(second.configCreated).toBe(false);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('does not register duplicate default agent', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-autoinit-agent-'));
    const dbPath = path.join(root, 'tim.db');
    const prevHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await runAutoInit({ dbPath });
      await runAutoInit({ dbPath });
      const { TimStore } = await import('tim-store');
      const store = new TimStore(dbPath);
      const agents = await store.getAgents().then(list => list.filter(a => a.label === 'default'));
      store.close();
      expect(agents.length).toBe(1);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
