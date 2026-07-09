import { describe, it, expect } from 'vitest';
import {
  buildCodexMcpConfig,
  buildSetupAgentPlan,
  replaceCodexTimMcpBlock,
} from '../setup-agent.js';

describe('setup-agent planner', () => {
  it('plans MCP, skills, hooks, and smoke for claude', () => {
    const plan = buildSetupAgentPlan({ host: 'claude' });
    expect(plan.map(s => s.id)).toEqual(['mcp', 'skills', 'hooks', 'smoke']);
  });

  it('supports known hosts', () => {
    expect(() => buildSetupAgentPlan({ host: 'codex' })).not.toThrow();
    expect(() => buildSetupAgentPlan({ host: 'cursor' })).not.toThrow();
    expect(() => buildSetupAgentPlan({ host: 'hermes' })).not.toThrow();
  });

  it('builds codex MCP TOML for TIM', () => {
    expect(buildCodexMcpConfig('/tmp/tim.db')).toContain('[mcp_servers.tim]');
    expect(buildCodexMcpConfig('/tmp/tim.db')).toContain('TIM_DB_PATH = "/tmp/tim.db"');
  });

  it('escapes codex TOML string values', () => {
    const config = buildCodexMcpConfig('C:\\Users\\Agent\\"tim".db');
    expect(config).toContain('TIM_DB_PATH = "C:\\\\Users\\\\Agent\\\\\\"tim\\".db"');
  });

  it('replaces existing codex TIM MCP block without dropping unrelated sections', () => {
    const existing = [
      'model = "gpt-5.5"',
      '[mcp_servers.tim]',
      'command = "old"',
      '',
      '[mcp_servers.tim.env]',
      'TIM_DB_PATH = "/old.db"',
      '',
      '[hooks.state]',
      '',
    ].join('\n');

    const updated = replaceCodexTimMcpBlock(existing, buildCodexMcpConfig('/tmp/tim.db'));
    expect(updated).toContain('model = "gpt-5.5"');
    expect(updated).toContain('command = "npx"');
    expect(updated).toContain('TIM_DB_PATH = "/tmp/tim.db"');
    expect(updated).toContain('[hooks.state]');
    expect(updated).not.toContain('/old.db');
  });
});
