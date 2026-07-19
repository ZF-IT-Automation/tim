import { afterEach, describe, it, expect } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOST_TOOLS,
  mergeMcpConfig,
  buildTimMcpEntry,
  installMcpForHostTool,
  installMcpForHosts,
} from '../install.js';
import { resolveTimMcpServerPath } from '../mcp-command.js';

const SERVER_PATH = path.resolve(__dirname, '..', '..', '..', 'tim-mcp', 'dist', 'server.js');
const CLI_PATH = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');
const MCP_COMMAND_PATH = path.resolve(__dirname, '..', '..', 'dist', 'mcp-command.js');
const CLI_PACKAGE_PATH = path.resolve(__dirname, '..', '..', 'package.json');

interface JsonRpcResponse {
  id: number;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

async function rpc(child: ChildProcess, id: number, method: string, params: unknown): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`MCP server exited before ${method}: code=${code} signal=${signal}`));
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id !== id) continue;
        cleanup();
        resolve(response);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${method}`));
    }, 10_000);
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const originalHome = process.env.HOME;
const originalOverride = process.env.TIM_MCP_SERVER;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalOverride === undefined) delete process.env.TIM_MCP_SERVER;
  else process.env.TIM_MCP_SERVER = originalOverride;
});

describe('multi-host installer', () => {
  it('declares tim-mcp as a direct runtime dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(CLI_PACKAGE_PATH, 'utf8')) as {
      version?: string;
      dependencies?: Record<string, string>;
    };
    // Workspace may use "*" locally; publish pins the same version as the package.
    expect(pkg.dependencies?.['tim-mcp']).toMatch(/^\*|0\.\d+\.\d+(-[\w.]+)?$/);
    if (pkg.dependencies?.['tim-mcp'] !== '*') {
      expect(pkg.dependencies?.['tim-mcp']).toBe(pkg.version);
    }
  });

  it('resolves tim-mcp from a nested installed-package dependency', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-installed-layout-'));
    const cliDist = path.join(tmp, 'node_modules', 'tim-cli', 'dist');
    const mcpPackage = path.join(tmp, 'node_modules', 'tim-cli', 'node_modules', 'tim-mcp');
    const nestedServer = path.join(mcpPackage, 'dist', 'server.js');
    fs.mkdirSync(cliDist, { recursive: true });
    fs.mkdirSync(path.dirname(nestedServer), { recursive: true });
    fs.copyFileSync(MCP_COMMAND_PATH, path.join(cliDist, 'mcp-command.js'));
    fs.writeFileSync(path.join(mcpPackage, 'package.json'), JSON.stringify({ name: 'tim-mcp' }));
    fs.writeFileSync(nestedServer, '// installed fixture\n');

    try {
      const fixtureModule = path.join(cliDist, 'mcp-command.js');
      const result = spawnSync(process.execPath, [
        '-e',
        `process.stdout.write(require(${JSON.stringify(fixtureModule)}).resolveTimMcpServerPath())`,
      ], {
        encoding: 'utf8',
        env: { ...process.env, TIM_MCP_SERVER: '' },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(nestedServer);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prefers the current checkout sibling over a resolvable packaged dependency', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-worktree-layout-'));
    const cliDist = path.join(tmp, 'packages', 'tim-cli', 'dist');
    const siblingServer = path.join(tmp, 'packages', 'tim-mcp', 'dist', 'server.js');
    const packagedServer = path.join(
      tmp,
      'packages',
      'tim-cli',
      'node_modules',
      'tim-mcp',
      'dist',
      'server.js',
    );
    fs.mkdirSync(cliDist, { recursive: true });
    fs.mkdirSync(path.dirname(siblingServer), { recursive: true });
    fs.mkdirSync(path.dirname(packagedServer), { recursive: true });
    fs.copyFileSync(MCP_COMMAND_PATH, path.join(cliDist, 'mcp-command.js'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'tim',
      private: true,
      workspaces: ['packages/tim-cli', 'packages/tim-mcp'],
    }));
    fs.writeFileSync(
      path.join(tmp, 'packages', 'tim-cli', 'package.json'),
      JSON.stringify({ name: 'tim-cli' }),
    );
    fs.writeFileSync(
      path.join(tmp, 'packages', 'tim-mcp', 'package.json'),
      JSON.stringify({ name: 'tim-mcp' }),
    );
    fs.writeFileSync(
      path.join(tmp, 'packages', 'tim-cli', 'node_modules', 'tim-mcp', 'package.json'),
      JSON.stringify({ name: 'tim-mcp' }),
    );
    fs.writeFileSync(siblingServer, '// checkout sibling\n');
    fs.writeFileSync(packagedServer, '// packaged dependency\n');

    try {
      const fixtureModule = path.join(cliDist, 'mcp-command.js');
      const result = spawnSync(process.execPath, [
        '-e',
        `process.stdout.write(require(${JSON.stringify(fixtureModule)}).resolveTimMcpServerPath())`,
      ], {
        encoding: 'utf8',
        env: { ...process.env, TIM_MCP_SERVER: '' },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(siblingServer);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prefers the declared dependency over a sibling decoy outside a TIM checkout', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-global-layout-'));
    const cliDist = path.join(tmp, 'node_modules', 'tim-cli', 'dist');
    const siblingServer = path.join(tmp, 'node_modules', 'tim-mcp', 'dist', 'server.js');
    const packagedRoot = path.join(tmp, 'node_modules', 'tim-cli', 'node_modules', 'tim-mcp');
    const packagedServer = path.join(packagedRoot, 'dist', 'server.js');
    fs.mkdirSync(cliDist, { recursive: true });
    fs.mkdirSync(path.dirname(siblingServer), { recursive: true });
    fs.mkdirSync(path.dirname(packagedServer), { recursive: true });
    fs.copyFileSync(MCP_COMMAND_PATH, path.join(cliDist, 'mcp-command.js'));
    fs.writeFileSync(path.join(packagedRoot, 'package.json'), JSON.stringify({ name: 'tim-mcp' }));
    fs.writeFileSync(siblingServer, '// unrelated sibling decoy\n');
    fs.writeFileSync(packagedServer, '// declared packaged dependency\n');

    try {
      const fixtureModule = path.join(cliDist, 'mcp-command.js');
      const result = spawnSync(process.execPath, [
        '-e',
        `process.stdout.write(require(${JSON.stringify(fixtureModule)}).resolveTimMcpServerPath())`,
      ], {
        encoding: 'utf8',
        env: { ...process.env, TIM_MCP_SERVER: '' },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(packagedServer);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves an absolute verified server and builds a node entry', () => {
    const entry = buildTimMcpEntry('/tmp/tim.db', { override: SERVER_PATH });
    expect(entry).toEqual({
      command: process.execPath,
      args: [SERVER_PATH],
      env: { TIM_DB_PATH: '/tmp/tim.db' },
    });
    expect(path.isAbsolute(entry.command)).toBe(true);
    expect(path.isAbsolute(entry.args[0]!)).toBe(true);
    expect(fs.statSync(entry.args[0]!).isFile()).toBe(true);
  });

  it('honors TIM_MCP_SERVER with spaces in the absolute path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim mcp override '));
    const linked = path.join(tmp, 'server with spaces.js');
    fs.symlinkSync(SERVER_PATH, linked);
    process.env.TIM_MCP_SERVER = linked;
    try {
      expect(resolveTimMcpServerPath()).toBe(linked);
      expect(buildTimMcpEntry('/tmp/space db.tim').args).toEqual([linked]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

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
      const result = installMcpForHosts('/tmp/tim.db', true, { override: SERVER_PATH });
      expect(result.installed.length).toBeGreaterThan(0);
      const backups = fs.readdirSync(tmp).filter(f => f.startsWith('.claude.json.backup.'));
      expect(backups.length).toBeGreaterThan(0);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes the same executable entry for every detected JSON/OpenCode host', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim hosts '));
    process.env.HOME = tmp;
    for (const dir of ['.claude', '.cursor', '.gemini', path.join('.config', 'opencode')]) {
      fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    }
    try {
      const result = installMcpForHosts('/tmp/all hosts.db', true, { override: SERVER_PATH });
      expect(result.installed).toHaveLength(HOST_TOOLS.length);
      for (const tool of HOST_TOOLS) {
        const config = JSON.parse(fs.readFileSync(tool.mcpConfigPath(true), 'utf8')) as Record<string, any>;
        if (tool.format === 'opencode') {
          expect(config.mcp.tim.command).toEqual([process.execPath, SERVER_PATH]);
          expect(config.mcp.tim.environment.TIM_DB_PATH).toBe('/tmp/all hosts.db');
        } else {
          expect(config.mcpServers.tim).toMatchObject({
            command: process.execPath,
            args: [SERVER_PATH],
            env: { TIM_DB_PATH: '/tmp/all hosts.db' },
          });
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails before directory, backup, or config mutation when the artifact is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-missing-server-'));
    const configPath = path.join(tmp, 'host', 'mcp.json');
    const existing = '{"unrelated":{"keep":true}}\n';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, existing);
    const tool = {
      id: 'test',
      name: 'Test Host',
      detect: () => true,
      mcpConfigPath: () => configPath,
      format: 'standard' as const,
    };

    expect(() => installMcpForHostTool(
      tool,
      '/tmp/tim.db',
      true,
      { override: path.join(tmp, 'missing', 'server.js') },
    )).toThrow(/TIM MCP server artifact not found/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(existing);
    expect(fs.readdirSync(path.dirname(configPath))).toEqual(['mcp.json']);

    const absentConfigPath = path.join(tmp, 'must-not-be-created', 'mcp.json');
    expect(() => installMcpForHostTool(
      { ...tool, mcpConfigPath: () => absentConfigPath },
      '/tmp/tim.db',
      true,
      { override: path.join(tmp, 'missing', 'server.js') },
    )).toThrow(/TIM MCP server artifact not found/);
    expect(fs.existsSync(path.dirname(absentConfigPath))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('init verifies the MCP server before any home, database, agent, or config mutation', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-init-no-mutation-'));
    const configPath = path.join(tmp, '.claude.json');
    const originalConfig = '{"mcpServers":{"keep":{"command":"keep"}}}\n';
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.writeFileSync(configPath, originalConfig);
    const before = fs.readdirSync(tmp).sort();

    try {
      const result = spawnSync(process.execPath, [CLI_PATH, 'init'], {
        cwd: tmp,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tmp,
          TIM_DB_PATH: path.join(tmp, '.tim', 'tim.db'),
          TIM_MCP_SERVER: path.join(tmp, 'missing-server.js'),
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('TIM MCP server artifact not found');
      expect(fs.readdirSync(tmp).sort()).toEqual(before);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);
      expect(fs.existsSync(path.join(tmp, '.tim'))).toBe(false);
      expect(fs.readdirSync(tmp).some(name => name.includes('.backup.'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('generated command initializes MCP and serves tim_stats', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-mcp-smoke-'));
    const entry = buildTimMcpEntry(path.join(tmp, 'smoke.db'), { override: SERVER_PATH });
    const child = spawn(entry.command, entry.args, {
      cwd: tmp,
      env: { ...process.env, ...entry.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const initialized = await rpc(child, 1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'installer-test', version: '1.0.0' },
      });
      expect(initialized.error).toBeUndefined();
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const stats = await rpc(child, 2, 'tools/call', {
        name: 'tim_stats',
        arguments: {},
      });
      expect(stats.error).toBeUndefined();
      expect(stats.result?.content?.[0]?.text).toContain('totalEntries');
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
