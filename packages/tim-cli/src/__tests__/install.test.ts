import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeMcpConfig, buildTimMcpEntry, installMcpForHosts } from '../install.js';

describe('multi-host installer', () => {
  it('mergeMcpConfig adds tim server to standard format', () => {
    const merged = mergeMcpConfig({}, buildTimMcpEntry('/tmp/tim.db'), 'standard');
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.tim).toBeTruthy();
  });

  it('mergeMcpConfig adds tim server to opencode format', () => {
    const merged = mergeMcpConfig({}, buildTimMcpEntry('/tmp/tim.db'), 'opencode');
    const mcp = merged.mcp as Record<string, unknown>;
    expect(mcp.tim).toBeTruthy();
  });

  it('preserves existing servers when merging', () => {
    const merged = mergeMcpConfig(
      { mcpServers: { other: { command: 'x' } } },
      buildTimMcpEntry('/tmp/tim.db'),
      'standard',
    );
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.other).toBeTruthy();
    expect(servers.tim).toBeTruthy();
  });

  it('installMcpForHosts skips unparseable config without overwriting', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-install-'));
    const configPath = path.join(tmp, '.claude.json');
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    const badContent = '{ not valid json';
    fs.writeFileSync(configPath, badContent);

    const origHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      const result = installMcpForHosts('/tmp/tim.db', true);
      expect(result.skipped.length).toBeGreaterThan(0);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(badContent);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('installMcpForHosts creates backup before writing valid config', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-install-'));
    const configPath = path.join(tmp, '.claude.json');
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    const goodContent = JSON.stringify({ mcpServers: { other: { command: 'x' } } });
    fs.writeFileSync(configPath, goodContent);

    const origHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      const result = installMcpForHosts('/tmp/tim.db', true);
      expect(result.installed.length).toBeGreaterThan(0);
      const backups = fs.readdirSync(tmp).filter(f => f.startsWith('.claude.json.backup.'));
      expect(backups.length).toBeGreaterThan(0);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
