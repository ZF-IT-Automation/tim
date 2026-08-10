// TIM MCP — tim_write_many batch writes with per-entry error isolation

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { McpClient, isolatedCwd } from './test-helpers/mcp-client.js';

describe('tim_write_many', () => {
  let client: McpClient;
  let dir: string;
  let cwd: string;
  let sectionId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-write-many-'));
    cwd = isolatedCwd({ project: 'P9000' });
    client = new McpClient({
      dbPath: path.join(dir, 'test.db'),
      cwd,
      env: { TIM_PROVENANCE: '0' },
      clientInfo: { name: 'write-many', version: '0.0.1' },
    });
    await client.init();

    const proj = await client.callTool('tim_create_project', {
      label: 'P9000',
      content: 'Batch Proj',
      memoryOnly: true,
    });
    const project = JSON.parse(proj.result!.content![0].text);
    const section = await client.callTool('tim_write', {
      content: 'Notes',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    sectionId = JSON.parse(section.result!.content![0].text).id;
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('writes every entry of a batch and returns their ids', async () => {
    const res = await client.callTool('tim_write_many', {
      entries: [
        { content: 'Batch note one\nBody one.', parentId: sectionId, tags: ['#batch', '#one'] },
        { content: 'Batch note two\nBody two.', parentId: sectionId, tags: ['#batch', '#two'] },
        { content: 'Batch note three\nBody three.', parentId: sectionId, tags: ['#batch', '#three'] },
      ],
    });

    expect(res.result?.isError).toBeFalsy();
    const body = JSON.parse(res.result!.content![0].text);
    expect(body.failed).toEqual([]);
    expect(body.created.map((c: { title: string }) => c.title)).toEqual([
      'Batch note one',
      'Batch note two',
      'Batch note three',
    ]);

    for (const created of body.created) {
      const read = await client.callTool('tim_read', { id: created.id, include_body: true });
      expect(read.result?.isError).toBeFalsy();
    }
  });

  it('isolates a failing entry: the rest are written and the failure names its index', async () => {
    // Entry 1 trips the dedup gate against entry 0 of the same batch, which
    // only works because entries are written one after another, not staged.
    const res = await client.callTool('tim_write_many', {
      entries: [
        { content: 'Reminder System via Cron Checker\nDesign.', parentId: sectionId, tags: ['#reminder', '#design'] },
        { content: 'Reminder System Cron Checker\nOther design.', parentId: sectionId, tags: ['#reminder', '#design'] },
        { content: 'Unrelated third note\nBody.', parentId: sectionId, tags: ['#other', '#note'] },
      ],
    });

    const body = JSON.parse(res.result!.content![0].text);
    expect(body.created.map((c: { title: string }) => c.title)).toEqual([
      'Reminder System via Cron Checker',
      'Unrelated third note',
    ]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].index).toBe(1);
    expect(body.failed[0].error).toContain('duplicate_suspected');
  });

  it('reports an unresolvable placement per entry rather than failing the call', async () => {
    const res = await client.callTool('tim_write_many', {
      entries: [
        { content: 'Placed note\nBody.', parentId: sectionId, tags: ['#placed', '#ok'] },
        { content: 'Lost note\nBody.', where: 'P9999/Nowhere', tags: ['#lost', '#bad'] },
      ],
    });

    const body = JSON.parse(res.result!.content![0].text);
    expect(body.created).toHaveLength(1);
    expect(body.failed[0].index).toBe(1);
    expect(body.failed[0].error).toContain('project not found');
  });

  it('rejects the call when the batch is empty or over the cap', async () => {
    const empty = await client.callTool('tim_write_many', { entries: [] });
    expect(empty.result?.isError).toBe(true);

    const tooMany = await client.callTool('tim_write_many', {
      entries: Array.from({ length: 101 }, (_, i) => ({
        content: `Capped note ${i}\nBody.`,
        parentId: sectionId,
        tags: ['#capped', '#note'],
      })),
    });
    expect(tooMany.result?.isError).toBe(true);
  });
});
