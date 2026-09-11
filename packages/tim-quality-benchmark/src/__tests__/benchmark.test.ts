import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBenchmark } from '../runner.js';
import { loadDataset } from '../dataset.js';
import { REPORT_VERSION, DATASET_VERSION } from '../types.js';
import {
  computeEvidenceOutcome,
  computeRetrievalMetrics,
} from '../metrics.js';

const CLI_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'dist',
  'cli.js',
);

describe('memory quality benchmark (#38)', () => {
  const outputs: string[] = [];

  afterEach(() => {
    for (const file of outputs) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    outputs.length = 0;
  });

  it('loads versioned dataset with bilingual questions and fixture provenance', () => {
    const dataset = loadDataset();
    expect(dataset.schemaVersion).toBe(DATASET_VERSION);
    expect(dataset.provenance).toMatch(/synthetic/i);
    expect(dataset.questions.some(q => q.lang === 'de')).toBe(true);
    expect(dataset.questions.some(q => q.lang === 'en')).toBe(true);
    expect(dataset.fixedHandoff.text.length).toBeGreaterThan(50);
    expect(dataset.entries.some(e => e.vectorHint === 'motor')).toBe(true);
    expect(dataset.entries.some(e => e.supersedesGold)).toBe(true);
  });

  it('runs synthetic benchmark across all modes with schema fields', async () => {
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
      }
    }

    const synonym = report.questions.find(q => q.id === 'q-en-synonym')!;
    expect(synonym.results.tim.evidence.found).toContain('gold:motor-transport');
    expect(synonym.results['no-memory'].evidence.missing).toContain('gold:motor-transport');

    const temporalBefore = report.questions.find(q => q.id === 'q-en-decision-before')!;
    expect(temporalBefore.results.tim.evidence.found).toContain('gold:decision-v1');

    const adversarial = report.questions.find(q => q.id === 'q-en-adversarial-scope')!;
    expect(adversarial.results.tim.evidence.irrelevant).not.toContain('gold:adversarial-b-noise');
  });

  it('reports explicit skip when real provider requested but unavailable', async () => {
    const prev = process.env.TIM_EMBEDDING_REAL_MODEL;
    process.env.TIM_EMBEDDING_REAL_MODEL = '1';
    const report = await runBenchmark({ providerMode: 'real' });
    expect(report.provider.mode).toBe('real');
    expect(report.provider.skipped).toBeDefined();
    expect(report.provider.skipped!.reason).toMatch(/unavailable|not set/i);
    if (prev === undefined) delete process.env.TIM_EMBEDDING_REAL_MODEL;
    else process.env.TIM_EMBEDDING_REAL_MODEL = prev;
  });

  it('validates zero-denominator metrics honestly', () => {
    const empty = computeRetrievalMetrics([], []);
    expect(empty.precision).toBeNull();
    expect(empty.recall).toBeNull();

    const evidence = computeEvidenceOutcome([], [], ['gold:noise']);
    expect(evidence.missing).toEqual([]);
    expect(evidence.found).toEqual([]);
  });

  it('fails adversarial assertion when gold expectations are wrong', () => {
    const wrongExpected = ['gold:adversarial-b-noise'];
    const actualFound = ['gold:motor-transport'];
    const outcome = computeEvidenceOutcome(wrongExpected, actualFound);
    expect(outcome.missing).toContain('gold:adversarial-b-noise');
    expect(outcome.found).not.toContain('gold:adversarial-b-noise');
    const metrics = computeRetrievalMetrics(wrongExpected, actualFound);
    expect(metrics.recall).toBe(0);
  });

  it('executes standalone CLI and writes JSON report', () => {
    const out = path.join(os.tmpdir(), `tim-quality-report-${Date.now()}.json`);
    outputs.push(out);
    const result = spawnSync('node', [CLI_PATH, '--output', out], {
      encoding: 'utf8',
      env: { ...process.env, TIM_EMBEDDING_DISABLED: '1' },
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(parsed.reportVersion).toBe(REPORT_VERSION);
    expect(parsed.questions.length).toBeGreaterThan(0);
  });
});
