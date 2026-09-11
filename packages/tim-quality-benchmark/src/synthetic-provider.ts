import type { EmbeddingProvider } from 'tim-store';

const MODEL = 'benchmark-synthetic-v1';
const DIM = 384;

/** Deterministic unit vectors keyed by vectorHint — tests plumbing, not model quality. */
const HINT_VECTORS: Record<string, number[]> = {
  motor: [0.9, 0.1, 0.05],
  noise: [0.05, 0.05, 0.95],
  rule: [0.1, 0.85, 0.1],
  auth: [0.15, 0.8, 0.15],
  decision: [0.2, 0.2, 0.8],
  default: [0.33, 0.33, 0.34],
};

const QUERY_VECTORS: Record<string, number[]> = {
  automobile: [0.88, 0.12, 0.06],
  kraftfahrzeug: [0.87, 0.13, 0.07],
  kraftfahrzeuge: [0.87, 0.13, 0.07],
  marketing: [0.06, 0.06, 0.94],
  deployment: [0.22, 0.22, 0.78],
  policy: [0.22, 0.22, 0.78],
  merge: [0.12, 0.86, 0.12],
  auth: [0.16, 0.81, 0.14],
  middleware: [0.16, 0.81, 0.14],
};

function unitVector(values: number[]): Float32Array {
  const arr = new Float32Array(DIM);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  return arr;
}

function vectorForText(text: string): Float32Array {
  const lower = text.toLowerCase();
  for (const [needle, vec] of Object.entries(QUERY_VECTORS)) {
    if (lower.includes(needle)) return unitVector(vec);
  }
  return unitVector(HINT_VECTORS.default);
}

export function vectorForHint(hint: string | undefined): Float32Array {
  const key = hint && HINT_VECTORS[hint] ? hint : 'default';
  return unitVector(HINT_VECTORS[key]);
}

export function createSyntheticEmbeddingProvider(): EmbeddingProvider {
  return {
    modelId: MODEL,
    dimension: DIM,
    state: 'enabled',
    embed: async (texts: string[]) => texts.map(vectorForText),
  };
}

export const SYNTHETIC_MODEL_ID = MODEL;
export const SYNTHETIC_DIMENSION = DIM;
