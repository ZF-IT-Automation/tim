import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { TimStore } from 'tim-store';
import { McpClient } from './test-helpers/mcp-client.js';

describe('MCP wires projectPath for coding-task vcs detection', () => {
  let client: McpClient;
  let dbPath: string;
  let repoDir: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-vcs-mcp-'));
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    // Local marker so walk-up does not pick an ancestor .tim-project (e.g. /tmp).
    fs.writeFileSync(
      path.join(repoDir, '.tim-project'),
      JSON.stringify({
        version: 2,
        project: 'P9998',
        session: 'vcs-wiring',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      }),
      'utf8',
    );
    dbPath = path.join(repoDir, `tim-${Date.now()}.db`);
    client = new McpClient({
      dbPath,
      cwd: repoDir,
      env: { TIM_PROVENANCE: '0', TIM_DEDUP_CHECK: '0' },
      clientInfo: { name: 'vcs-wiring', version: '0.0.1' },
    });
    await client.init();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('tim_write sets task.vcs=git for coding tasks when server cwd is a git repo', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'Implement the feature',
      tags: ['#task', '#coding'],
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
    });
    expect(writeResp.result?.isError).not.toBe(true);
    const written = JSON.parse(writeResp.result!.content[0].text);
    const task = written.metadata?.task ?? written.entry?.metadata?.task;
    expect(task?.vcs).toBe('git');
  });

  it('tim_update sets task.vcs=git on first coding update when server cwd is a git repo', async () => {
    // Seed without projectPath so vcs stays unset until MCP update wires it.
    const store = new TimStore(dbPath);
    const seeded = await store.write('Coding task without vcs yet', {
      tags: ['#task', '#coding'],
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
    });
    expect((seeded.metadata.task as { vcs?: string }).vcs).toBeUndefined();
    store.close();

    const updateResp = await client.callTool('tim_update', {
      id: seeded.id,
      metadata: { task: { status: 'in_progress' } },
    });
    expect(updateResp.result?.isError).not.toBe(true);
    const updated = JSON.parse(updateResp.result!.content[0].text);
    const task = updated.metadata?.task ?? updated.entry?.metadata?.task;
    expect(task?.vcs).toBe('git');
  });
});
