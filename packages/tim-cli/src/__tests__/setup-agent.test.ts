import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCodexMcpConfig,
  buildSetupAgentPlan,
  installCodexMcpConfig,
  replaceCodexTimMcpBlock,
} from '../setup-agent.js';

const SERVER_PATH = path.resolve(__dirname, '..', '..', '..', 'tim-mcp', 'dist', 'server.js');

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
    const config = buildCodexMcpConfig('/tmp/tim.db', { override: SERVER_PATH });
    expect(config).toContain('[mcp_servers.tim]');
    expect(config).toContain(`command = "${process.execPath}"`);
    expect(config).toContain(`args = ["${SERVER_PATH}"]`);
    expect(config).toContain('TIM_DB_PATH = "/tmp/tim.db"');
  });

  it('escapes codex TOML string values', () => {
    const config = buildCodexMcpConfig(
      'C:\\Users\\Agent\\"tim".db',
      { override: SERVER_PATH },
    );
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

    const updated = replaceCodexTimMcpBlock(
      existing,
      buildCodexMcpConfig('/tmp/tim.db', { override: SERVER_PATH }),
    );
    expect(updated).toContain('model = "gpt-5.5"');
    expect(updated).toContain(`command = "${process.execPath}"`);
    expect(updated).toContain('TIM_DB_PATH = "/tmp/tim.db"');
    expect(updated).toContain('[hooks.state]');
    expect(updated).not.toContain('/old.db');
  });

  it('installs Codex with the shared executable entry and preserves unrelated TOML', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim codex config '));
    const configPath = path.join(tmp, 'config.toml');
    fs.writeFileSync(configPath, 'model = "gpt-5.5"\n[hooks.state]\nenabled = true\n');
    try {
      installCodexMcpConfig('/tmp/codex db.tim', configPath, { override: SERVER_PATH });
      const installed = fs.readFileSync(configPath, 'utf8');
      expect(installed).toContain('model = "gpt-5.5"');
      expect(installed).toContain('[hooks.state]');
      expect(installed).toContain(`command = "${process.execPath}"`);
      expect(installed).toContain(`args = ["${SERVER_PATH}"]`);
      expect(installed).not.toContain('npx');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('leaves Codex config byte-identical when the server override is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-codex-missing-'));
    const configPath = path.join(tmp, 'config.toml');
    const original = 'model = "keep-me"\n';
    fs.writeFileSync(configPath, original);
    expect(() => installCodexMcpConfig(
      '/tmp/tim.db',
      configPath,
      { override: path.join(tmp, 'missing-server.js') },
    )).toThrow(/TIM MCP server artifact not found/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(fs.readdirSync(tmp)).toEqual(['config.toml']);

    const absentConfigPath = path.join(tmp, 'must-not-be-created', 'config.toml');
    expect(() => installCodexMcpConfig(
      '/tmp/tim.db',
      absentConfigPath,
      { override: path.join(tmp, 'missing-server.js') },
    )).toThrow(/TIM MCP server artifact not found/);
    expect(fs.existsSync(path.dirname(absentConfigPath))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
