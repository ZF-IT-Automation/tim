import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, getUpdateCheckLine, getUpdateCheckLineBriefing } from '../update-check.js';

describe('compareVersions', () => {
  it('orders prerelease beta tags numerically', () => {
    expect(compareVersions('0.1.0-beta.1', '0.1.0-beta.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-beta.0', '0.1.0-beta.1')).toBeLessThan(0);
  });

  it('treats release versions as newer than prereleases', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
  });
});

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

  it('returns null when registry version is older than installed (no downgrade banner)', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({ dbPath: ':memory:', deviceId: '', updateCheck: true });
    vi.spyOn(await import('tim-core'), 'saveConfig').mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.1.0-beta.0' }) }) as typeof fetch;
    const installed = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'tim-mcp', 'package.json'), 'utf8')).version as string;
    if (compareVersions(installed, '0.1.0-beta.0') <= 0) return;
    expect(await getUpdateCheckLine()).toBeNull();
  });

  it('getUpdateCheckLineBriefing returns null when fetch is slow', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({ dbPath: ':memory:', deviceId: '', updateCheck: true });
    vi.spyOn(await import('tim-core'), 'saveConfig').mockImplementation(() => {});
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as typeof fetch;
    expect(await getUpdateCheckLineBriefing()).toBeNull();
  }, 2000);
});
