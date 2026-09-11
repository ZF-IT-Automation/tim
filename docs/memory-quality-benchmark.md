# Memory quality benchmark (#38)

Repeatable bilingual scenarios compare **no-memory**, **fixed-handoff**, and **TIM** retrieval using production store/MCP paths against temporary fixture databases. Gold labels are agent-authored synthetic fixture conventions — not production entry IDs.

## Commands

Deterministic CI smoke (default — synthetic embedding provider, no network):

```bash
npm run benchmark:memory-quality
```

Write structured JSON to a file:

```bash
npm run benchmark:memory-quality -- --output /tmp/memory-quality-report.json
```

Run package tests (schema validation, mode outcomes, CLI smoke):

```bash
npm test -- packages/tim-quality-benchmark/src/__tests__/benchmark.test.ts
```

Optional real local model smoke (calls default provider path; skipped with explicit reason when unavailable):

```bash
TIM_EMBEDDING_REAL_MODEL=1 npm run benchmark:memory-quality -- --real-provider
```

## Dataset and schema

| Field | Value |
|-------|-------|
| Report schema | `1.0.0` (`reportVersion`) |
| Dataset schema | `1.0.0` (`datasetVersion`, shipped at `packages/tim-quality-benchmark/dist/dataset/1.0.0.json`) |
| Dataset id | `memory-quality-v1` |
| Context budget | 4096 UTF-8 bytes applied to **all modes** (search, handoff, briefing) |

### Fixture scenarios

- **Synonyms (DE/EN):** zero lexical overlap via injected vectors (`vectorHint: motor` vs query *automobile* / *Kraftfahrzeug*).
- **Adversarial similar project:** `P3801` confuser entries must not appear in `P3800`-scoped search.
- **Temporal correction:** superseded deployment policy with `asOf` before/after questions.
- **Partial session:** `SessionManager` batch summary covering seq 1–2 with pending tail exchanges (no duplicate Sessions roots or fake session-summary-root entries).
- **Noisy history:** 120 log filler entries before reserved briefing tiers.

### Gold label conventions

Labels use the `gold:<slug>` prefix in fixture JSON and handoff text. Entry bodies include `[gold:…]` bracket markers for briefing evaluation. Provenance is declared in the dataset `provenance` field as agent-authored synthetic.

### Fixed handoff baseline

`fixedHandoff.text` is authored once before query selection. All modes use the same `question.expectedGold`; fixed-handoff observed evidence is derived from the static handoff text (after the shared context budget), never from per-question declared shortcuts.

## Production API paths exercised

| Capability | API |
|------------|-----|
| Semantic retrieval | `store.searchWithSemantics()` per call (`searchType: vector \| hybrid`, optional `asOf`) |
| Task briefing | `loadProjectForBriefing` + `searchTaskBriefingExtras` + `formatProjectOutput` |
| Memory health | `computeMemoryHealth(store)` (read-only, no model load) |
| Temporal | `asOf` on search for historical eligibility |
| Real embeddings | `getDefaultEmbeddingProvider()` when `TIM_EMBEDDING_REAL_MODEL=1` and not `TIM_EMBEDDING_DISABLED` |

`store.lastSearchSemantic` is **not** used.

## Report fields

Per question and mode:

- `evidence`: `expected`, `found`, `missing`, `irrelevant` (only evidence retained within the context budget)
- `metrics`: `precision`, `recall`, `meanFirstRank`, `ranks` (null when denominator zero; non-gold retained search hits and marked briefing noise count in the precision denominator). These are fixture evidence-unit metrics, not a classification of every word of boilerplate.
- `contextBytes`, `estimatedTokens` (UTF-8 byte heuristic), `latencyMs` (local wall-clock)
- `provider`: mode (`synthetic` \| `real`), model id, state, search metadata

Run-level:

- `modeSummaries`: macro aggregates per mode
- `baselineObservations`: computed from output (no fabricated improvements)
- `notMeasured`: `agent_task_success`, `maintenance_savings`, `universal_superiority`
- `memoryHealth`: snapshot from fixture store
- Sync telemetry is read from the temporary fixture directory, not the user's TIM configuration.
- `limitations`: explicit scope boundaries

## Interpretation

- **Synthetic default** tests retrieval plumbing only — not real-model semantic quality.
- **Real provider mode** is opt-in (`TIM_EMBEDDING_REAL_MODEL=1`, no `TIM_EMBEDDING_DISABLED`). When disabled, unavailable, or not requested, the report records `provider.skipped` with reason and **does not** run a synthetic benchmark labeled as real.
- **Latency** is nondeterministic and not a stable regression threshold.
- **Agent task success** and maintenance savings are not measured without running agents.

## Provider / data flow

```
dataset JSON (dist/dataset/) → buildFixtureStore (TimStore + SessionManager)
            → modes (same expectedGold, same 4096-byte budget):
                no-memory: empty context
                fixed-handoff: static handoff text → extract markers
                tim: searchWithSemantics OR briefing path → bounded context
            → map entry IDs / context markers → gold labels (+ non-gold noise markers)
            → metrics + JSON report
```
