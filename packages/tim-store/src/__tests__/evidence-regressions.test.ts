import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEvidenceMetadata } from 'tim-core';
import { TimStore } from '../store.js';
import { SessionManager } from '../session.js';
import { resolveSessionSourceStatus } from '../evidence-resolve.js';
import { applyRemoteEntry } from '../sync-methods.js';

describe('evidence integration review regressions', () => {
  let store: TimStore;
  beforeEach(() => { store = new TimStore(':memory:'); });
  afterEach(() => { store.close(); });

  it('resolves checkpoint evidence from flat unbound session exchanges', async () => {
    const sessions = new SessionManager(store);
    await sessions.sessionStart({ sessionId: 'flat-evidence', agentName: 'test' });
    await sessions.sessionLog('flat-evidence', [
      { role: 'user', content: 'First question' },
      { role: 'agent', content: 'First answer' },
      { role: 'user', content: 'Second question' },
      { role: 'agent', content: 'Second answer' },
    ]);
    const checkpoint = await sessions.checkpoint('flat-evidence', {
      summarize: async () => 'Checkpoint summary', runDecay: false,
    });
    const evidence = parseEvidenceMetadata(checkpoint.metadata.evidence);
    const source = evidence?.sources[0];
    expect(source?.kind).toBe('session');
    if (source?.kind !== 'session') throw new Error('Missing checkpoint session evidence');
    expect(await resolveSessionSourceStatus(store, source.sessionId, source.seqFrom, source.seqTo))
      .toBe('available');
  });

  it('allows unrelated updates to peer-written legacy evidence while rejecting new invalid evidence', async () => {
    const entry = await store.write('Legacy evidence\nA note.');
    applyRemoteEntry(store.getDb(), JSON.stringify({
      id: entry.id, title: entry.title, content: entry.content, content_type: 'text',
      depth: entry.depth, confidence: 1, created_at: entry.createdAt,
      accessed_at: entry.accessedAt, decay_rate: 0, visibility: 1, tags: '[]',
      irrelevant: 0, tombstoned_at: null, metadata: { evidence: 'see old commit', topic: 'legacy' },
    }), Date.now() + 1000, 'peer', false);
    await store.update(entry.id, { metadata: { status: 'done' } });
    store.updateSync(entry.id, { metadata: { favorite: true } });
    const updated = await store.read(entry.id);
    expect(updated?.metadata).toMatchObject({ evidence: 'see old commit', status: 'done', favorite: true });
    await expect(store.update(entry.id, { metadata: { evidence: 'new invalid evidence' } }))
      .rejects.toThrow(/Invalid metadata.evidence/);
    expect((await store.read(entry.id))?.metadata.evidence).toBe('see old commit');
  });
});
