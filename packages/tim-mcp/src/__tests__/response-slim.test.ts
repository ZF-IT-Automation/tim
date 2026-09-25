import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, TimStore } from 'tim-store';
import { EVIDENCE_DISCLAIMER } from '../evidence-presentation.js';
import { presentHealthReport } from '../health-presentation.js';
import { presentReadEntry, TOOL_DEFS } from '../server.js';
import { executeTimSearch } from '../tim-search-tool.js';

describe('slim default MCP payloads', () => {
  let dir: string;
  let store: TimStore;

  afterEach(() => {
    store?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('omits default evidence, temporal metadata, and health ranges past 5', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-mcp-slim-'));
    store = new TimStore(path.join(dir, 'test.db'));

    const readTool = TOOL_DEFS.find(def => def.name === 'tim_read');
    const searchTool = TOOL_DEFS.find(def => def.name === 'tim_search');
    expect(readTool?.description).toContain(EVIDENCE_DISCLAIMER);
    expect(searchTool?.description).toContain(EVIDENCE_DISCLAIMER);
    expect(TOOL_DEFS.find(def => def.name === 'tim_health')?.schema.shape.verbose).toBeDefined();

    const project = await store.createProject('P9100', { content: 'Slim project', memoryOnly: true });
    const section = await store.write('Notes', {
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const parent = await store.write('Typical note\nA short body about deploy windows.', {
      parentId: section.id,
      tags: ['#note', '#deploy'],
    });
    await store.write('Child note\nNested body.', {
      parentId: parent.id,
      tags: ['#note', '#child'],
    });
    const tree = await store.read(parent.id, { includeChildren: true, depth: 2 });
    const presented = await presentReadEntry(store, tree!, false, dir) as {
      evidence?: unknown;
      temporal?: unknown;
      children?: Array<{ evidence?: unknown; temporal?: unknown }>;
    };
    expect(presented.evidence).toBeUndefined();
    expect(presented.temporal).toBeUndefined();
    expect(presented.children?.[0].evidence).toBeUndefined();
    expect(presented.children?.[0].temporal).toBeUndefined();

    const source = await store.write('Source note\nOrigin.', {
      parentId: section.id,
      tags: ['#source'],
    });
    const claim = await store.write('Claim note\nDerived.', {
      parentId: section.id,
      tags: ['#claim'],
      metadata: {
        evidence: {
          authority: 'agent_derived',
          sources: [{ kind: 'entry', entryId: source.id }],
        },
      },
    });
    const claimRead = await presentReadEntry(store, (await store.read(claim.id))!, false, dir) as {
      evidence: { authority: string; disclaimer: string; sources: unknown[] };
      temporal?: unknown;
    };
    expect(claimRead.evidence.authority).toBe('agent_derived');
    expect(claimRead.evidence.sources).toEqual([
      { kind: 'entry', status: 'available', entryId: source.id },
    ]);
    expect(claimRead.evidence.disclaimer).toContain('not authentication');
    expect(claimRead.temporal).toBeUndefined();

    const oldPolicy = await store.write('Old policy\nUse HTTP/1.1 only.', {
      parentId: section.id,
      tags: ['#decision'],
    });
    const newPolicy = await store.write('New policy\nUse HTTP/2.', {
      parentId: section.id,
      tags: ['#decision'],
    });
    await store.link(newPolicy.id, oldPolicy.id, 'supersedes', 1, {
      effectiveAt: '2026-03-15T12:00:00Z',
    });
    const superseded = await presentReadEntry(store, (await store.read(oldPolicy.id))!, false, dir) as {
      temporal: { state: string; supersedes: unknown[]; contradictions: unknown[] };
    };
    expect(superseded.temporal.state).toBe('superseded');
    const successor = await presentReadEntry(store, (await store.read(newPolicy.id))!, false, dir) as {
      temporal: { state: string; supersedes: Array<{ entryId: string }> };
    };
    expect(successor.temporal.state).toBe('current');
    expect(successor.temporal.supersedes.map(ref => ref.entryId)).toEqual([oldPolicy.id]);

    for (let i = 0; i < 10; i++) {
      await store.write(`SlimNeedle hit ${i}\nBody ${i} for the search payload.`, {
        parentId: section.id,
        tags: ['#note', '#search'],
      });
    }
    const fts = await executeTimSearch(store, {
      query: 'SlimNeedle',
      searchType: 'fts',
      topK: 10,
      root: 'P9100',
    });
    expect(fts.results).toHaveLength(10);
    expect(fts.response.semantic).toBeUndefined();

    const sessions = new SessionManager(store);
    for (let i = 0; i < 8; i++) {
      const sessionId = `slim-${i}`;
      await sessions.startProjectSession({
        sessionId,
        projectId: 'P9100',
        agentName: 'a',
        cwd: dir,
        harness: 't',
        batchSize: 5,
      });
      await sessions.logExchange(sessionId, [
        { role: 'user', content: `Q1 ${i}` },
        { role: 'agent', content: `A1 ${i}` },
        { role: 'user', content: `Q2 ${i}` },
        { role: 'agent', content: `A2 ${i}` },
      ]);
      await sessions.writeBatchSummary(sessionId, 1, `covered ${i}`, { seqFrom: 1, seqTo: 1 });
    }

    const raw = await store.health();
    const coverage = raw.memory!.summaryCoverage;
    expect(coverage.pendingRanges).toHaveLength(8);
    expect(coverage.coveredRanges).toHaveLength(8);
    expect('more' in coverage).toBe(false);

    const preview = presentHealthReport(raw, false);
    const previewCoverage = preview.memory!.summaryCoverage;
    expect(previewCoverage.pendingRanges).toHaveLength(5);
    expect(previewCoverage.coveredRanges).toHaveLength(5);
    expect(previewCoverage.pendingRangeCount).toBe(8);
    expect(previewCoverage.coveredRangeCount).toBe(8);
    expect(previewCoverage.more).toEqual({ pendingRanges: 3, coveredRanges: 3 });
    expect(previewCoverage.pendingRangesTruncated).toBe(true);
    expect(previewCoverage.pendingRanges.map(range => range.sessionId)).toEqual(
      coverage.pendingRanges.slice(0, 5).map(range => range.sessionId),
    );

    const verbose = presentHealthReport(raw, true);
    expect(verbose.memory!.summaryCoverage.pendingRanges).toHaveLength(8);
    expect(verbose.memory!.summaryCoverage.coveredRanges).toHaveLength(8);
    expect(verbose.memory!.summaryCoverage.more).toEqual({ pendingRanges: 0, coveredRanges: 0 });
  });
});
