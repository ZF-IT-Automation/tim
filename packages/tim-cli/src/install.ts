import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function homeDir(): string {
  return os.homedir();
}

export interface HostTool {
  id: string;
  name: string;
  detect: () => boolean;
  mcpConfigPath: (global: boolean) => string;
  format: 'standard' | 'opencode';
}

export const HOST_TOOLS: HostTool[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    detect: () => fs.existsSync(path.join(homeDir(), '.claude')),
    mcpConfigPath: (global) =>
      global ? path.join(homeDir(), '.claude.json') : path.join(process.cwd(), '.mcp.json'),
    format: 'standard',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detect: () => fs.existsSync(path.join(homeDir(), '.cursor')),
    mcpConfigPath: (global) =>
      global
        ? path.join(homeDir(), '.cursor', 'mcp.json')
        : path.join(process.cwd(), '.cursor', 'mcp.json'),
    format: 'standard',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    detect: () => fs.existsSync(path.join(homeDir(), '.config', 'opencode')),
    mcpConfigPath: (global) =>
      global
        ? path.join(homeDir(), '.config', 'opencode', 'opencode.json')
        : path.join(process.cwd(), 'opencode.json'),
    format: 'opencode',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    detect: () =>
      fs.existsSync(path.join(homeDir(), '.gemini')) ||
      fs.existsSync(path.join(homeDir(), '.config', 'gemini')),
    mcpConfigPath: (global) =>
      global
        ? path.join(homeDir(), '.gemini', 'settings.json')
        : path.join(process.cwd(), '.gemini', 'settings.json'),
    format: 'standard',
  },
];

export function detectInstalledHosts(): HostTool[] {
  return HOST_TOOLS.filter(t => t.detect());
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function buildTimMcpEntry(dbPath: string): McpServerEntry {
  return {
    command: 'npx',
    args: ['tim-mcp'],
    env: { TIM_DB_PATH: dbPath },
  };
}

export function mergeMcpConfig(
  existing: Record<string, unknown>,
  entry: McpServerEntry,
  format: 'standard' | 'opencode',
): Record<string, unknown> {
  if (format === 'opencode') {
    const mcp = (existing.mcp as Record<string, unknown>) ?? {};
    return {
      ...existing,
      mcp: {
        ...mcp,
        tim: { type: 'local', command: [entry.command, ...entry.args], environment: entry.env ?? {} },
      },
    };
  }
  const servers = (existing.mcpServers as Record<string, unknown>) ?? {};
  return {
    ...existing,
    mcpServers: {
      ...servers,
      tim: entry,
    },
  };
}

export function installMcpForHosts(
  dbPath: string,
  global = true,
): { installed: { tool: string; path: string }[]; skipped: { tool: string; path: string; reason: string }[] } {
  const installed: { tool: string; path: string }[] = [];
  const skipped: { tool: string; path: string; reason: string }[] = [];
  for (const tool of detectInstalledHosts()) {
    const result = installMcpForHostTool(tool, dbPath, global);
    installed.push(...result.installed);
    skipped.push(...result.skipped);
  }
  return { installed, skipped };
}

export function installMcpForHostTool(
  tool: HostTool,
  dbPath: string,
  global = true,
): { installed: { tool: string; path: string }[]; skipped: { tool: string; path: string; reason: string }[] } {
  const configPath = tool.mcpConfigPath(global);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return {
        installed: [],
        skipped: [{ tool: tool.name, path: configPath, reason: 'config parse failed' }],
      };
    }
    fs.copyFileSync(configPath, `${configPath}.backup.${Date.now()}`);
  }
  const merged = mergeMcpConfig(existing, buildTimMcpEntry(dbPath), tool.format);
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  return { installed: [{ tool: tool.name, path: configPath }], skipped: [] };
}
