/**
 * Dependency-injectable embedding provider contract for semantic retrieval (#33).
 * Default initialization uses fastembed when available; tests inject deterministic vectors.
 */

export type EmbeddingProviderState = 'enabled' | 'disabled' | 'unavailable' | 'unknown';

export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimension: number;
  readonly state: EmbeddingProviderState;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingModelSpec {
  fastembedEnum: string;
  dimension: number;
}

/** Supported local model IDs — unknown IDs must not silently map to MiniLM. */
export const SUPPORTED_EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  'all-MiniLM-L6-v2': { fastembedEnum: 'fast-all-MiniLM-L6-v2', dimension: 384 },
};

export function resolveConfiguredEmbeddingModelId(): string | null {
  if (process.env.TIM_EMBEDDING_DISABLED === '1') return null;
  return process.env.TIM_EMBEDDING_MODEL ?? 'all-MiniLM-L6-v2';
}

export function validateEmbeddingModelId(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_EMBEDDING_MODELS, modelId);
}

export function embeddingModelDimension(modelId: string): number | null {
  return SUPPORTED_EMBEDDING_MODELS[modelId]?.dimension ?? null;
}

function staticProvider(
  modelId: string,
  dimension: number,
  state: EmbeddingProviderState,
  embedFn?: (texts: string[]) => Promise<Float32Array[]>,
): EmbeddingProvider {
  return {
    modelId,
    dimension,
    state,
    embed: embedFn ?? (async () => {
      throw new Error(`embedding provider ${state}`);
    }),
  };
}

export function createDisabledEmbeddingProvider(
  modelId = resolveConfiguredEmbeddingModelId() ?? 'all-MiniLM-L6-v2',
): EmbeddingProvider {
  const dim = embeddingModelDimension(modelId) ?? 384;
  return staticProvider(modelId, dim, 'disabled');
}

export function createUnavailableEmbeddingProvider(
  modelId: string,
  _reason?: string,
): EmbeddingProvider {
  const dim = embeddingModelDimension(modelId) ?? 384;
  return staticProvider(modelId, dim, 'unavailable');
}

let cachedDefault: EmbeddingProvider | null | undefined;
let cachedDefaultModelId: string | null | undefined;
let defaultInitPromise: Promise<EmbeddingProvider | null> | null = null;
let defaultInitModelId: string | null = null;

/** Reset cached default provider (tests). */
export function resetDefaultEmbeddingProviderCache(): void {
  cachedDefault = undefined;
  cachedDefaultModelId = undefined;
  defaultInitPromise = null;
  defaultInitModelId = null;
}

/** True once default provider init has completed (success or unavailable). */
export function isDefaultEmbeddingProviderResolved(): boolean {
  return cachedDefault !== undefined;
}

/** Peek cached default without triggering initialization (#37 health). */
export function peekCachedDefaultEmbeddingProvider(): EmbeddingProvider | null | undefined {
  return cachedDefault;
}

/**
 * Reusable cached default local provider. Returns null when disabled via env.
 * Validates configured model IDs — unsupported names yield unavailable, not silent MiniLM.
 */
export async function getDefaultEmbeddingProvider(
  modelId = resolveConfiguredEmbeddingModelId(),
): Promise<EmbeddingProvider | null> {
  if (modelId === null) {
    return createDisabledEmbeddingProvider();
  }
  if (!validateEmbeddingModelId(modelId)) {
    return createUnavailableEmbeddingProvider(modelId);
  }
  if (cachedDefault !== undefined && cachedDefaultModelId === modelId) {
    return cachedDefault;
  }
  if (defaultInitPromise && defaultInitModelId === modelId) {
    return defaultInitPromise;
  }

  defaultInitModelId = modelId;
  defaultInitPromise = (async (): Promise<EmbeddingProvider | null> => {
    try {
      const { EmbeddingModel, FlagEmbedding } = await import('fastembed');
      const spec = SUPPORTED_EMBEDDING_MODELS[modelId]!;
      const embedder = await FlagEmbedding.init({ model: EmbeddingModel.AllMiniLML6V2 });
      const provider: EmbeddingProvider = {
        modelId,
        dimension: spec.dimension,
        state: 'enabled',
        async embed(texts: string[]): Promise<Float32Array[]> {
          const gen = embedder.embed(texts, texts.length);
          const batch = await gen.next();
          const vectors = batch.value;
          if (!vectors) return [];
          return vectors.map(v => new Float32Array(v));
        },
      };
      cachedDefault = provider;
      cachedDefaultModelId = modelId;
      return provider;
    } catch {
      const unavailable = createUnavailableEmbeddingProvider(modelId);
      cachedDefault = unavailable;
      cachedDefaultModelId = modelId;
      return unavailable;
    } finally {
      defaultInitPromise = null;
      defaultInitModelId = null;
    }
  })();

  return defaultInitPromise;
}

export interface SearchSemanticInfo {
  requestedMode: 'fts' | 'vector' | 'hybrid';
  providerState: EmbeddingProviderState;
  configuredModel: string | null;
  /** Hybrid/vector path fell back to lexical-only retrieval. */
  degradedToLexical?: boolean;
  /** Vector mode with no provider — empty results, not semantic success. */
  vectorUnavailable?: boolean;
}
