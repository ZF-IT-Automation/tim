import { performance } from 'node:perf_hooks';
import {
  computeMemoryHealth,
  type TimStore,
} from 'tim-store';
import { estimateTextTokens } from 'tim-mcp';
import { loadDataset } from './dataset.js';
import {
  buildFixtureStore,
  closeFixtureStore,
  type FixtureStore,
} from './fixture-store.js';
import { renderTimBriefing } from './briefing.js';
import {
  applyContextByteBudget,
  assembleBoundedContext,
  computeBaselineObservations,
  computeEvidenceOutcome,
  computeRetrievalMetrics,
  extractGoldFromContextInOrder,
  macroAverage,
  mapEntriesToOrderedEvidence,
} from './metrics.js';
import type {
  BenchmarkMode,
  BenchmarkReport,
  DatasetFixture,
  DatasetQuestion,
  ModeSummary,
  QuestionModeResult,
} from './types.js';
import { DATASET_VERSION, REPORT_VERSION } from './types.js';

export interface RunOptions {
  outputPath?: string;
  /** Override dataset fixture (altered-fixture negative controls). */
  datasetOverride?: DatasetFixture;
}

function recallFromMetrics(metrics: { recall: number | null }, expectedCount: number): number | null {
  if (expectedCount === 0) return null;
  return metrics.recall;
}

async function runSearchPath(
  store: TimStore,
  fixture: FixtureStore,
  question: DatasetQuestion,
  projectLabel: string,
  byteBudget: number,
): Promise<{
  context: string;
  orderedEvidence: string[];
  semantic: QuestionModeResult['provider'];
  latencyMs: number;
}> {
  const start = performance.now();
  const entries = await store.search({
    query: question.text,
    project: projectLabel,
    topK: 10,
    ...(question.temporalAsOf ? { asOf: question.temporalAsOf } : {}),
  });
  const latencyMs = performance.now() - start;
  const parts = entries.map(e => `${e.title}\n${e.content}`);
  const context = assembleBoundedContext(parts, byteBudget);
  const includedIds: string[] = [];
  let assembled = '';
  for (const entry of entries) {
    const part = `${entry.title}\n${entry.content}`;
    const candidate = assembled ? `${assembled}\n---\n${part}` : part;
    if (Buffer.byteLength(candidate, 'utf8') <= byteBudget) {
      assembled = candidate;
      includedIds.push(entry.id);
    } else {
      break;
    }
  }
  const orderedEvidence = mapEntriesToOrderedEvidence(includedIds, fixture.entryIdToGold);
  return {
    context: applyContextByteBudget(context, byteBudget),
    orderedEvidence,
    semantic: {
      mode: 'fts',
      modelId: null,
      state: 'not_used',
      searchType: 'fts',
    },
    latencyMs,
  };
}

async function runBriefingPath(
  store: TimStore,
  fixture: FixtureStore,
  question: DatasetQuestion,
  tokenBudget: number,
): Promise<{
  context: string;
  orderedEvidence: string[];
  semantic: QuestionModeResult['provider'];
  latencyMs: number;
}> {
  const start = performance.now();
  const rawContext = await renderTimBriefing(store, fixture.projectLabel, question.text, tokenBudget);
  const latencyMs = performance.now() - start;
  const context = applyContextByteBudget(rawContext, tokenBudget);
  const allGold = [...fixture.goldToEntryId.keys()];
  const orderedEvidence = extractGoldFromContextInOrder(context, allGold);
  return {
    context,
    orderedEvidence,
    semantic: {
      mode: 'fts',
      modelId: null,
      state: 'not_used',
      searchType: 'fts',
    },
    latencyMs,
  };
}

function buildModeResult(
  mode: BenchmarkMode,
  question: DatasetQuestion,
  context: string,
  orderedEvidence: string[],
  provider: QuestionModeResult['provider'],
  latencyMs: number,
  fixedHandoffText: string,
  allGoldLabels: string[],
  byteBudget: number,
): QuestionModeResult {
  const expected = question.expectedGold;
  let boundedContext = context;
  let foundEvidence = orderedEvidence;

  if (mode === 'no-memory') {
    boundedContext = '';
    foundEvidence = [];
  } else if (mode === 'fixed-handoff') {
    boundedContext = applyContextByteBudget(fixedHandoffText, byteBudget);
    foundEvidence = extractGoldFromContextInOrder(boundedContext, allGoldLabels);
  } else {
    boundedContext = applyContextByteBudget(context, byteBudget);
    if (question.path === 'briefing') {
      foundEvidence = extractGoldFromContextInOrder(boundedContext, allGoldLabels);
    }
  }

  const evidence = computeEvidenceOutcome(
    expected,
    foundEvidence,
    question.irrelevantGold ?? [],
  );
  const metrics = computeRetrievalMetrics(expected, foundEvidence);

  return {
    mode,
    path: question.path,
    evidence,
    metrics,
    contextBytes: mode === 'no-memory' ? 0 : Buffer.byteLength(boundedContext, 'utf8'),
    estimatedTokens: mode === 'no-memory' ? 0 : estimateTextTokens(boundedContext),
    latencyMs,
    provider,
    contextPreview: boundedContext.slice(0, 200),
  };
}

function summarizeMode(mode: BenchmarkMode, results: QuestionModeResult[]): ModeSummary {
  const precisions = results.map(r => r.metrics.precision);
  const recalls = results.map(r => r.metrics.recall);
  return {
    mode,
    questions: results.length,
    totalExpected: results.reduce((s, r) => s + r.evidence.expected.length, 0),
    totalFound: results.reduce((s, r) => s + r.evidence.found.length, 0),
    totalMissing: results.reduce((s, r) => s + r.evidence.missing.length, 0),
    totalIrrelevant: results.reduce((s, r) => s + r.evidence.irrelevant.length, 0),
    macroPrecision: macroAverage(precisions),
    macroRecall: macroAverage(recalls),
    totalContextBytes: results.reduce((s, r) => s + r.contextBytes, 0),
    totalEstimatedTokens: results.reduce((s, r) => s + r.estimatedTokens, 0),
    totalLatencyMs: results.reduce((s, r) => s + r.latencyMs, 0),
  };
}

const FTS_PROVIDER: QuestionModeResult['provider'] = {
  mode: 'fts',
  modelId: null,
  state: 'not_used',
};

export async function runBenchmark(options: RunOptions = {}): Promise<BenchmarkReport> {
  const dataset = options.datasetOverride ?? loadDataset();
  const fixture = await buildFixtureStore(dataset);
  let memoryHealth: Awaited<ReturnType<typeof computeMemoryHealth>>;
  const allGoldLabels = [...fixture.goldToEntryId.keys()];

  const modes: BenchmarkMode[] = ['no-memory', 'fixed-handoff', 'tim'];
  const questionReports: BenchmarkReport['questions'] = [];

  try {
    memoryHealth = await computeMemoryHealth(fixture.store, { telemetryDir: fixture.tmpDir });
    for (const question of dataset.questions) {
      let timContext = '';
      let timOrderedEvidence: string[] = [];
      let timProvider: QuestionModeResult['provider'] = { ...FTS_PROVIDER };
      let timLatency = 0;

      if (question.path === 'search') {
        const run = await runSearchPath(
          fixture.store,
          fixture,
          question,
          dataset.projectLabel,
          dataset.contextBudget,
        );
        timContext = run.context;
        timOrderedEvidence = run.orderedEvidence;
        timProvider = run.semantic;
        timLatency = run.latencyMs;
      } else {
        const run = await runBriefingPath(
          fixture.store,
          fixture,
          question,
          dataset.contextBudget,
        );
        timContext = run.context;
        timOrderedEvidence = run.orderedEvidence;
        timProvider = run.semantic;
        timLatency = run.latencyMs;
      }

      const baselineProvider: QuestionModeResult['provider'] = { ...FTS_PROVIDER };

      const results: Record<BenchmarkMode, QuestionModeResult> = {
        'no-memory': buildModeResult(
          'no-memory',
          question,
          '',
          [],
          baselineProvider,
          0,
          dataset.fixedHandoff.text,
          allGoldLabels,
          dataset.contextBudget,
        ),
        'fixed-handoff': buildModeResult(
          'fixed-handoff',
          question,
          dataset.fixedHandoff.text,
          [],
          baselineProvider,
          0,
          dataset.fixedHandoff.text,
          allGoldLabels,
          dataset.contextBudget,
        ),
        tim: buildModeResult(
          'tim',
          question,
          timContext,
          timOrderedEvidence,
          timProvider,
          timLatency,
          dataset.fixedHandoff.text,
          allGoldLabels,
          dataset.contextBudget,
        ),
      };

      questionReports.push({
        id: question.id,
        lang: question.lang,
        text: question.text,
        results,
      });
    }
  } finally {
    closeFixtureStore(fixture);
  }

  const modeSummaries = modes.map(mode =>
    summarizeMode(mode, questionReports.map(q => q.results[mode])),
  );

  const baselineObservations = computeBaselineObservations(
    questionReports.map(q => ({
      id: q.id,
      timRecall: recallFromMetrics(q.results.tim.metrics, q.results.tim.evidence.expected.length),
      handoffRecall: recallFromMetrics(
        q.results['fixed-handoff'].metrics,
        q.results['fixed-handoff'].evidence.expected.length,
      ),
      noMemoryRecall: recallFromMetrics(
        q.results['no-memory'].metrics,
        q.results['no-memory'].evidence.expected.length,
      ),
    })),
  );

  const report: BenchmarkReport = {
    reportVersion: REPORT_VERSION,
    datasetVersion: DATASET_VERSION,
    datasetId: dataset.datasetId,
    generatedAt: new Date().toISOString(),
    provider: { ...FTS_PROVIDER },
    contextBudget: dataset.contextBudget,
    fixtureProvenance: dataset.provenance,
    modeSummaries,
    questions: questionReports,
    baselineObservations,
    notMeasured: [
      'agent_task_success',
      'maintenance_savings',
      'universal_superiority',
    ],
    memoryHealth,
    limitations: [
      'Search is full-text only. Synonym and cross-language wording that does not share tokens is a miss.',
      'Token counts use conservative UTF-8 byte heuristic, not a model tokenizer.',
      'Latency is local wall-clock and nondeterministic; not a stable regression threshold.',
      'Gold labels are agent-authored synthetic fixture conventions.',
      `All modes score evidence retained within the ${dataset.contextBudget}-byte context budget.`,
    ],
  };

  if (options.outputPath) {
    const fs = await import('node:fs');
    fs.writeFileSync(options.outputPath, JSON.stringify(report, null, 2), 'utf8');
  }

  return report;
}
