import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type TimConfigFile } from 'tim-core';
import { TimStore } from 'tim-store';
import { HOST_TOOLS, buildTimMcpEntry, installMcpForHostTool, type HostTool } from './install.js';
import type { TimMcpServerOptions } from './mcp-command.js';
import { updateSkillsForHost } from './update-skills.js';
import { installHermesStatusline } from './hermes-statusline-install.js';

export type AgentHost = 'claude' | 'codex' | 'cursor' | 'hermes';

export interface SetupAgentStep {
  id: 'mcp' | 'skills' | 'hooks' | 'smoke';
  description: string;
}

export function buildSetupAgentPlan(opts: { host: AgentHost }): SetupAgentStep[] {
  assertAgentHost(opts.host);
  return [
    { id: 'mcp', description: `Install MCP config for ${opts.host}` },
    { id: 'skills', description: `Install TIM skills for ${opts.host}` },
    { id: 'hooks', description: `Install supported hooks/statusline for ${opts.host}` },
    { id: 'smoke', description: 'Run tim doctor and MCP smoke guidance' },
  ];
}

function assertAgentHost(host: string): asserts host is AgentHost {
  if (!['claude', 'codex', 'cursor', 'hermes'].includes(host)) {
    throw new Error(`unsupported host: ${host}`);
  }
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = 'true';
    }
  }
  return parsed;
}

function getDbPath(config: TimConfigFile): string {
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

function hostTool(host: AgentHost): HostTool | null {
  const id = host === 'claude' ? 'claude-code' : host === 'cursor' ? 'cursor' : null;
  return id ? (HOST_TOOLS.find(tool => tool.id === id) ?? null) : null;
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007F');
}

function findOutsideTomlQuotes(value: string, needle: string): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === needle) return i;
  }
  return -1;
}

function withoutTomlComment(line: string): string {
  const comment = findOutsideTomlQuotes(line, '#');
  return comment < 0 ? line : line.slice(0, comment);
}

type MultilineDelimiter = '"""' | "'''";

interface TomlScanState {
  multiline: MultilineDelimiter | null;
}

interface TomlStructuralLine {
  structural: string | null;
  openedMultiline: boolean;
  closedMultiline: boolean;
}

function findMultilineClose(line: string, delimiter: MultilineDelimiter, start: number): number {
  let index = line.indexOf(delimiter, start);
  while (index >= 0 && delimiter === '"""') {
    let backslashes = 0;
    for (let i = index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
    if (backslashes % 2 === 0) return index;
    index = line.indexOf(delimiter, index + delimiter.length);
  }
  return index;
}

function findMultilineOpen(line: string): { index: number; delimiter: MultilineDelimiter } | null {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '#') return null;
    if (line.startsWith('"""', i)) return { index: i, delimiter: '"""' };
    if (line.startsWith("'''", i)) return { index: i, delimiter: "'''" };
    if (char === '"' || char === "'") quote = char;
  }
  return null;
}

function scanTomlStructuralLine(line: string, state: TomlScanState): TomlStructuralLine {
  if (state.multiline) {
    const close = findMultilineClose(line, state.multiline, 0);
    if (close >= 0) state.multiline = null;
    return { structural: null, openedMultiline: false, closedMultiline: close >= 0 };
  }

  const opening = findMultilineOpen(line);
  if (!opening) return { structural: line, openedMultiline: false, closedMultiline: false };
  const close = findMultilineClose(line, opening.delimiter, opening.index + opening.delimiter.length);
  if (close < 0) state.multiline = opening.delimiter;
  return {
    structural: line.slice(0, opening.index),
    openedMultiline: close < 0,
    closedMultiline: close >= 0,
  };
}

function normalizeTomlKeySegment(segment: string): string | null {
  const value = segment.trim();
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).includes("'") ? null : value.slice(1, -1);
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeTomlKeyPath(source: string): string[] | null {
  const segments: string[] = [];
  let rest = source;
  while (rest.length > 0) {
    const dot = findOutsideTomlQuotes(rest, '.');
    const raw = dot < 0 ? rest : rest.slice(0, dot);
    const segment = normalizeTomlKeySegment(raw);
    if (segment === null) return null;
    segments.push(segment);
    if (dot < 0) break;
    rest = rest.slice(dot + 1);
  }
  return segments.length > 0 ? segments : null;
}

function tomlHeaderPath(line: string): string[] | null {
  const value = withoutTomlComment(line).trim();
  const arrayTable = value.startsWith('[[') && value.endsWith(']]');
  if (!arrayTable && !(value.startsWith('[') && value.endsWith(']'))) return null;
  const inner = arrayTable ? value.slice(2, -2) : value.slice(1, -1);
  return normalizeTomlKeyPath(inner);
}

function isTimTable(path: string[]): boolean {
  return path[0] === 'mcp_servers' && path[1] === 'tim' && (
    path.length === 2 || (path.length === 3 && path[2] === 'env')
  );
}

function tomlAssignmentPath(line: string): string[] | null {
  const value = withoutTomlComment(line);
  const equals = findOutsideTomlQuotes(value, '=');
  return equals < 0 ? null : normalizeTomlKeyPath(value.slice(0, equals));
}

function isTopLevelTimAssignment(path: string[] | null): boolean {
  return Boolean(path && path[0] === 'mcp_servers' && path[1] === 'tim');
}

export function buildCodexMcpConfig(
  dbPath: string,
  options: TimMcpServerOptions = {},
): string {
  const entry = buildTimMcpEntry(dbPath, options);
  return [
    '[mcp_servers.tim]',
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(arg => tomlString(arg)).join(', ')}]`,
    '',
    '[mcp_servers.tim.env]',
    `TIM_DB_PATH = ${tomlString(dbPath)}`,
  ].join('\n');
}

export function replaceCodexTimMcpBlock(existing: string, block: string): string {
  const lines = existing.split(/\r?\n/);
  const out: string[] = [];
  const scanState: TomlScanState = { multiline: null };
  let atTopLevel = true;
  let inTimTable = false;
  let currentTable: string[] | null = null;
  let droppingTimMultiline = false;

  for (const line of lines) {
    const scanned = scanTomlStructuralLine(line, scanState);
    if (droppingTimMultiline) {
      if (scanned.closedMultiline) droppingTimMultiline = false;
      continue;
    }
    if (scanned.structural === null) {
      if (!inTimTable) out.push(line);
      continue;
    }

    const header = tomlHeaderPath(scanned.structural);
    if (header) {
      atTopLevel = false;
      currentTable = header;
      inTimTable = isTimTable(header);
      if (!inTimTable) out.push(line);
      continue;
    }
    if (inTimTable) {
      if (line.trim() === '' || line.trimStart().startsWith('#')) out.push(line);
      continue;
    }
    const assignment = tomlAssignmentPath(scanned.structural);
    if (
      currentTable?.length === 1 &&
      currentTable[0] === 'mcp_servers' &&
      assignment?.[0] === 'tim'
    ) {
      throw new Error(
        'Unsupported relative tim assignment under [mcp_servers]; cannot safely merge TIM MCP configuration.',
      );
    }
    if (atTopLevel) {
      if (assignment?.length === 1 && assignment[0] === 'mcp_servers') {
        throw new Error(
          'Unsupported top-level mcp_servers assignment; cannot safely merge TIM MCP configuration.',
        );
      }
      if (isTopLevelTimAssignment(assignment)) {
        droppingTimMultiline = scanned.openedMultiline;
        continue;
      }
    }
    out.push(line);
  }

  const preserved = out.join('\n').trimEnd();
  return `${preserved}${preserved ? '\n\n' : ''}${block.trimEnd()}\n`;
}

export function installCodexMcpConfig(
  dbPath: string,
  configPath = path.join(os.homedir(), '.codex', 'config.toml'),
  options: TimMcpServerOptions = {},
) {
  const block = buildCodexMcpConfig(dbPath, options);
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const next = replaceCodexTimMcpBlock(existing, block);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, `${configPath}.backup.${Date.now()}`);
  }
  fs.writeFileSync(configPath, next);
  return { installed: [{ tool: 'Codex', path: configPath }], skipped: [] };
}

export async function cmdSetupAgent(args: string[]): Promise<void> {
  const flags = parseArgs(args);
  const host = flags.host;
  if (!host) {
    console.error('Usage: tim setup-agent --host claude|codex|cursor|hermes [--dry-run]');
    process.exit(1);
  }
  try {
    assertAgentHost(host);
  } catch (e) {
    console.error((e as Error).message);
    console.error('Usage: tim setup-agent --host claude|codex|cursor|hermes [--dry-run]');
    process.exit(1);
  }

  const dryRun = flags['dry-run'] === 'true';
  const dbPath = getDbPath(loadConfig());
  const plan = buildSetupAgentPlan({ host });
  const tool = hostTool(host);

  if (dryRun) {
    console.log(JSON.stringify({
      host,
      dryRun: true,
      dbPath,
      plan,
      mcp: tool
        ? { action: 'would-install', tool: tool.name, path: tool.mcpConfigPath(true) }
        : host === 'codex'
          ? { action: 'would-install-toml', path: path.join(os.homedir(), '.codex', 'config.toml'), snippet: buildCodexMcpConfig(dbPath) }
          : { action: 'manual', reason: 'No JSON MCP installer exists for this host yet' },
      skills: { action: host === 'cursor' ? 'manual' : 'would-copy' },
      hooks: { action: host === 'hermes' ? 'would-install-hermes-statusline' : 'not-required' },
      smoke: { action: 'would-run-health-check', command: 'tim doctor' },
    }, null, 2));
    return;
  }

  const mcp = tool
    ? installMcpForHostTool(tool, dbPath, true)
    : host === 'codex'
      ? installCodexMcpConfig(dbPath)
    : {
        installed: [],
        skipped: [{
          tool: host,
          path: '',
          reason: 'No MCP installer exists for this host yet',
        }],
      };

  const skills = updateSkillsForHost(host);
  const hooks = host === 'hermes'
    ? await installHermesStatusline({ skipBuild: true })
    : { ok: true, steps: [{ step: 'hooks', status: 'skip' as const, detail: 'No host hook install needed' }] };

  const store = new TimStore(dbPath);
  try {
    const health = await store.health();
    console.log(JSON.stringify({
      host,
      dryRun: false,
      dbPath,
      plan,
      mcp,
      skills,
      hooks,
      smoke: {
        status: health.status,
        blockers: health.blockers,
        warnings: health.warnings,
        totalEntries: health.totalEntries,
        ftsIntegrity: health.ftsIntegrity,
      },
      nextSteps: [
        'Restart the agent host so MCP config and skills are reloaded.',
        'Run the tim-mcp-smoke skill or call tim_stats through MCP.',
      ],
    }, null, 2));
  } finally {
    store.close();
  }
}
