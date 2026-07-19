// TIM MCP — harness session resolved from the store (marker v3 has no session field).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpClient } from './test-helpers/mcp-client.js';

function v3MarkerCwd(project = 'P8201'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-mcp-cwd-'));
  fs.writeFileSync(
    path.join(dir, '.tim-project'),
    JSON.stringify({ version: 3, project }),
  );
  return dir;
}

describe('marker session resolution via store', () => {
  let client: McpClient;
  let dbPath: string;
  let cwd: string;

  beforeEach(async () => {
    cwd = v3MarkerCwd('P8201');
    dbPath = path.join(cwd, 'test.db');
    client = new McpClient({
      dbPath,
      cwd,
      env: { TIM_PROVENANCE: '0', TIM_DEDUP_CHECK: '0' },
    });
    await client.init();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('tim_load_project bind uses resolveCurrentSession when sessionId omitted', async () => {
    await client.callTool('tim_create_project', {
      label: 'P8201',
      content: 'Bind test',
      memoryOnly: true,
    });
    const harnessId = `harness-${Date.now()}`;
    await client.callTool('tim_session_start', {
      sessionId: harnessId,
      projectId: 'P8201',
      cwd,
    });

    const loaded = await client.callTool('tim_load_project', { label: 'P8201', bind: true });
    expect(loaded.result?.isError).toBeFalsy();

    await client.callTool('tim_create_project', {
      label: 'P8202',
      content: 'Other',
      memoryOnly: true,
    });
    const rejected = await client.callTool('tim_load_project', { label: 'P8202', bind: true });
    expect(rejected.result?.isError).toBe(true);
    expect(rejected.result!.content[0].text).toContain('P8201');

    const marker = JSON.parse(fs.readFileSync(path.join(cwd, '.tim-project'), 'utf8'));
    expect(marker.version).toBe(3);
    expect(marker).not.toHaveProperty('session');
  });

  it('tim_session_resume does not write session into marker', async () => {
    await client.callTool('tim_create_project', {
      label: 'P8201',
      content: 'Resume test',
      memoryOnly: true,
    });
    const oldSession = `old-${Date.now()}`;
    const harnessId = `harness-${Date.now()}`;
    await client.callTool('tim_session_start', {
      sessionId: oldSession,
      projectId: 'P8201',
      cwd,
    });
    await client.callTool('tim_session_log', {
      sessionId: oldSession,
      entries: [{ role: 'user', content: 'hello' }],
    });

    client.kill();
    client = new McpClient({
      dbPath,
      cwd,
      env: {
        TIM_SESSION_ID: harnessId,
        TIM_PROVENANCE: '0',
        TIM_DEDUP_CHECK: '0',
      },
    });
    await client.init();
    await client.callTool('tim_session_start', {
      sessionId: harnessId,
      projectId: 'P8201',
      cwd,
    });

    const before = fs.readFileSync(path.join(cwd, '.tim-project'), 'utf8');
    const resumed = await client.callTool('tim_session_resume', { sessionId: oldSession });
    expect(resumed.result?.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(cwd, '.tim-project'), 'utf8')).toEqual(before);

    const marker = JSON.parse(fs.readFileSync(path.join(cwd, '.tim-project'), 'utf8'));
    expect(marker).not.toHaveProperty('session');
  });
});
