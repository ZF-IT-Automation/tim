import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, getConfigPath } from '../config.js';

// os.homedir() honours $HOME on POSIX, so stubbing it redirects ~/.tim/config.json.
describe('loadConfig summarizer defaults', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-config-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(raw: unknown): void {
    fs.mkdirSync(path.join(home, '.tim'), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(raw));
  }

  it('ships a non-empty summarizer chain when no config file exists', () => {
    const config = loadConfig();
    expect(config.summarizer?.chain.length).toBeGreaterThan(0);
    expect(config.summarizer?.timeout_sec).toBeGreaterThan(0);
    for (const entry of config.summarizer!.chain) {
      expect(entry.cli).toBeTruthy();
      expect(entry.model).toBeTruthy();
    }
  });

  it('fills in the summarizer block when the config file omits it', () => {
    writeConfig({ dbPath: '/tmp/x.db', deviceId: 'dev' });
    const config = loadConfig();
    expect(config.dbPath).toBe('/tmp/x.db');
    expect(config.summarizer?.chain.length).toBeGreaterThan(0);
  });

  it('a user-supplied chain replaces the default wholesale', () => {
    writeConfig({ summarizer: { chain: [{ cli: 'codex', model: 'my-model' }] } });
    const config = loadConfig();
    expect(config.summarizer?.chain).toEqual([{ cli: 'codex', model: 'my-model' }]);
    // Unspecified siblings still come from the default block.
    expect(config.summarizer?.timeout_sec).toBeGreaterThan(0);
  });

  it('ships idle_sweep defaults when no config file exists', () => {
    const config = loadConfig();
    expect(config.summarizer?.idle_sweep).toEqual({
      enabled: true,
      interval_minutes: 5,
      idle_minutes: 15,
      max_spawns_per_pass: 3,
    });
  });

  it('merges idle_sweep overrides from config file', () => {
    writeConfig({ summarizer: { idle_sweep: { enabled: false, idle_minutes: 30 } } });
    const config = loadConfig();
    expect(config.summarizer?.idle_sweep).toMatchObject({
      enabled: false,
      idle_minutes: 30,
      interval_minutes: 5,
      max_spawns_per_pass: 3,
    });
  });

  it('an explicitly empty chain is honoured (opt-out, not overridden)', () => {
    writeConfig({ summarizer: { chain: [] } });
    expect(loadConfig().summarizer?.chain).toEqual([]);
  });
});
