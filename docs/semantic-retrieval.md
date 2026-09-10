# Semantic retrieval (#33)

Device-local vector search complements lexical FTS. Vectors are never synced; each device maintains its own `entry_vectors` table.

## Search modes

| `searchType` | Behavior |
|---|---|
| `fts` | Lexical only. Never initializes an embedding model. |
| `vector` | Scoped vector candidates only. Empty results when the provider is disabled or unavailable — not reported as semantic success. |
| `hybrid` | Independent lexical + vector candidate pools, merged and deduplicated before ranking. Degrades deterministically to lexical-only when embedding is unavailable. |

MCP `tim_search` propagates the store's `lastSearchSemantic` metadata on each response under `semantic`.

## Configuration

| Variable | Effect |
|---|---|
| `TIM_EMBEDDING_DISABLED=1` | Provider state `disabled`. Vector mode returns `[]`; hybrid uses FTS only. |
| `TIM_EMBEDDING_MODEL` | Model ID (default `all-MiniLM-L6-v2`). Unknown IDs are rejected — no silent MiniLM fallback under another label. |
| `TIM_EMBEDDING_BATCH_SIZE` | Background hook batch size (default 32). |
| `TIM_HYBRID_WEIGHTS` | `fts,embed,graph` weights for hybrid re-ranking (default `1.0,2.0,0.5`). |

Supported models are listed in `SUPPORTED_EMBEDDING_MODELS` (`packages/tim-store/src/embedding-provider.ts`).

## Index freshness

Vectors store a `content_hash` fingerprint of indexed `title + body`. Any local edit, import, or remote sync that changes title/body deletes the vector row. `getUnembedded()` returns entries missing vectors, indexed under a non-current model ID, carrying an empty legacy `content_hash`, or whose fingerprint no longer matches current text.

Background embedding uses compare-and-set: `setVectors(entryId, vector, model, dimension, expectedContentHash)` writes only when `expectedContentHash` still matches the live entry fingerprint (#38). A mismatch leaves the row unembedded for a later pass.

## Injectable provider (tests and integrations)

```typescript
import { TimStore, type EmbeddingProvider } from 'tim-store';

const provider: EmbeddingProvider = {
  modelId: 'all-MiniLM-L6-v2',
  dimension: 384,
  state: 'enabled',
  embed: async (texts) => texts.map(() => new Float32Array(384)),
};

const store = new TimStore(dbPath, { embeddingProvider: provider });
```

Deterministic fixtures prove retrieval plumbing; they are not evidence of real-model quality.

## Index health accessor (#37 additive interface)

```typescript
const health = store.getSemanticIndexHealth();
// {
//   providerState: 'enabled' | 'disabled' | 'unavailable' | 'unknown',
//   configuredModel: string | null,  // injected provider modelId when set
//   supportedModel: boolean,
//   vectorCount, unembeddedCount, staleVectorCount, wrongModelCount
// }
```

`providerState` meanings:

| State | Meaning |
|---|---|
| `disabled` | `TIM_EMBEDDING_DISABLED=1` |
| `unavailable` | Configured model ID is unsupported |
| `unknown` | Default provider not yet initialized (or never attempted) |
| `enabled` | Injected provider enabled, or cached default init succeeded |

This accessor performs SQL counts only — it never loads a model. Absence of vectors is not reported as success when the provider is enabled.

## Benchmark hook (#38 additive interface)

Quality evaluation should call `store.search()` with `searchType: 'vector' | 'hybrid'` and read `store.lastSearchSemantic` for degradation flags. Use golden queries with injected vectors in CI; optional real-model smoke:

```bash
TIM_EMBEDDING_REAL_MODEL=1 npm test -- packages/tim-hooks/src/__tests__/embedding-hook.test.ts -t "real local model"
```

Real-model smoke verifies ONNX initialization only. Mocked or injected vectors remain the deterministic contract for regression tests.

## Limits

- Embedding text is truncated to 2000 characters (`embeddingText`).
- Vector candidates are scored over all eligible indexed rows on device — acceptable for early alpha scale.
- fastembed remains optional; missing ONNX runtime yields `unavailable`, not a crash.
