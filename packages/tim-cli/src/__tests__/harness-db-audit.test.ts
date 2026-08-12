import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditHarnessDbPaths, harnessConfigFiles } from '../harness-db-audit.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-harness-db-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('auditHarnessDbPaths', () => {
  it('flags a config pointing at a different database', () => {
    const file = write('mcp.json', JSON.stringify({
      mcpServers: { tim: { command: 'node', env: { TIM_DB_PATH: '/tmp/scratch/smoke.db' } } },
    }));

    const findings = auditHarnessDbPaths('/home/u/.tim/tim.db', [file]);

    expect(findings).toEqual([
      { configPath: file, configured: '/tmp/scratch/smoke.db', matches: false },
    ]);
  });

  it('accepts a config pointing at the expected database', () => {
    const file = write('mcp.json', JSON.stringify({
      mcpServers: { tim: { env: { TIM_DB_PATH: '/home/u/.tim/tim.db' } } },
    }));

    expect(auditHarnessDbPaths('/home/u/.tim/tim.db', [file])[0]!.matches).toBe(true);
  });

  it('reads the OpenCode "environment" key and a bare TOML assignment alike', () => {
    const opencode = write('opencode.json', JSON.stringify({
      mcp: { tim: { type: 'local', environment: { TIM_DB_PATH: '/wrong/a.db' } } },
    }));
    const codex = write('config.toml', '[mcp_servers.tim.env]\nTIM_DB_PATH = "/wrong/b.db"\n');

    const findings = auditHarnessDbPaths('/home/u/.tim/tim.db', [opencode, codex]);

    expect(findings.map(f => f.configured)).toEqual(['/wrong/a.db', '/wrong/b.db']);
    expect(findings.every(f => !f.matches)).toBe(true);
  });

  it('reports one line per distinct value when a host repeats the block per project', () => {
    // Claude keeps a global mcpServers block plus one under every projects.<path> key.
    const file = write('.claude.json', JSON.stringify({
      mcpServers: { tim: { env: { TIM_DB_PATH: '/wrong/a.db' } } },
      projects: {
        '/p/one': { mcpServers: { tim: { env: { TIM_DB_PATH: '/wrong/a.db' } } } },
        '/p/two': { mcpServers: { tim: { env: { TIM_DB_PATH: '/home/u/.tim/tim.db' } } } },
      },
    }));

    const findings = auditHarnessDbPaths('/home/u/.tim/tim.db', [file]);

    expect(findings).toHaveLength(2);
    expect(findings.filter(f => !f.matches).map(f => f.configured)).toEqual(['/wrong/a.db']);
  });

  it('stays silent for a missing config and for one that sets no path', () => {
    const noSetting = write('mcp.json', JSON.stringify({
      mcpServers: { tim: { command: 'node', args: ['server.js'] } },
    }));

    expect(auditHarnessDbPaths('/home/u/.tim/tim.db', [
      noSetting,
      path.join(tmp, 'does-not-exist.json'),
    ])).toEqual([]);
  });

  it('normalises before comparing, so an unresolved path is not a false alarm', () => {
    const file = write('mcp.json', JSON.stringify({
      mcpServers: { tim: { env: { TIM_DB_PATH: '/home/u/.tim/../.tim/tim.db' } } },
    }));

    expect(auditHarnessDbPaths('/home/u/.tim/tim.db', [file])[0]!.matches).toBe(true);
  });

  it('covers every installed host plus Codex', () => {
    const home = os.homedir();
    const files = harnessConfigFiles();

    expect(files).toContain(path.join(home, '.claude.json'));
    expect(files).toContain(path.join(home, '.cursor', 'mcp.json'));
    expect(files).toContain(path.join(home, '.config', 'opencode', 'opencode.json'));
    expect(files).toContain(path.join(home, '.codex', 'config.toml'));
  });
});
