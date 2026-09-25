import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { EmbeddingProvider } from 'tim-store';
import { runBenchmark } from '../runner.js';
import { loadDataset } from '../dataset.js';
import { REPORT_VERSION, DATASET_VERSION } from '../types.js';
import {
  applyContextByteBudget,
  computeEvidenceOutcome,
  computeRetrievalMetrics,
  extractGoldFromContextInOrder,
  mapEntriesToOrderedEvidence,
  NON_GOLD_MARKER_PREFIX,
} from '../metrics.js';

const CLI_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'dist',
  'cli.js',
);

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe('memory quality benchmark (#38)', () => {
  const outputs: string[] = [];
  const envSnapshots: Array<{ key: string; prev: string | undefined }> = [];

  afterEach(() => {
    for (const file of outputs) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    outputs.length = 0;
    for (const { key, prev } of envSnapshots) {
      restoreEnv(key, prev);
    }
    envSnapshots.length = 0;
  });

  function snapshotEnv(key: string): void {
    envSnapshots.push({ key, prev: process.env[key] });
  }

  it('loads versioned dataset with bilingual questions and agent-authored provenance', () => {
    const dataset = loadDataset();
    expect(dataset.schemaVersion).toBe(DATASET_VERSION);
    expect(dataset.provenance).toMatch(/agent-authored/i);
    expect(dataset.questions.some(q => q.lang === 'de')).toBe(true);
    expect(dataset.questions.some(q => q.lang === 'en')).toBe(true);
    expect(dataset.fixedHandoff.text.length).toBeGreaterThan(50);
    expect(dataset.entries.some(e => e.vectorHint === 'motor')).toBe(true);
    expect(dataset.entries.some(e => e.supersedesGold)).toBe(true);
    expect(dataset.entries.some(e => e.section === 'Sessions')).toBe(false);
  });

  it('runs synthetic benchmark across all modes with schema fields', async () => {
    // Hybrid re-rank ignores vectors while the suite opt-out is set, which
    // drops no-overlap synonym recall. This run uses the synthetic provider.
    snapshotEnv('TIM_EMBEDDING_DISABLED');
    delete process.env.TIM_EMBEDDING_DISABLED;
    const report = await runBenchmark({ providerMode: 'synthetic' });
    expect(report.reportVersion).toBe(REPORT_VERSION);
    expect(report.datasetVersion).toBe(DATASET_VERSION);
    expect(report.modeSummaries.map(m => m.mode)).toEqual([
      'no-memory',
      'fixed-handoff',
      'tim',
    ]);
    expect(report.notMeasured).toContain('agent_task_success');
    expect(report.memoryHealth).toBeDefined();
    expect(report.memoryHealth).toMatchObject({
      summaryCoverage: { observedExchangeCount: 3, coveredExchangeCount: 2, pendingExchangeCount: 1 },
      sync: { telemetryState: 'not_configured' },
    });
    expect(report.baselineObservations.length).toBeGreaterThan(0);

    for (const q of report.questions) {
      for (const mode of ['no-memory', 'fixed-handoff', 'tim'] as const) {
        const r = q.results[mode];
        expect(r.evidence).toHaveProperty('expected');
        expect(r.evidence).toHaveProperty('found');
        expect(r.evidence).toHaveProperty('missing');
        expect(r.evidence).toHaveProperty('irrelevant');
        expect(r.metrics).toHaveProperty('precision');
        expect(r.metrics).toHaveProperty('recall');
        expect(r.provider.mode).toBe('synthetic');
        expect(r.contextBytes).toBeLessThanOrEqual(report.contextBudget);
      }
      expect(q.results['fixed-handoff'].evidence.expected).toEqual(
        q.results.tim.evidence.expected,
      );
    }

    const synonym = report.questions.find(q => q.id === 'q-en-synonym')!;
    expect(synonym.results.tim.evidence.found).toContain('gold:motor-transport');
    expect(synonym.results['no-memory'].evidence.missing).toContain('gold:motor-transport');

    const deSynonym = report.questions.find(q => q.id === 'q-de-synonym')!;
    expect(deSynonym.results.tim.evidence.found).toContain('gold:motor-transport');

    const temporalBefore = report.questions.find(q => q.id === 'q-en-decision-before')!;
    expect(temporalBefore.results.tim.evidence.found).toContain('gold:decision-v1');
    expect(temporalBefore.results['fixed-handoff'].metrics.recall).toBe(0);
    expect(temporalBefore.results['fixed-handoff'].evidence.missing).toContain('gold:decision-v1');

    const temporalCurrent = report.questions.find(q => q.id === 'q-en-decision-current')!;
    expect(temporalCurrent.results.tim.evidence.found).toContain('gold:decision-current');

    const adversarial = report.questions.find(q => q.id === 'q-en-adversarial-scope')!;
    expect(adversarial.results.tim.evidence.irrelevant).not.toContain('gold:adversarial-b-noise');

    const briefing = report.questions.find(q => q.id === 'q-en-briefing-rules')!;
    expect(briefing.results.tim.evidence.found).toEqual(
      expect.arrayContaining(['gold:rule-tests', 'gold:task-auth']),
    );
    expect(briefing.results.tim.evidence.irrelevant.some(label => label.startsWith('retrieved:log-'))).toBe(true);
    expect(briefing.results.tim.evidence.irrelevant).toContain('gold:motor-transport');
    expect(briefing.results.tim.provider).toMatchObject({ modelId: null, state: 'not_used', searchType: 'fts' });
    for (const question of report.questions) {
      for (const mode of ['no-memory', 'fixed-handoff'] as const) {
        expect(question.results[mode].provider).toEqual({ mode: 'synthetic', modelId: null, state: 'not_used' });
      }
    }
    const partial = report.questions.find(q => q.id === 'q-de-briefing-session')!;
    expect(partial.results.tim.evidence.found).toContain('gold:session-partial');
    expect(partial.results.tim.evidence.irrelevant).not.toContain('gold:session-partial');
  });

  it('loses expected recall for an unrelated query against a larger indexed distractor pool', async () => {
    const dataset = loadDataset();
    const question = dataset.questions.find(q => q.id === 'q-en-synonym')!;
    const positive = await runBenchmark({ datasetOverride: { ...dataset, questions: [question] } });
    const negative = await runBenchmark({ datasetOverride: {
      ...dataset,
      questions: [{ ...question, text: 'zzzz quantum basketweaving flibbertigibbet' }],
    } });
    expect(positive.questions[0].results.tim.metrics.recall).toBe(1);
    expect(negative.questions[0].results.tim.metrics.recall).toBe(0);
    expect(negative.questions[0].results.tim.evidence.missing).toContain('gold:motor-transport');
  });

  it('reports explicit skip when real provider requested but unavailable (no synthetic run)', async () => {
    snapshotEnv('TIM_EMBEDDING_REAL_MODEL');
    snapshotEnv('TIM_EMBEDDING_DISABLED');
    snapshotEnv('TIM_EMBEDDING_MODEL');
    process.env.TIM_EMBEDDING_REAL_MODEL = '1';
    process.env.TIM_EMBEDDING_MODEL = 'test-unknown-enum';
    delete process.env.TIM_EMBEDDING_DISABLED;
    const report = await runBenchmark({ providerMode: 'real' });
    expect(report.provider.mode).toBe('real');
    expect(report.provider.skipped).toBeDefined();
    expect(report.provider.skipped!.reason).toMatch(/unavailable/i);
    expect(report.questions).toHaveLength(0);
  });

  it('honors TIM_EMBEDDING_DISABLED without deleting the opt-out', async () => {
    snapshotEnv('TIM_EMBEDDING_REAL_MODEL');
    snapshotEnv('TIM_EMBEDDING_DISABLED');
    process.env.TIM_EMBEDDING_REAL_MODEL = '1';
    process.env.TIM_EMBEDDING_DISABLED = '1';
    const report = await runBenchmark({ providerMode: 'real' });
    expect(report.provider.skipped?.reason).toMatch(/TIM_EMBEDDING_DISABLED/);
    expect(process.env.TIM_EMBEDDING_DISABLED).toBe('1');
    expect(report.questions).toHaveLength(0);
  });

  it('uses injectable provider factory for real branch without synthetic vectors', async () => {
    snapshotEnv('TIM_EMBEDDING_REAL_MODEL');
    snapshotEnv('TIM_EMBEDDING_DISABLED');
    process.env.TIM_EMBEDDING_REAL_MODEL = '1';
    delete process.env.TIM_EMBEDDING_DISABLED;

    const embeddedTexts: string[] = [];
    const factory = async (): Promise<EmbeddingProvider> => ({
      modelId: 'test-real-v1',
      dimension: 3,
      state: 'enabled',
      embed: async (texts: string[]) => {
        embeddedTexts.push(...texts);
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
      },
    });

    const report = await runBenchmark({ providerMode: 'real', providerFactory: factory });
    expect(report.provider.skipped).toBeUndefined();
    expect(report.provider.modelId).toBe('test-real-v1');
    expect(report.questions.length).toBeGreaterThan(0);
    expect(embeddedTexts.length).toBeGreaterThan(0);
    expect(embeddedTexts.some(t => t.includes('Kraftfahrzeug'))).toBe(true);
    expect(embeddedTexts.some(t => t.includes('vectorHint'))).toBe(false);
  });

  it('changes fixed-handoff metrics when handoff text is altered', async () => {
    const dataset = loadDataset();
    const baseline = await runBenchmark({ providerMode: 'synthetic' });
    const handoffQ = baseline.questions.find(q => q.id === 'q-en-decision-current')!;
    const baselineRecall = handoffQ.results['fixed-handoff'].metrics.recall;

    const altered = {
      ...dataset,
      fixedHandoff: {
        ...dataset.fixedHandoff,
        text: dataset.fixedHandoff.text.replace('gold:decision-current', 'gold:removed-marker'),
      },
    };
    const changed = await runBenchmark({
      providerMode: 'synthetic',
      datasetOverride: altered,
    });
    const changedQ = changed.questions.find(q => q.id === 'q-en-decision-current')!;
    expect(changedQ.results['fixed-handoff'].metrics.recall).not.toBe(baselineRecall);
    expect(changedQ.results['fixed-handoff'].metrics.recall).toBe(0);
  });

  it('validates zero-denominator metrics and prefix-safe marker matching', () => {
    const empty = computeRetrievalMetrics([], []);
    expect(empty.precision).toBeNull();
    expect(empty.recall).toBeNull();

    const evidence = computeEvidenceOutcome([], [], ['gold:noise']);
    expect(evidence.missing).toEqual([]);
    expect(evidence.found).toEqual([]);

    const context = 'prefix gold:decision-current suffix';
    const ordered = extractGoldFromContextInOrder(
      context,
      ['gold:decision', 'gold:decision-current', 'gold:decision-v1'],
    );
    expect(ordered).toEqual(['gold:decision-current']);
    expect(ordered).not.toContain('gold:decision');
    expect(ordered).not.toContain('gold:decision-v1');
  });

  it('counts retained non-gold search hits in precision denominator', () => {
    const ordered = mapEntriesToOrderedEvidence(
      ['entry-a', 'entry-b'],
      new Map([['entry-a', 'gold:motor-transport']]),
    );
    expect(ordered[0]).toBe('gold:motor-transport');
    expect(ordered[1]).toBe(`${NON_GOLD_MARKER_PREFIX}entry-b`);
    const metrics = computeRetrievalMetrics(['gold:motor-transport'], ordered);
    expect(metrics.precision).toBe(0.5);
    const outcome = computeEvidenceOutcome(['gold:motor-transport'], ordered);
    expect(outcome.irrelevant).toContain(`${NON_GOLD_MARKER_PREFIX}entry-b`);
  });

  it('retains unknown and non-gold briefing markers in observed order', () => {
    const found = extractGoldFromContextInOrder(
      '[retrieved:log-1] [gold:session-partial] [gold:task-auth]',
      ['gold:task-auth'],
    );
    expect(found).toEqual(['retrieved:log-1', 'gold:session-partial', 'gold:task-auth']);
    expect(computeRetrievalMetrics(['gold:task-auth'], found).precision).toBe(1 / 3);
  });

  it('drops gold evidence truncated by context budget', () => {
    const longPrefix = 'x'.repeat(4080);
    const context = `${longPrefix}\n[gold:motor-transport]`;
    const bounded = applyContextByteBudget(context, 4096);
    const found = extractGoldFromContextInOrder(bounded, ['gold:motor-transport']);
    expect(found).toEqual([]);
    const metrics = computeRetrievalMetrics(['gold:motor-transport'], found);
    expect(metrics.recall).toBe(0);
  });

  it('fails adversarial end-to-end when gold expectations are wrong', async () => {
    const dataset = loadDataset();
    const wrong = {
      ...dataset,
      questions: dataset.questions.map(q =>
        q.id === 'q-en-adversarial-scope'
          ? { ...q, expectedGold: ['gold:adversarial-b-noise'] }
          : q,
      ),
    };
    const report = await runBenchmark({ providerMode: 'synthetic', datasetOverride: wrong });
    const q = report.questions.find(x => x.id === 'q-en-adversarial-scope')!;
    expect(q.results.tim.evidence.missing).toContain('gold:adversarial-b-noise');
    expect(q.results.tim.metrics.recall).toBe(0);
  });

  it('executes standalone CLI from built output without source dataset dependency', () => {
    const distDataset = path.resolve(
      path.dirname(CLI_PATH),
      'dataset',
      `${DATASET_VERSION}.json`,
    );
    expect(fs.existsSync(distDataset)).toBe(true);
    const srcDataset = path.resolve(
      path.dirname(CLI_PATH),
      '..',
      'src',
      'dataset',
      `${DATASET_VERSION}.json`,
    );
    const srcBackup = `${srcDataset}.bak`;
    let moved = false;
    if (fs.existsSync(srcDataset)) {
      fs.renameSync(srcDataset, srcBackup);
      moved = true;
    }

    const out = path.join(os.tmpdir(), `tim-quality-report-${Date.now()}.json`);
    outputs.push(out);
    snapshotEnv('TIM_EMBEDDING_DISABLED');
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(process.execPath, [CLI_PATH, '--output', out], {
        encoding: 'utf8',
        env: { ...process.env, TIM_EMBEDDING_DISABLED: '1' },
      });
    } finally {
      if (moved) fs.renameSync(srcBackup, srcDataset);
    }

    expect(result.status).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(parsed.reportVersion).toBe(REPORT_VERSION);
    expect(parsed.questions.length).toBeGreaterThan(0);
  });

  it('CLI real opt-in reports honest no-network unavailable skip', () => {
    const out = path.join(os.tmpdir(), `tim-quality-real-skip-${Date.now()}.json`);
    outputs.push(out);
    const env = {
      ...process.env,
      TIM_EMBEDDING_REAL_MODEL: '1',
      TIM_EMBEDDING_MODEL: 'test-unknown-enum',
    };
    // Unknown model id is rejected before fastembed init. Drop the suite
    // opt-out so this still asserts that path, not the disabled skip.
    delete env.TIM_EMBEDDING_DISABLED;
    const result = spawnSync(process.execPath, [CLI_PATH, '--real-provider', '--output', out], {
      encoding: 'utf8',
      env,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(parsed.provider.mode).toBe('real');
    expect(parsed.provider.skipped).toBeDefined();
    expect(parsed.questions).toHaveLength(0);
  });
});
