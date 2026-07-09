import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type TimConfigFile } from 'tim-core';
import { TimStore } from 'tim-store';
import { HOST_TOOLS, buildTimMcpEntry, installMcpForHostTool, type HostTool } from './install.js';
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

export function buildCodexMcpConfig(dbPath: string): string {
  const entry = buildTimMcpEntry(dbPath);
  return [
    '[mcp_servers.tim]',
    `command = "${entry.command}"`,
    `args = [${entry.args.map(arg => `"${arg}"`).join(', ')}]`,
    '',
    '[mcp_servers.tim.env]',
    `TIM_DB_PATH = "${dbPath}"`,
  ].join('\n');
}

export function replaceCodexTimMcpBlock(existing: string, block: string): string {
  const lines = existing.split(/\r?\n/);
  const out: string[] = [];
  let replaced = false;

  for (let i = 0; i < lines.length;) {
    const trimmed = lines[i].trim();
    if (trimmed === '[mcp_servers.tim]') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(...block.split('\n'));
      replaced = true;
      i++;

      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.startsWith('[') && t !== '[mcp_servers.tim]' && t !== '[mcp_servers.tim.env]') {
          if (out[out.length - 1] !== '') out.push('');
          break;
        }
        i++;
      }
      continue;
    }

    out.push(lines[i]);
    i++;
  }

  if (!replaced) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(...block.split('\n'));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function installCodexMcpConfig(dbPath: string, configPath = path.join(os.homedir(), '.codex', 'config.toml')) {
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const next = replaceCodexTimMcpBlock(existing, buildCodexMcpConfig(dbPath));
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
