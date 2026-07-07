import { describe, it, expect, vi, afterEach } from 'vitest';
import { getUpdateCheckLine } from '../update-check.js';

describe('getUpdateCheckLine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns line when registry has newer version', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({
      dbPath: ':memory:',
      deviceId: '',
      updateCheck: true,
    });
    vi.spyOn(await import('tim-core'), 'saveConfig').mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.0.0' }),
    }) as typeof fetch;

    const line = await getUpdateCheckLine();
    expect(line).toMatch(/99\.0\.0 available/);
    expect(line).toMatch(/npm i -g tim-mcp/);
  });

  it('returns null when installed version matches latest', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({
      dbPath: ':memory:',
      deviceId: '',
      updateCheck: true,
    });
    vi.spyOn(await import('tim-core'), 'saveConfig').mockImplementation(() => {});

    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const installed = JSON.parse(readFileSync(pkgPath, 'utf8')).version as string;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: installed }),
    }) as typeof fetch;

    const line = await getUpdateCheckLine();
    expect(line).toBeNull();
  });

  it('returns null on network error without throwing', async () => {
    vi.spyOn(await import('tim-core'), 'loadConfig').mockReturnValue({
      dbPath: ':memory:',
      deviceId: '',
      updateCheck: true,
    });
    vi.spyOn(await import('tim-core'), 'saveConfig').mockImplementation(() => {});

    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as typeof fetch;

    const line = await getUpdateCheckLine();
    expect(line).toBeNull();
  });
});
