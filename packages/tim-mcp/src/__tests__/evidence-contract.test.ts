// TIM MCP — memory evidence write/read contract (#35)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { McpClient, isolatedCwd } from './test-helpers/mcp-client.js';
import { TimStore } from 'tim-store';
import { createV2HmemDatabase } from 'tim-migrate';
import { tim_import } from 'tim-migrate';

describe('memory evidence contract (#35)', () => {
  let client: McpClient;
  let dir: string;
  let cwd: string;
  let sectionId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-evidence-'));
    cwd = isolatedCwd({ project: 'P3500' });
    client = new McpClient({
      dbPath: path.join(dir, 'test.db'),
      cwd,
      env: { TIM_PROVENANCE: '0', TIM_DEDUP_CHECK: '0' },
      clientInfo: { name: 'evidence-contract', version: '0.0.1' },
    });
    await client.init();

    const proj = await client.callTool('tim_create_project', {
      label: 'P3500',
      content: 'Evidence project',
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

  it('write -> read round-trips evidence with source projection', async () => {
    const target = await client.callTool('tim_write', {
      content: 'Source note\nBody.',
      parentId: sectionId,
      tags: ['#source', '#note'],
    });
    const targetId = JSON.parse(target.result!.content![0].text).id;

    const written = await client.callTool('tim_write', {
      content: 'Claim note\nDerived from source.',
      parentId: sectionId,
      tags: ['#claim', '#note'],
      metadata: {
        evidence: {
          authority: 'agent_derived',
          sources: [{ kind: 'entry', entryId: targetId }],
        },
      },
    });
    expect(written.result?.isError).toBeFalsy();
    const claimId = JSON.parse(written.result!.content![0].text).id;

    const read = await client.callTool('tim_read', { id: claimId });
    const body = JSON.parse(read.result!.content![0].text);
    expect(body.entry.evidence.authority).toBe('agent_derived');
    expect(body.entry.evidence.authority_recorded).toBe(true);
    expect(body.entry.evidence.sources).toEqual([
      { kind: 'entry', status: 'available', entryId: targetId },
    ]);
    expect(body.entry.evidence.disclaimer).toContain('not authentication');
  });

  it('omits default evidence and temporal on legacy reads', async () => {
    const written = await client.callTool('tim_write', {
      content: 'Legacy note\nNo evidence metadata.',
      parentId: sectionId,
      tags: ['#legacy', '#note'],
    });
    const id = JSON.parse(written.result!.content![0].text).id;
    const read = await client.callTool('tim_read', { id });
    const body = JSON.parse(read.result!.content![0].text);
    expect(body.entry.evidence).toBeUndefined();
    expect(body.entry.temporal).toBeUndefined();
  });

  it('tim_write_many rejects malformed evidence atomically before any write', async () => {
    const marker = await client.callTool('tim_write', {
      content: 'Marker note\nBefore batch.',
      parentId: sectionId,
      tags: ['#marker', '#before'],
    });
    const markerId = JSON.parse(marker.result!.content![0].text).id;

    const res = await client.callTool('tim_write_many', {
      entries: [
        {
          content: 'Good note\nBody.',
          parentId: sectionId,
          tags: ['#good', '#note'],
          metadata: {
            evidence: {
              authority: 'user_asserted',
              sources: [{ kind: 'session', sessionId: 's', seqFrom: 2, seqTo: 1 }],
            },
          },
        },
        {
          content: 'Second note\nBody.',
          parentId: sectionId,
          tags: ['#second', '#note'],
        },
      ],
    });
    expect(res.result?.isError).toBe(true);

    const stillThere = await client.callTool('tim_read', { id: markerId });
    expect(stillThere.result?.isError).toBeFalsy();
    const search = await client.callTool('tim_search', { query: 'Good note', project: 'P3500', topK: 5 });
    const hits = JSON.parse(search.result!.content![0].text);
    expect(hits.results ?? hits).toEqual([]);
  });

  it('batch summary records agent_derived session sequence evidence', async () => {
    const sessionId = `evidence-session-${Date.now()}`;
    await client.callTool('tim_session_start', {
      sessionId,
      projectId: 'P3500',
      cwd,
    });
    await client.callTool('tim_session_log', {
      sessionId,
      entries: [
        { role: 'user', content: 'First question' },
        { role: 'agent', content: 'First answer' },
        { role: 'user', content: 'Second question' },
        { role: 'agent', content: 'Second answer' },
      ],
    });

    const summary = await client.callTool('tim_write_batch_summary', {
      sessionId,
      batchIndex: 1,
      summary: 'Batch summary body',
      seqFrom: 1,
      seqTo: 2,
    });
    expect(summary.result?.isError).toBeFalsy();
    const summaryId = JSON.parse(summary.result!.content![0].text).id;

    const read = await client.callTool('tim_read', { id: summaryId });
    const body = JSON.parse(read.result!.content![0].text);
    expect(body.entry.evidence.authority).toBe('agent_derived');
    expect(body.entry.evidence.sources[0].kind).toBe('session');
    expect(body.entry.evidence.sources[0].status).toBe('available');
    expect(body.entry.evidence.sources[0].seqFrom).toBe(1);
    expect(body.entry.evidence.sources[0].seqTo).toBe(2);
    expect(body.entry.evidence.sources[0].sessionId).toBeTruthy();
  });

  it('imported entries expose imported authority on read', async () => {
    const hmemPath = path.join(dir, 'import.hmem');
    const db = createV2HmemDatabase(hmemPath);
    const rootUid = '01ROOT00000000000000000002';
    db.prepare(`
      INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
        access_count, obsolete, favorite, irrelevant, pinned, tags)
      VALUES (?, 'L3501', 'L', 1, 'Imported memory', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
        0, 0, 0, 0, 0, '["#imported"]')
    `).run(rootUid);
    db.close();

    const store = new TimStore(path.join(dir, 'import.db'));
    const report = tim_import(store, hmemPath);
    expect(report.entriesImported).toBe(1);
    const imported = await store.read('L3501');
    store.close();
    expect(imported?.metadata.evidence).toEqual({ authority: 'imported', sources: [] });
  });

  it('unavailable entry sources are reported without fabricating availability', async () => {
    const written = await client.callTool('tim_write', {
      content: 'Ghost claim\nMissing source.',
      parentId: sectionId,
      tags: ['#ghost', '#note'],
      metadata: {
        evidence: {
          authority: 'agent_derived',
          sources: [{ kind: 'entry', entryId: '01MISSING00000000000000001' }],
        },
      },
    });
    expect(written.result?.isError).toBeFalsy();
    const id = JSON.parse(written.result!.content![0].text).id;
    const read = await client.callTool('tim_read', { id });
    const body = JSON.parse(read.result!.content![0].text);
    expect(body.entry.evidence.sources[0].status).toBe('unavailable');
  });
});
