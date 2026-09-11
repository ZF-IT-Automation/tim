import { performance } from 'node:perf_hooks';
import {
  computeMemoryHealth,
  resetDefaultEmbeddingProviderCache,
  type EmbeddingProvider,
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
  computeBaselineObservations,
  computeEvidenceOutcome,
  computeRetrievalMetrics,
  extractGoldFromContext,
  macroAverage,
  mapEntryIdsToGold,
} from './metrics.js';
import { createSyntheticEmbeddingProvider, SYNTHETIC_MODEL_ID } from './synthetic-provider.js';
import type {
  BenchmarkMode,
  BenchmarkReport,
  DatasetQuestion,
  ModeSummary,
  ProviderMode,
  QuestionModeResult,
  SkippedCheck,
} from './types.js';
import { DATASET_VERSION, REPORT_VERSION } from './types.js';

export interface RunOptions {
  providerMode?: ProviderMode;
  outputPath?: string;
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
): Promise<{
  context: string;
  orderedGold: string[];
  semantic: QuestionModeResult['provider'];
  latencyMs: number;
}> {
  const start = performance.now();
  const searchType = question.searchType ?? 'hybrid';
  const { entries, semantic } = await store.searchWithSemantics({
    query: question.text,
    project: projectLabel,
    topK: 10,
    searchType,
    ...(question.temporalAsOf ? { asOf: question.temporalAsOf } : {}),
  });
  const latencyMs = performance.now() - start;
  const orderedGold = mapEntryIdsToGold(entries.map(e => e.id), fixture.entryIdToGold);
  const context = entries.map(e => `${e.title}\n${e.content}`).join('\n---\n');
  return {
    context,
    orderedGold,
    semantic: {
      mode: 'synthetic',
      modelId: semantic.configuredModel,
      state: semantic.providerState,
      searchType,
      degradedToLexical: semantic.degradedToLexical,
      vectorUnavailable: semantic.vectorUnavailable,
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
  orderedGold: string[];
  semantic: QuestionModeResult['provider'];
  latencyMs: number;
}> {
  const start = performance.now();
  const context = await renderTimBriefing(store, fixture.projectLabel, question.text, tokenBudget);
  const latencyMs = performance.now() - start;
  const allGold = [...fixture.goldToEntryId.keys()];
  const orderedGold = extractGoldFromContext(context, allGold);
  return {
    context,
    orderedGold,
    semantic: {
      mode: 'synthetic',
      modelId: SYNTHETIC_MODEL_ID,
      state: 'enabled',
      searchType: 'fts',
    },
    latencyMs,
  };
}

function buildModeResult(
  mode: BenchmarkMode,
  question: DatasetQuestion,
  context: string,
  orderedGold: string[],
  provider: QuestionModeResult['provider'],
  latencyMs: number,
  providerMode: ProviderMode,
): QuestionModeResult {
  const contextBytes = Buffer.byteLength(context, 'utf8');
  const estimatedTokens = estimateTextTokens(context);

  let expected = question.expectedGold;
  let foundGold = orderedGold;
  if (mode === 'no-memory') {
    context = '';
    foundGold = [];
  } else if (mode === 'fixed-handoff') {
    const dataset = loadDataset();
    context = dataset.fixedHandoff.text;
    foundGold = question.handoffContainsGold ?? [];
    expected = question.handoffContainsGold ?? [];
  }

  const evidence = computeEvidenceOutcome(
    expected,
    foundGold,
    question.irrelevantGold ?? [],
  );
  const metrics = computeRetrievalMetrics(expected, foundGold);

  return {
    mode,
    path: question.path,
    evidence,
    metrics,
    contextBytes: mode === 'no-memory' ? 0 : Buffer.byteLength(context, 'utf8'),
    estimatedTokens: mode === 'no-memory' ? 0 : estimateTextTokens(context),
    latencyMs,
    provider: { ...provider, mode: providerMode },
    contextPreview: context.slice(0, 200),
  };
}

function summarizeMode(
  mode: BenchmarkMode,
  results: QuestionModeResult[],
): ModeSummary {
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

async function resolveRealProvider(): Promise<{
  provider: EmbeddingProvider | null;
  skipped?: SkippedCheck;
}> {
  if (process.env.TIM_EMBEDDING_REAL_MODEL !== '1') {
    return {
      provider: null,
      skipped: {
        id: 'real-provider',
        reason: 'TIM_EMBEDDING_REAL_MODEL not set to 1; real local model mode not requested.',
      },
    };
  }
  resetDefaultEmbeddingProviderCache();
  delete process.env.TIM_EMBEDDING_DISABLED;
  const { TimStore: Store } = await import('tim-store');
  const probeDir = await import('node:os').then(os => os.tmpdir());
  const probePath = `${probeDir}/tim-quality-real-probe-${Date.now()}.db`;
  const probe = new Store(probePath);
  try {
    const health = probe.getSemanticIndexHealth();
    if (health.providerState !== 'enabled') {
      return {
        provider: null,
        skipped: {
          id: 'real-provider',
          reason: `Real provider unavailable: state=${health.providerState}`,
        },
      };
    }
    return { provider: null };
  } finally {
    probe.close();
    await import('node:fs').then(fs => {
      try { fs.unlinkSync(probePath); } catch { /* ignore */ }
    });
  }
}

export async function runBenchmark(options: RunOptions = {}): Promise<BenchmarkReport> {
  const providerMode: ProviderMode = options.providerMode ?? 'synthetic';
  const dataset = loadDataset();
  let skipped: SkippedCheck | undefined;
  let provider: EmbeddingProvider;

  if (providerMode === 'real') {
    const real = await resolveRealProvider();
    if (real.skipped) {
      skipped = real.skipped;
      provider = createSyntheticEmbeddingProvider();
    } else {
      provider = createSyntheticEmbeddingProvider();
    }
  } else {
    provider = createSyntheticEmbeddingProvider();
  }

  const fixture = await buildFixtureStore(dataset, provider);
  const memoryHealth = await computeMemoryHealth(fixture.store);

  const modes: BenchmarkMode[] = ['no-memory', 'fixed-handoff', 'tim'];
  const questionReports: BenchmarkReport['questions'] = [];

  try {
    for (const question of dataset.questions) {
      let timContext = '';
      let timOrderedGold: string[] = [];
      let timProvider: QuestionModeResult['provider'] = {
        mode: providerMode,
        modelId: SYNTHETIC_MODEL_ID,
        state: 'enabled',
      };
      let timLatency = 0;

      if (question.path === 'search') {
        const run = await runSearchPath(fixture.store, fixture, question, dataset.projectLabel);
        timContext = run.context;
        timOrderedGold = run.orderedGold;
        timProvider = { ...run.semantic, mode: providerMode };
        timLatency = run.latencyMs;
      } else {
        const run = await runBriefingPath(
          fixture.store,
          fixture,
          question,
          dataset.contextBudget,
        );
        timContext = run.context;
        timOrderedGold = run.orderedGold;
        timProvider = { ...run.semantic, mode: providerMode };
        timLatency = run.latencyMs;
      }

      const results: Record<BenchmarkMode, QuestionModeResult> = {
        'no-memory': buildModeResult('no-memory', question, '', [], timProvider, 0, providerMode),
        'fixed-handoff': buildModeResult(
          'fixed-handoff',
          question,
          dataset.fixedHandoff.text,
          question.handoffContainsGold ?? [],
          timProvider,
          0,
          providerMode,
        ),
        tim: buildModeResult(
          'tim',
          question,
          timContext,
          timOrderedGold,
          timProvider,
          timLatency,
          providerMode,
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
    provider: {
      mode: providerMode,
      modelId: providerMode === 'synthetic' ? SYNTHETIC_MODEL_ID : null,
      state: provider.state,
      ...(skipped ? { skipped } : {}),
    },
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
      'Synthetic provider tests retrieval plumbing only, not real-model semantic understanding.',
      'Token counts use conservative UTF-8 byte heuristic, not a model tokenizer.',
      'Latency is local wall-clock and nondeterministic; not a stable regression threshold.',
      'Gold labels are human-authored synthetic fixture conventions.',
      'Real local model mode requires TIM_EMBEDDING_REAL_MODEL=1 and an enabled provider.',
    ],
  };

  if (options.outputPath) {
    const fs = await import('node:fs');
    fs.writeFileSync(options.outputPath, JSON.stringify(report, null, 2), 'utf8');
  }

  return report;
}
