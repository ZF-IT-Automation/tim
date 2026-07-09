import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ReleaseCheckStep {
  id: string;
  command?: string;
}

export interface ReleaseCheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ReleaseCheckSummary {
  status: 'OK' | 'BLOCKER';
  blockers: string[];
  results: ReleaseCheckResult[];
}

export interface ReleaseCheckOptions {
  beta?: boolean;
  skipTests?: boolean;
}

function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  }).trim();
}

function getRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

function getCliPath(): string {
  return path.resolve(__dirname, 'cli.js');
}

function getMcpServerPath(): string {
  return path.resolve(__dirname, '..', '..', 'tim-mcp', 'dist', 'server.js');
}

function clip(text: string, limit = 1200): string {
  const normalized = text.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}…`;
}

function formatFailure(prefix: string, details: { stdout: string; stderr: string; timeout?: boolean }): string {
  const parts = [prefix];
  if (details.timeout) parts.push('timeout');
  if (details.stdout.trim()) parts.push(`stdout=${clip(details.stdout)}`);
  if (details.stderr.trim()) parts.push(`stderr=${clip(details.stderr)}`);
  return parts.join(' | ');
}

function createTempDbWorkspace(prefix: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, 'tim.db') };
}

function removeTempDbWorkspace(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup only, and only for the exact temp dir created here.
  }
}

interface JsonRpcResp {
  id?: number;
  result?: {
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

class StdioJsonRpcClient {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (msg: JsonRpcResp) => void; reject: (err: Error) => void }>();
  private stdout = '';
  private stderr = '';

  constructor(private proc: ChildProcess, private timeoutMs = 7000) {
    proc.stdout?.on('data', chunk => {
      this.stdout += chunk.toString('utf8');
      this.onData(chunk.toString('utf8'));
    });
    proc.stderr?.on('data', chunk => {
      this.stderr += chunk.toString('utf8');
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResp;
        if (msg.id != null && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      } catch {
        // ignore non-JSON noise
      }
    }
  }

  request(method: string, params: unknown): Promise<JsonRpcResp> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: msg => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.proc.stdin?.write(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  diagnostics(): { stdout: string; stderr: string } {
    return { stdout: this.stdout, stderr: this.stderr };
  }
}

export function buildReleaseCheckPlan(options: ReleaseCheckOptions = {}): ReleaseCheckStep[] {
  const plan: ReleaseCheckStep[] = [
    { id: 'git-clean', command: 'git status --short --branch' },
    { id: 'build', command: 'npm run build' },
    { id: 'tests', command: 'npm test' },
    { id: 'pack', command: 'npm pack --dry-run --workspaces' },
  ];

  if (options.beta) {
    plan.push(
      { id: 'cli-smoke', command: 'tim --help && tim doctor' },
      { id: 'mcp-smoke', command: 'tim-mcp smoke via tim_doctor' },
    );
  }

  plan.push(
    { id: 'large-files', command: 'git ls-files -s' },
    { id: 'git-clean-after', command: 'git status --short --branch' },
  );
  return plan;
}

export function summarizeReleaseCheck(results: ReleaseCheckResult[]): ReleaseCheckSummary {
  const blockers = results.filter(r => !r.ok).map(r => `${r.id}: ${r.detail}`);
  return { status: blockers.length ? 'BLOCKER' : 'OK', blockers, results };
}

async function runMcpDoctorSmoke(repoRoot: string, tempDb: string): Promise<ReleaseCheckResult> {
  const serverPath = getMcpServerPath();
  if (!fs.existsSync(serverPath)) {
    return {
      id: 'mcp-smoke',
      ok: false,
      detail: `missing tim-mcp dist at ${serverPath}`,
    };
  }

  const proc = spawn('node', [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, TIM_DB_PATH: tempDb },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new StdioJsonRpcClient(proc);

  const stop = async (): Promise<void> => {
    if (proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 100));
      if (proc.exitCode == null && proc.signalCode == null) {
        proc.kill('SIGKILL');
      }
    }
  };

  try {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tim-release-check', version: '0.0.0' },
    });
    if (init.error) {
      return {
        id: 'mcp-smoke',
        ok: false,
        detail: formatFailure('initialize failed', client.diagnostics()),
      };
    }

    client.notify('notifications/initialized');

    const resp = await client.request('tools/call', {
      name: 'tim_doctor',
      arguments: {},
    });
    if (resp.error) {
      return {
        id: 'mcp-smoke',
        ok: false,
        detail: formatFailure(`tim_doctor error: ${resp.error.message ?? 'unknown'}`, client.diagnostics()),
      };
    }

    const text = resp.result?.content?.[0]?.text ?? '';
    if (!text.includes('TIM Doctor') || !text.includes('Status:')) {
      return {
        id: 'mcp-smoke',
        ok: false,
        detail: formatFailure('tim_doctor response missing expected text', {
          ...client.diagnostics(),
          stdout: `${client.diagnostics().stdout}\n${text}`,
        }),
      };
    }

    return {
      id: 'mcp-smoke',
      ok: true,
      detail: 'ok',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'mcp smoke failed';
    return {
      id: 'mcp-smoke',
      ok: false,
      detail: formatFailure(message, client.diagnostics()),
    };
  } finally {
    await stop();
    removeTempDbWorkspace(path.dirname(tempDb));
  }
}

export async function runReleaseCheck(options: ReleaseCheckOptions = {}): Promise<ReleaseCheckSummary> {
  const repoRoot = getRepoRoot();
  const cliPath = getCliPath();
  const results: ReleaseCheckResult[] = [];
  const plan = buildReleaseCheckPlan(options);

  for (const step of plan) {
    if (step.id === 'tests' && options.skipTests) {
      results.push({
        id: step.id,
        ok: true,
        detail: 'skipped via --skip-tests true',
      });
      continue;
    }

    try {
      switch (step.id) {
        case 'git-clean': {
          const out = runCommand('git', ['status', '--short', '--branch'], repoRoot);
          const lines = out.split(/\r?\n/).filter(Boolean);
          const dirty = lines.filter(line => !line.startsWith('##'));
          if (dirty.length > 0) {
            results.push({
              id: step.id,
              ok: false,
              detail: dirty.slice(0, 5).join('; '),
            });
          } else {
            results.push({ id: step.id, ok: true, detail: 'clean' });
          }
          break;
        }
        case 'build': {
          runCommand('npm', ['run', 'build'], repoRoot);
          results.push({ id: step.id, ok: true, detail: 'ok' });
          break;
        }
        case 'tests': {
          runCommand('npm', ['test'], repoRoot);
          results.push({ id: step.id, ok: true, detail: 'ok' });
          break;
        }
        case 'pack': {
          runCommand('npm', ['pack', '--dry-run', '--workspaces'], repoRoot);
          results.push({ id: step.id, ok: true, detail: 'ok' });
          break;
        }
        case 'cli-smoke': {
          const workspace = createTempDbWorkspace('tim-release-check-cli-');
          try {
            runCommand('node', [cliPath, '--help'], repoRoot);
            runCommand('node', [cliPath, 'doctor'], repoRoot, { TIM_DB_PATH: workspace.dbPath });
            results.push({ id: step.id, ok: true, detail: 'ok' });
          } finally {
            removeTempDbWorkspace(workspace.dir);
          }
          break;
        }
        case 'mcp-smoke': {
          const workspace = createTempDbWorkspace('tim-release-check-mcp-');
          results.push(await runMcpDoctorSmoke(repoRoot, workspace.dbPath));
          removeTempDbWorkspace(workspace.dir);
          break;
        }
        case 'git-clean-after': {
          const out = runCommand('git', ['status', '--short', '--branch'], repoRoot);
          const lines = out.split(/\r?\n/).filter(Boolean);
          const dirty = lines.filter(line => !line.startsWith('##'));
          if (dirty.length > 0) {
            results.push({
              id: step.id,
              ok: false,
              detail: dirty.slice(0, 5).join('; '),
            });
          } else {
            results.push({ id: step.id, ok: true, detail: 'clean' });
          }
          break;
        }
        case 'large-files': {
          runCommand('git', ['ls-files', '-s'], repoRoot);
          results.push({ id: step.id, ok: true, detail: 'ok' });
          break;
        }
        default: {
          results.push({ id: step.id, ok: true, detail: step.command ?? 'not run' });
          break;
        }
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'command failed';
      results.push({ id: step.id, ok: false, detail: message });
    }
  }

  return summarizeReleaseCheck(results);
}
