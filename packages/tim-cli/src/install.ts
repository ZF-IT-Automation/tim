import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = os.homedir();

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
    detect: () => fs.existsSync(path.join(HOME, '.claude')),
    mcpConfigPath: (global) =>
      global ? path.join(HOME, '.claude.json') : path.join(process.cwd(), '.mcp.json'),
    format: 'standard',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detect: () => fs.existsSync(path.join(HOME, '.cursor')),
    mcpConfigPath: (global) =>
      global
        ? path.join(HOME, '.cursor', 'mcp.json')
        : path.join(process.cwd(), '.cursor', 'mcp.json'),
    format: 'standard',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    detect: () => fs.existsSync(path.join(HOME, '.config', 'opencode')),
    mcpConfigPath: (global) =>
      global
        ? path.join(HOME, '.config', 'opencode', 'opencode.json')
        : path.join(process.cwd(), 'opencode.json'),
    format: 'opencode',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    detect: () =>
      fs.existsSync(path.join(HOME, '.gemini')) ||
      fs.existsSync(path.join(HOME, '.config', 'gemini')),
    mcpConfigPath: (global) =>
      global
        ? path.join(HOME, '.gemini', 'settings.json')
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

export function installMcpForHosts(dbPath: string, global = true): { tool: string; path: string }[] {
  const installed: { tool: string; path: string }[] = [];
  for (const tool of detectInstalledHosts()) {
    const configPath = tool.mcpConfigPath(global);
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    const merged = mergeMcpConfig(existing, buildTimMcpEntry(dbPath), tool.format);
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
    installed.push({ tool: tool.name, path: configPath });
  }
  return installed;
}
