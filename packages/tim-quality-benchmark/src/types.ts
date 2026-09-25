/** Versioned benchmark report schema (#38). */

export const REPORT_VERSION = '1.0.0';
export const DATASET_VERSION = '1.0.0';

export type BenchmarkMode = 'no-memory' | 'fixed-handoff' | 'tim';

export type ProviderMode = 'fts';

export type QuestionPath = 'search' | 'briefing';

export interface DatasetEntry {
  goldLabel: string;
  title: string;
  body: string;
  section: string;
  tags?: string[];
  project?: string;
  temporal?: {
    validFrom?: string;
    validUntil?: string;
    supersededAt?: string;
  };
  /** goldLabel of entry this supersedes (fixture wiring only). */
  supersedesGold?: string;
}

export interface DatasetQuestion {
  id: string;
  lang: 'de' | 'en';
  text: string;
  path: QuestionPath;
  /** Accepted for compatibility. Search is full-text. */
  searchType?: string;
  expectedGold: string[];
  irrelevantGold?: string[];
  /** ISO timestamp for temporal search eligibility (#36). */
  temporalAsOf?: string;
}

export interface DatasetFixture {
  schemaVersion: string;
  datasetId: string;
  provenance: string;
  projectLabel: string;
  adversarialProjectLabel: string;
  contextBudget: number;
  fixedHandoff: {
    text: string;
    /** Gold labels explicitly present in handoff text. */
    containsGold: string[];
  };
  entries: DatasetEntry[];
  questions: DatasetQuestion[];
}

export interface EvidenceOutcome {
  expected: string[];
  found: string[];
  missing: string[];
  irrelevant: string[];
}

export interface RetrievalMetrics {
  precision: number | null;
  recall: number | null;
  /** Mean rank of first expected hit (1-based); null when none found. */
  meanFirstRank: number | null;
  /** Ranks of each expected gold label when found; absent labels omitted. */
  ranks: Record<string, number | null>;
}

export interface QuestionModeResult {
  mode: BenchmarkMode;
  path: QuestionPath;
  evidence: EvidenceOutcome;
  metrics: RetrievalMetrics;
  contextBytes: number;
  estimatedTokens: number;
  latencyMs: number;
  provider: {
    mode: ProviderMode;
    modelId: string | null;
    state: string;
    searchType?: string;
  };
  contextPreview?: string;
}

export interface ModeSummary {
  mode: BenchmarkMode;
  questions: number;
  totalExpected: number;
  totalFound: number;
  totalMissing: number;
  totalIrrelevant: number;
  macroPrecision: number | null;
  macroRecall: number | null;
  totalContextBytes: number;
  totalEstimatedTokens: number;
  totalLatencyMs: number;
}

export interface SkippedCheck {
  id: string;
  reason: string;
}

export interface BenchmarkReport {
  reportVersion: string;
  datasetVersion: string;
  datasetId: string;
  generatedAt: string;
  provider: {
    mode: ProviderMode;
    modelId: string | null;
    state: string;
    skipped?: SkippedCheck;
  };
  contextBudget: number;
  fixtureProvenance: string;
  modeSummaries: ModeSummary[];
  questions: Array<{
    id: string;
    lang: 'de' | 'en';
    text: string;
    results: Record<BenchmarkMode, QuestionModeResult>;
  }>;
  baselineObservations: string[];
  notMeasured: string[];
  memoryHealth?: unknown;
  limitations: string[];
}
