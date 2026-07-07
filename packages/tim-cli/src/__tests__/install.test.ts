import { describe, it, expect } from 'vitest';
import { mergeMcpConfig, buildTimMcpEntry } from '../install.js';

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
});
