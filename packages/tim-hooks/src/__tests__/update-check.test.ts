import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getUpdateCheckLine, getUpdateCheckLineBriefing } from '../update-check.js';

describe('getUpdateCheckLine', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns line when registry has newer version', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({ dbPath: ':memory:', deviceId: '', updateCheck: true });
    vi.spyOn(await import('tim-core'), 'saveConfig').mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '99.0.0' }) }) as typeof fetch;
    expect(await getUpdateCheckLine()).toMatch(/99\.0\.0 available/);
  });

  it('returns null when installed tim-mcp version matches latest', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({ dbPath: ':memory:', deviceId: '', updateCheck: true });
    vi.spyOn(await import('tim-core'), 'saveConfig').mockImplementation(() => {});
    const installed = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'tim-mcp', 'package.json'), 'utf8')).version as string;
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: installed }) }) as typeof fetch;
    expect(await getUpdateCheckLine()).toBeNull();
  });

  it('getUpdateCheckLineBriefing returns null when fetch is slow', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({ dbPath: ':memory:', deviceId: '', updateCheck: true });
    vi.spyOn(await import('tim-core'), 'saveConfig').mockImplementation(() => {});
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as typeof fetch;
    expect(await getUpdateCheckLineBriefing()).toBeNull();
  }, 2000);
});
