import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tim-compact-cron-'));
  directories.push(dir);
  const bin = join(dir, 'bin');
  const helpers = join(dir, 'helpers');
  mkdirSync(bin);
  mkdirSync(helpers);
  const executable = (file, body) => writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // Redirect only helper locations, so even the old destructive script cannot
  // reach installed services. Its real stop helper may signal ONLY our child.
  const source = readFileSync(process.env.TIM_COMPACT_TEST_SCRIPT ?? join(root, 'scripts/tim-compact-error-log.sh'), 'utf8')
    .replaceAll('${HOME}/.hermes/scripts', '${TIM_TEST_HELPERS}');
  const script = join(dir, 'compact.sh');
  writeFileSync(script, source);
  writeFileSync(join(helpers, 'tim-mcp-stop.sh'), readFileSync(join(root, 'scripts/tim-mcp-stop.sh')), { mode: 0o755 });
  executable(join(helpers, 'tim-mcp-start.sh'), 'echo unexpected-start >> "$TIM_TEST_CALLS"');
  for (const manager of ['systemctl', 'launchctl', 'pm2']) executable(join(bin, manager), 'exit 1');
  executable(join(bin, 'pgrep'), `
if [[ "$TIM_TEST_RACE" == "1" && ! -f "$TIM_TEST_SCAN" ]]; then
  touch "$TIM_TEST_SCAN"
  exit 1
fi
if [[ "$TIM_TEST_PGREP_RC" != "" ]]; then exit "$TIM_TEST_PGREP_RC"; fi
if [[ -n "$TIM_TEST_PID" ]] && kill -0 "$TIM_TEST_PID" 2>/dev/null; then
  echo "$TIM_TEST_PID"
else
  exit 1
fi`);
  return {
    dir, script,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TIM_ROOT: root,
      TIM_NODE: process.execPath,
      TIM_DB_PATH: join(dir, 'tim.db'),
      TIM_MARKER_MAX_ROOT: dir,
      TIM_COMPACT_LOCK: join(dir, 'compact.lock'),
      TIM_TEST_HELPERS: helpers,
      TIM_TEST_CALLS: join(dir, 'calls'),
      TIM_TEST_SCAN: join(dir, 'scan'),
    },
  };
}

async function run(f) {
  try {
    return { ...(await exec('bash', [f.script], { env: f.env, cwd: f.dir, timeout: 10000 })), code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

async function connect(f) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'packages/tim-mcp/dist/server.js')],
    cwd: f.dir,
    env: { ...f.env, HERMES_SKIP_DB_GUARD: '1' },
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'cron-regression', version: '1' });
  await client.connect(transport);
  return { client, transport };
}

describe('unattended error_log compaction', () => {
  it('preserves an established stdio MCP connection and defers maintenance', async () => {
    const f = fixture();
    const { client, transport } = await connect(f);
    try {
      expect((await client.callTool({ name: 'tim_stats', arguments: {} })).isError).not.toBe(true);
      expect((await client.callTool({
        name: 'tim_create_project', arguments: { label: 'P0001', memoryOnly: true },
      })).isError).not.toBe(true);
      f.env.TIM_TEST_PID = String(transport.pid);
      const result = await run(f);
      // This is the user-visible failure: tools on the same connection must
      // remain callable after the nightly job, with no restart or reconnect.
      expect((await client.callTool({ name: 'tim_read', arguments: { id: 'P0001' } })).isError).not.toBe(true);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('SKIP:');
    } finally {
      await client.close();
    }
  }, 15000);

  it('still compacts a quiescent database without starting servers', async () => {
    const f = fixture();
    const { client } = await connect(f);
    await client.close();
    f.env.TIM_TEST_PGREP_RC = '1';
    const result = await run(f);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok":true');
    expect(result.stdout).toContain('done');
    expect(() => readFileSync(f.env.TIM_TEST_CALLS)).toThrow();
  }, 15000);

  it('fails closed when process discovery fails', async () => {
    const f = fixture();
    f.env.TIM_TEST_PGREP_RC = '2';
    const result = await run(f);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('pgrep');
    expect(() => readFileSync(f.env.TIM_TEST_CALLS)).toThrow();
  });

  it('lets the CLI refuse a writer that appears after the preflight', async () => {
    const f = fixture();
    const { client, transport } = await connect(f);
    try {
      f.env.TIM_TEST_PID = String(transport.pid);
      f.env.TIM_TEST_RACE = '1';
      const result = await run(f);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('writers still hold the DB');
      expect((await client.callTool({ name: 'tim_stats', arguments: {} })).isError).not.toBe(true);
      expect(() => readFileSync(f.env.TIM_TEST_CALLS)).toThrow();
    } finally {
      await client.close();
    }
  }, 15000);
});
