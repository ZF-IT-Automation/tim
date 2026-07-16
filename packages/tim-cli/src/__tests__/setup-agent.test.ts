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
});

describe('claude hooks install wiring', () => {
  it('exports merge helpers used by setup-agent host install', async () => {
    const { mergeClaudeHooks } = await import('../claude-hooks-install.js');
    const next = mergeClaudeHooks({});
    expect(next.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.command).toContain('hook prompt-submit');
    expect(next.hooks?.Stop?.[0]?.hooks[0]?.command).toContain('hook claude-stop');
    expect(mergeClaudeHooks(next)).toEqual(next);
  });
});

describe('codex MCP config', () => {
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

  it('escapes newlines and control characters without injecting TOML tables', () => {
    const dbPath = '/tmp/tim.db"\n[mcp_servers.evil]\ncommand = "owned"\u0001\u007f';
    const config = buildCodexMcpConfig(dbPath, { override: SERVER_PATH });
    expect(config).not.toContain('\n[mcp_servers.evil]\n');
    expect(config).toContain('\\n[mcp_servers.evil]\\n');
    expect(config).toContain('\\u0001');
    expect(config).toContain('\\u007F');
    expect(config).not.toContain('\u007f');
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

  it('removes separated TIM tables while preserving intervening unrelated tables', () => {
    const existing = [
      'model = "gpt-5.5"',
      '[mcp_servers.tim]',
      'command = "old"',
      '',
      '[hooks.state]',
      'enabled = true',
      '',
      '[mcp_servers.tim.env]',
      'TIM_DB_PATH = "/old.db"',
      '',
      '[features]',
      'safe = true',
      '',
    ].join('\n');

    const updated = replaceCodexTimMcpBlock(
      existing,
      buildCodexMcpConfig('/tmp/new.db', { override: SERVER_PATH }),
    );
    expect(updated.match(/\[mcp_servers\.tim\]/g)).toHaveLength(1);
    expect(updated.match(/\[mcp_servers\.tim\.env\]/g)).toHaveLength(1);
    expect(updated).toContain('[hooks.state]\nenabled = true');
    expect(updated).toContain('[features]\nsafe = true');
    expect(updated).not.toContain('/old.db');
  });

  it('normalizes quoted and commented TIM definitions without broad deletion', () => {
    const existing = [
      '# keep top-level comment',
      'mcp_servers.tim.command = "old-bare" # stale',
      'mcp_servers."tim".args = ["old-quoted"]',
      '"mcp_servers"."tim".env.TIM_DB_PATH = "/old-dotted.db"',
      'mcp_servers.other.command = "keep-other"',
      '',
      '[mcp_servers."tim"] # stale quoted table',
      'command = "old-table"',
      '',
      '[mcp_servers.other] # keep unrelated table comment',
      'command = "keep-table"',
      '# keep unrelated body comment',
      '',
      '[mcp_servers."tim".env] # stale quoted env table',
      'TIM_DB_PATH = "/old-table.db"',
      '',
      '[hooks.state] # keep hooks comment',
      'enabled = true',
      'mcp_servers.tim.command = "nested-keep"',
      '',
    ].join('\n');

    const updated = replaceCodexTimMcpBlock(
      existing,
      buildCodexMcpConfig('/tmp/canonical.db', { override: SERVER_PATH }),
    );
    expect(updated.match(/\[mcp_servers\.tim\]/g)).toHaveLength(1);
    expect(updated.match(/\[mcp_servers\.tim\.env\]/g)).toHaveLength(1);
    expect(updated).not.toContain('old-bare');
    expect(updated).not.toContain('old-quoted');
    expect(updated).not.toContain('/old-dotted.db');
    expect(updated).not.toContain('old-table');
    expect(updated).not.toContain('/old-table.db');
    expect(updated).not.toContain('[mcp_servers."tim"]');
    expect(updated).not.toContain('[mcp_servers."tim".env]');
    expect(updated).toContain('# keep top-level comment');
    expect(updated).toContain('mcp_servers.other.command = "keep-other"');
    expect(updated).toContain('[mcp_servers.other] # keep unrelated table comment');
    expect(updated).toContain('# keep unrelated body comment');
    expect(updated).toContain('[hooks.state] # keep hooks comment');
    expect(updated).toContain('mcp_servers.tim.command = "nested-keep"');
    expect(updated).toContain('TIM_DB_PATH = "/tmp/canonical.db"');
  });

  it('preserves fake MCP syntax inside multiline TOML strings', () => {
    const multiline = [
      'notes = """',
      '[mcp_servers."tim"] # text, not a table',
      'mcp_servers.tim.command = "text, not an assignment"',
      '[mcp_servers."tim".env]',
      'TIM_DB_PATH = "/text-only.db"',
      '"""',
    ].join('\n');
    const existing = [
      '# keep prose exactly',
      multiline,
      '',
      '[mcp_servers.tim] # real stale table',
      'command = "old-real"',
      '',
      '[hooks.state]',
      'enabled = true',
      '',
    ].join('\n');

    const updated = replaceCodexTimMcpBlock(
      existing,
      buildCodexMcpConfig('/tmp/canonical.db', { override: SERVER_PATH }),
    );
    expect(updated).toContain(multiline);
    expect(updated).toContain('# keep prose exactly');
    expect(updated).toContain('[hooks.state]\nenabled = true');
    expect(updated).not.toContain('old-real');
    expect(updated.match(/^\[mcp_servers\.tim\]$/gm)).toHaveLength(1);
    expect(updated.match(/^\[mcp_servers\.tim\.env\]$/gm)).toHaveLength(1);
  });

  it('rejects inline mcp_servers atomically instead of creating conflicting TOML', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-codex-inline-'));
    const configPath = path.join(tmp, 'config.toml');
    const original = [
      '# preserve inline configuration',
      'mcp_servers = { tim = { command = "old" }, other = { command = "keep" } }',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, original);

    try {
      expect(() => installCodexMcpConfig(
        '/tmp/tim.db',
        configPath,
        { override: SERVER_PATH },
      )).toThrow(/unsupported top-level mcp_servers assignment/i);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
      expect(fs.readdirSync(tmp)).toEqual(['config.toml']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(['tim', '"tim"'])(
    'rejects relative %s assignments under [mcp_servers] atomically',
    (timKey) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-codex-relative-'));
      const configPath = path.join(tmp, 'config.toml');
      const original = [
        '# preserve server table',
        '[mcp_servers]',
        `${timKey} = { command = "old" }`,
        'other = { command = "keep" }',
        '',
      ].join('\n');
      fs.writeFileSync(configPath, original);

      try {
        expect(() => installCodexMcpConfig(
          '/tmp/tim.db',
          configPath,
          { override: SERVER_PATH },
        )).toThrow(/unsupported relative tim assignment under \[mcp_servers\]/i);
        expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
        expect(fs.readdirSync(tmp)).toEqual(['config.toml']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

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
