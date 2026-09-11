import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import { executeTimSearch } from '../tim-search-tool.js';
import { McpClient, isolatedCwd } from './test-helpers/mcp-client.js';

describe('review-fix tim_search tag temporal contract', () => {
  let dir: string;
  let store: TimStore;
  let sectionId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-review-fix-tagsearch-'));
    store = new TimStore(path.join(dir, 'test.db'));
    const project = await store.createProject('P3600', { content: 'Tag search fix', memoryOnly: true });
    const section = await store.write('Decisions', {
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    sectionId = section.id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tag-only search excludes superseded entries and validates asOf', async () => {
    const oldDecision = await store.write('Old policy\nDeploy on Fridays', {
      parentId: sectionId,
      tags: ['#decision'],
    });
    const newDecision = await store.write('New policy\nNever deploy on Fridays', {
      parentId: sectionId,
      tags: ['#decision'],
    });
    await store.link(newDecision.id, oldDecision.id, 'supersedes', 1, {
      effectiveAt: '2020-01-01T00:00:00Z',
    });

    const tagOnly = await executeTimSearch(store, { tag: '#decision', topK: 10 });
    expect(tagOnly.results.map(e => e.id)).not.toContain(oldDecision.id);

    await expect(executeTimSearch(store, { tag: '#decision', topK: 10, asOf: 'yesterday' }))
      .rejects.toThrow(/Invalid asOf/);

    const historical = await executeTimSearch(store, {
      tag: '#decision',
      topK: 10,
      asOf: '2019-01-01T00:00:00Z',
    });
    expect(historical.results.map(e => e.id)).toContain(oldDecision.id);
  });
});

describe('review-fix tim_unlink MCP contract', () => {
  let client: McpClient;
  let store: TimStore;
  let dir: string;
  let cwd: string;
  let sectionId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-review-fix-unlink-'));
    cwd = isolatedCwd({ project: 'P3600' });
    const dbPath = path.join(dir, 'test.db');
    client = new McpClient({
      dbPath,
      cwd,
      env: { TIM_PROVENANCE: '0', TIM_DEDUP_CHECK: '0' },
      clientInfo: { name: 'review-fix-unlink', version: '0.0.1' },
    });
    await client.init();
    store = new TimStore(dbPath);

    const proj = await client.callTool('tim_create_project', {
      label: 'P3600',
      content: 'Unlink project',
      memoryOnly: true,
    });
    const project = JSON.parse(proj.result!.content![0].text);
    const section = await client.callTool('tim_write', {
      content: 'Decisions',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    sectionId = JSON.parse(section.result!.content![0].text).id;
  });

  afterEach(() => {
    client.kill();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function writeDecision(title: string, body: string) {
    const written = await client.callTool('tim_write', {
      content: `${title}\n${body}`,
      parentId: sectionId,
      tags: ['#decision'],
    });
    return JSON.parse(written.result!.content![0].text).id as string;
  }

  it('tim_unlink restores mistaken supersession and tim_update rejects temporal:null', async () => {
    const oldId = await writeDecision('Old policy', 'Deploy on Fridays');
    const wrongId = await writeDecision('Wrong target', 'Unrelated');
    const linked = await client.callTool('tim_link', {
      sourceId: wrongId,
      targetId: oldId,
      type: 'supersedes',
      metadata: { effectiveAt: '2020-01-01T00:00:00Z' },
    });
    const edge = JSON.parse(linked.result!.content![0].text);

    const unlinked = await client.callTool('tim_unlink', { edgeId: edge.id });
    expect(unlinked.result?.isError).toBeFalsy();

    const search = await client.callTool('tim_search', {
      tag: '#decision',
      topK: 10,
    });
    const body = JSON.parse(search.result!.content![0].text);
    expect((body.results as Array<{ id: string }>).map(r => r.id)).toContain(oldId);

    const nullTemporal = await client.callTool('tim_update', {
      id: oldId,
      metadata: { temporal: null },
    });
    expect(nullTemporal.result?.isError).toBe(true);
  });

  it('exposes explicit unmanaged-edge repair without bypassing managed-state guards', async () => {
    const targetId = await writeDecision('Imported target', 'Still current');
    const sourceId = await writeDecision('Imported source', 'Unmanaged relationship');
    store.getDb().prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
      VALUES ('imported-unmanaged', ?, ?, 'supersedes', 1, '{}', ?)`).run(sourceId, targetId, new Date().toISOString());
    const before = (await store.read(targetId))!.metadata;
    const rejected = await client.callTool('tim_unlink', { edgeId: 'imported-unmanaged' });
    expect(rejected.result?.isError).toBe(true);
    const repaired = await client.callTool('tim_unlink', { edgeId: 'imported-unmanaged', discardUnmanaged: true });
    expect(repaired.result?.isError).toBeFalsy();
    expect((await store.read(targetId))!.metadata).toEqual(before);
    expect(await store.getEdges(sourceId)).toHaveLength(0);

    const managed = await store.link(sourceId, targetId, 'supersedes', 1, { effectiveAt: '2020-01-01T00:00:00Z' });
    const guarded = await client.callTool('tim_unlink', { edgeId: managed.id, discardUnmanaged: true });
    expect(guarded.result?.isError).toBe(true);
    expect((await store.getEdges(sourceId)).map(edge => edge.id)).toContain(managed.id);
  });
});
