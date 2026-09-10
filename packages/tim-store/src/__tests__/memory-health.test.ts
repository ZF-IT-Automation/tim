import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TimStore,
  SessionManager,
  computeMemoryHealth,
  resetDefaultEmbeddingProviderCache,
  createUnavailableEmbeddingProvider,
  type EmbeddingProvider,
} from '../index.js';
import { isDefaultEmbeddingProviderResolved } from '../embedding-provider.js';

const CUSTOM_MODEL = 'all-MiniLM-L6-v2';

function unitVector(dim = 384, bias = 0.1): Float32Array {
  const v = new Float32Array(dim);
  v[0] = bias;
  v[1] = 1 - bias;
  return v;
}

describe('computeMemoryHealth', () => {
  let store: TimStore;
  let sessions: SessionManager;
  let home: string;
  let origHome: string | undefined;
  let origDisabled: string | undefined;

  beforeEach(async () => {
    resetDefaultEmbeddingProviderCache();
    origHome = process.env.HOME;
    origDisabled = process.env.TIM_EMBEDDING_DISABLED;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-mem-health-'));
    process.env.HOME = home;
    delete process.env.TIM_EMBEDDING_DISABLED;
    delete process.env.TIM_EMBEDDING_MODEL;

    const provider: EmbeddingProvider = {
      modelId: CUSTOM_MODEL,
      dimension: 384,
      state: 'enabled',
      embed: async texts => texts.map(() => unitVector()),
    };
    store = new TimStore(':memory:', { embeddingProvider: provider });
    sessions = new SessionManager(store);
    await store.createProject('P3700');
  });

  afterEach(() => {
    store.close();
    process.env.HOME = origHome;
    if (origDisabled === undefined) delete process.env.TIM_EMBEDDING_DISABLED;
    else process.env.TIM_EMBEDDING_DISABLED = origDisabled;
    fs.rmSync(home, { recursive: true, force: true });
    resetDefaultEmbeddingProviderCache();
  });

  it('reports idle state on empty store', async () => {
    const memory = await computeMemoryHealth(store);
    expect(memory.summaryCoverage.workState).toBe('no_sessions');
    expect(memory.summaryCoverage.observedExchangeCount).toBe(0);
    expect(memory.sync.telemetryState).toBe('not_configured');
    expect(memory.semanticIndex.providerState).toBe('enabled');
  });

  it('reports pending after partial summary then appended exchanges', async () => {
    await sessions.startProjectSession({
      sessionId: 'partial',
      projectId: 'P3700',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('partial', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'agent', content: 'A2' },
    ]);
    await sessions.writeBatchSummary('partial', 1, 'partial draft', { seqFrom: 1, seqTo: 2 });
    await sessions.logExchange('partial', [
      { role: 'user', content: 'Q3' },
      { role: 'agent', content: 'A3' },
    ]);

    const memory = await computeMemoryHealth(store);
    expect(memory.summaryCoverage.workState).toBe('pending');
    expect(memory.summaryCoverage.pendingExchangeCount).toBe(1);
    expect(memory.summaryCoverage.pendingRanges).toEqual([
      expect.objectContaining({ sessionId: 'partial', seqFrom: 3, seqTo: 3 }),
    ]);
    expect(memory.summaryCoverage.latestBatchSummary?.rangeKnown).toBe(true);
  });

  it('does not claim coverage for malformed legacy range', async () => {
    await sessions.startProjectSession({
      sessionId: 'bad-range',
      projectId: 'P3700',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('bad-range', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
    ]);
    await sessions.writeBatchSummary('bad-range', 1, 'bad', { seqFrom: 5, seqTo: 2 });

    const memory = await computeMemoryHealth(store);
    expect(memory.summaryCoverage.pendingExchangeCount).toBe(1);
    expect(memory.summaryCoverage.latestBatchSummary?.rangeKnown).toBe(false);
    expect(memory.guidance.some(g => g.includes('invalid or missing seq range'))).toBe(true);
  });

  it('reports embedding backlog after indexed entry edit', async () => {
    const entry = await store.write('Indexed\nBody.', { tags: ['#note'] });
    store.setVectors(entry.id, unitVector(384, 0.85), CUSTOM_MODEL, 384);
    await store.update(entry.id, { content: 'Edited\nBody.' });

    const memory = await computeMemoryHealth(store);
    expect(memory.semanticIndex.unembeddedCount).toBeGreaterThanOrEqual(1);
    expect(memory.guidance.some(g => g.includes('need (re)indexing'))).toBe(true);
  });

  it('reports disabled embeddings without claiming vector success', async () => {
    store.close();
    process.env.TIM_EMBEDDING_DISABLED = '1';
    const disabledStore = new TimStore(':memory:');
    await disabledStore.write('No vectors\nBody.', { tags: ['#note'] });

    const memory = await computeMemoryHealth(disabledStore);
    expect(memory.semanticIndex.providerState).toBe('disabled');
    expect(memory.semanticIndex.vectorCount).toBe(0);
    expect(memory.guidance.some(g => g.includes('disabled'))).toBe(true);
    disabledStore.close();
  });

  it('reports unavailable provider for unsupported model', async () => {
    store.close();
    const unavailable: EmbeddingProvider = createUnavailableEmbeddingProvider('unknown-model-x');
    const badStore = new TimStore(':memory:', { embeddingProvider: unavailable });

    const memory = await computeMemoryHealth(badStore);
    expect(memory.semanticIndex.providerState).toBe('unavailable');
    expect(memory.guidance.some(g => g.includes('unsupported'))).toBe(true);
    badStore.close();
  });

  it('reads sync telemetry states from local files without network', async () => {
    const timDir = path.join(home, '.tim');
    fs.mkdirSync(timDir, { recursive: true });
    fs.writeFileSync(path.join(timDir, 'sync.json'), JSON.stringify({ serverUrl: 'http://localhost' }));
    let memory = await computeMemoryHealth(store);
    expect(memory.sync.telemetryState).toBe('configured_no_state');

    fs.writeFileSync(
      path.join(timDir, 'sync-state.json'),
      JSON.stringify({ lastPush: '2026-01-01T00:00:00.000Z', lastPull: null }),
    );
    memory = await computeMemoryHealth(store);
    expect(memory.sync.telemetryState).toBe('available');
    expect(memory.sync.lastPush).toBe('2026-01-01T00:00:00.000Z');
  });

  it('health() includes memory and does not initialize default embedding provider', async () => {
    store.close();
    resetDefaultEmbeddingProviderCache();
    const bare = new TimStore(':memory:');

    const before = (bare.getDb().prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c;
    const report = await bare.health();
    const after = (bare.getDb().prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c;

    expect(report.memory).toBeDefined();
    expect(report.memory!.semanticIndex.providerState).toBe('unknown');
    expect(isDefaultEmbeddingProviderResolved()).toBe(false);
    expect(before).toBe(after);
    bare.close();
  });

  it('store.health adds warnings for pending summarization', async () => {
    await sessions.startProjectSession({
      sessionId: 'warn',
      projectId: 'P3700',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('warn', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
    ]);

    const report = await store.health();
    expect(report.status).toBe('WARN');
    expect(report.warnings.some(w => w.includes('pending summarization'))).toBe(true);
    expect(report.memory?.summaryCoverage.workState).toBe('pending');
  });
});
