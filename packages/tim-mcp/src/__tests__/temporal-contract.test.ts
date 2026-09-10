// TIM MCP — temporal validity and supersession contract (#36)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { McpClient, isolatedCwd } from './test-helpers/mcp-client.js';
import { TimStore } from 'tim-store';

describe('temporal memory contract (#36)', () => {
  let client: McpClient;
  let store: TimStore;
  let dir: string;
  let cwd: string;
  let sectionId: string;
  const effectiveAt = '2026-03-15T12:00:00Z';
  const beforeEffective = '2026-03-15T11:59:59Z';
  const afterEffective = '2026-03-15T12:00:01Z';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-temporal-'));
    cwd = isolatedCwd({ project: 'P3600' });
    const dbPath = path.join(dir, 'test.db');
    client = new McpClient({
      dbPath,
      cwd,
      env: { TIM_PROVENANCE: '0', TIM_DEDUP_CHECK: '0' },
      clientInfo: { name: 'temporal-contract', version: '0.0.1' },
    });
    await client.init();
    store = new TimStore(dbPath);

    const proj = await client.callTool('tim_create_project', {
      label: 'P3600',
      content: 'Temporal project',
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

  async function writeDecision(title: string, body: string, metadata?: Record<string, unknown>) {
    const written = await client.callTool('tim_write', {
      content: `${title}\n${body}`,
      parentId: sectionId,
      tags: ['#decision', '#note'],
      metadata: {
        evidence: { authority: 'user_asserted', sources: [] },
        ...metadata,
      },
    });
    expect(written.result?.isError).toBeFalsy();
    return JSON.parse(written.result!.content![0].text).id as string;
  }

  it('supersedes old decision and exposes temporal state on read', async () => {
    const oldId = await writeDecision('Old policy', 'Use HTTP/1.1 only.');
    const newId = await writeDecision('New policy', 'Use HTTP/2.');

    const linked = await client.callTool('tim_link', {
      sourceId: newId,
      targetId: oldId,
      type: 'supersedes',
      metadata: { effectiveAt },
    });
    expect(linked.result?.isError).toBeFalsy();

    const oldRead = JSON.parse((await client.callTool('tim_read', {
      id: oldId,
      include_body: true,
    })).result!.content![0].text);
    expect(oldRead.entry.temporal.state).toBe('superseded');
    expect(oldRead.entry.temporal.superseded_at).toBe('2026-03-15T12:00:00.000Z');
    expect(oldRead.entry.content).toContain('HTTP/1.1');
    expect(oldRead.entry.evidence.authority).toBe('user_asserted');

    const newRead = JSON.parse((await client.callTool('tim_read', { id: newId })).result!.content![0].text);
    expect(newRead.entry.temporal.state).toBe('current');
    expect(newRead.entry.temporal.supersedes).toEqual([
      { entryId: oldId, status: 'available', title: 'Old policy' },
    ]);
  });

  it('default search excludes superseded entries; asOf reconstructs history', async () => {
    const oldId = await writeDecision('Latency target', 'p99 under 200ms');
    const newId = await writeDecision('Latency target v2', 'p99 under 100ms');
    await client.callTool('tim_link', {
      sourceId: newId,
      targetId: oldId,
      type: 'supersedes',
      metadata: { effectiveAt },
    });

    const current = await client.callTool('tim_search', {
      query: 'Latency target',
      root: 'P3600',
      searchType: 'fts',
    });
    const currentBody = JSON.parse(current.result!.content![0].text);
    const currentIds = (currentBody.results as Array<{ id: string }>).map(r => r.id);
    expect(currentIds).toContain(newId);
    expect(currentIds).not.toContain(oldId);

    const historical = await client.callTool('tim_search', {
      query: 'Latency target',
      root: 'P3600',
      searchType: 'fts',
      asOf: beforeEffective,
    });
    const historicalBody = JSON.parse(historical.result!.content![0].text);
    const historicalIds = (historicalBody.results as Array<{ id: string }>).map(r => r.id);
    expect(historicalIds).toContain(oldId);
    expect(historicalIds).not.toContain(newId);

    const after = await client.callTool('tim_search', {
      query: 'Latency target',
      root: 'P3600',
      searchType: 'fts',
      asOf: afterEffective,
    });
    const afterBody = JSON.parse(after.result!.content![0].text);
    const afterIds = (afterBody.results as Array<{ id: string }>).map(r => r.id);
    expect(afterIds).toContain(newId);
    expect(afterIds).not.toContain(oldId);
  });

  it('preserves contradicts links and reports unresolved conflicts', async () => {
    const a = await writeDecision('Claim A', 'Blue is best.');
    const b = await writeDecision('Claim B', 'Red is best.');
    await client.callTool('tim_link', {
      sourceId: a,
      targetId: b,
      type: 'contradicts',
    });

    const read = JSON.parse((await client.callTool('tim_read', { id: a })).result!.content![0].text);
    expect(read.entry.temporal.contradictions).toEqual([
      { entryId: b, status: 'available', title: 'Claim B' },
    ]);
  });

  it('rejects forged supersededBy via metadata update without changing store', async () => {
    const oldId = await writeDecision('Immutable', 'Original body');
    const stagingBefore = (await store.getStaging()).length;

    const bad = await client.callTool('tim_update', {
      id: oldId,
      metadata: {
        temporal: { supersededBy: '01FAKEFAKEFAKEFAKEFAKEFAKEFA' },
      },
    });
    expect(bad.result?.isError).toBe(true);

    const row = await store.read(oldId);
    expect(row?.content).toContain('Original body');
    expect((await store.getStaging()).length).toBe(stagingBefore);
  });

  it('rejects cross-project supersession without mutation', async () => {
    const otherProj = await client.callTool('tim_create_project', {
      label: 'P3601',
      content: 'Other project',
      memoryOnly: true,
    });
    const other = JSON.parse(otherProj.result!.content![0].text);
    const otherSection = await client.callTool('tim_write', {
      content: 'Other notes',
      parentId: other.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const otherSectionId = JSON.parse(otherSection.result!.content![0].text).id;
    const remote = JSON.parse((await client.callTool('tim_write', {
      content: 'Remote\nElsewhere.',
      parentId: otherSectionId,
      tags: ['#note'],
    })).result!.content![0].text).id;

    const local = await writeDecision('Local', 'Here.');
    const stagingBefore = (await store.getStaging()).length;

    const bad = await client.callTool('tim_link', {
      sourceId: local,
      targetId: remote,
      type: 'supersedes',
      metadata: { effectiveAt },
    });
    expect(bad.result?.isError).toBe(true);
    expect((await store.getStaging()).length).toBe(stagingBefore);
  });

  it('rejects self-supersession and long-cycle attempts', async () => {
    const a = await writeDecision('A', 'First');
    const b = await writeDecision('B', 'Second');
    const c = await writeDecision('C', 'Third');

    const self = await client.callTool('tim_link', {
      sourceId: a,
      targetId: a,
      type: 'supersedes',
      metadata: { effectiveAt },
    });
    expect(self.result?.isError).toBe(true);

    await client.callTool('tim_link', {
      sourceId: b,
      targetId: a,
      type: 'supersedes',
      metadata: { effectiveAt: '2026-01-01T00:00:00Z' },
    });
    await client.callTool('tim_link', {
      sourceId: c,
      targetId: b,
      type: 'supersedes',
      metadata: { effectiveAt: '2026-02-01T00:00:00Z' },
    });

    const cycle = await client.callTool('tim_link', {
      sourceId: a,
      targetId: c,
      type: 'supersedes',
      metadata: { effectiveAt: '2026-04-01T00:00:00Z' },
    });
    expect(cycle.result?.isError).toBe(true);
  });

  it('rejects invalid timestamps and bulk temporal bypass', async () => {
    const invalidWrite = await client.callTool('tim_write', {
      content: 'Bad dates\nNope.',
      parentId: sectionId,
      metadata: {
        temporal: {
          validFrom: '2026-01-01T00:00:00',
          validUntil: '2025-01-01T00:00:00Z',
        },
      },
    });
    expect(invalidWrite.result?.isError).toBe(true);

    const bulk = await client.callTool('tim_write_many', {
      entries: [
        { content: 'Ok\nFine.', parentId: sectionId },
        {
          content: 'Bypass\nNope.',
          parentId: sectionId,
          metadata: { temporal: { supersededAt: '2026-01-01T00:00:00Z' } },
        },
      ],
    });
    expect(bulk.result?.isError).toBe(true);
    const staging = await store.getStaging();
    expect(staging.some(r => r.payload.includes('Bypass'))).toBe(false);
  });

  it('preserves superseded_by through read/update round-trip', async () => {
    const oldId = await writeDecision('Round trip', 'Original');
    const newId = await writeDecision('Round trip v2', 'Updated');
    await client.callTool('tim_link', {
      sourceId: newId,
      targetId: oldId,
      type: 'supersedes',
      metadata: { effectiveAt },
    });

    const updated = await client.callTool('tim_update', {
      id: oldId,
      content: 'Round trip\nEdited body',
      metadata: { task: { status: 'done' } },
    });
    expect(updated.result?.isError).toBeFalsy();

    const read = JSON.parse((await client.callTool('tim_read', {
      id: oldId,
      include_body: true,
    })).result!.content![0].text);
    expect(read.entry.temporal.superseded_by?.entryId).toBe(newId);
    expect(read.entry.content).toContain('Edited body');
  });

  it('leaves accessed_at and updated_at unchanged when supersession fails', async () => {
    const source = await writeDecision('Atomic source', 'Src');
    const target = await writeDecision('Atomic target', 'Tgt');
    const sourceBefore = await store.read(source);
    const targetBefore = await store.read(target);
    const edgesBefore = store.getDb().prepare('SELECT * FROM edges').all();
    const stagingBefore = (await store.getStaging()).length;

    const bad = await client.callTool('tim_link', {
      sourceId: source,
      targetId: target,
      type: 'supersedes',
      metadata: { effectiveAt: '2026-02-31T00:00:00Z' },
    });
    expect(bad.result?.isError).toBe(true);

    const sourceAfter = await store.read(source);
    const targetAfter = await store.read(target);
    expect(sourceAfter?.accessedAt).toBe(sourceBefore?.accessedAt);
    expect(sourceAfter?.updatedAt).toBe(sourceBefore?.updatedAt);
    expect(targetAfter?.accessedAt).toBe(targetBefore?.accessedAt);
    expect(targetAfter?.updatedAt).toBe(targetBefore?.updatedAt);
    expect(store.getDb().prepare('SELECT * FROM edges').all()).toEqual(edgesBefore);
    expect((await store.getStaging()).length).toBe(stagingBefore);
  });
});
