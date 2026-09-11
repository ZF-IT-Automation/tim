# Memory quality benchmark (#38)

Repeatable bilingual scenarios compare **no-memory**, **fixed-handoff**, and **TIM** retrieval using production store/MCP paths against temporary fixture databases. Gold labels are human-authored synthetic fixture conventions — not production entry IDs.

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
| Dataset schema | `1.0.0` (`datasetVersion`, file `packages/tim-quality-benchmark/src/dataset/1.0.0.json`) |
| Dataset id | `memory-quality-v1` |
| Context budget | 4096 UTF-8 bytes (conservative token heuristic) |

### Fixture scenarios

- **Synonyms (DE/EN):** zero lexical overlap via injected vectors (`vectorHint: motor` vs query *automobile* / *Kraftfahrzeug*).
- **Adversarial similar project:** `P3801` confuser entries must not appear in `P3800`-scoped search.
- **Temporal correction:** superseded deployment policy with `asOf` before/after questions.
- **Partial session:** `SessionManager` batch summary covering seq 1–2 with pending tail exchanges.
- **Noisy history:** 120 log filler entries before reserved briefing tiers.

### Gold label conventions

Labels use the `gold:<slug>` prefix in fixture JSON and handoff text. Entry bodies include `[gold:…]` markers for briefing evaluation. Provenance is declared in the dataset `provenance` field.

### Fixed handoff baseline

`fixedHandoff.text` is authored once before query selection. Per-question `handoffContainsGold` declares which labels the handoff is expected to surface — not generated from each question's gold answer.

## Production API paths exercised

| Capability | API |
|------------|-----|
| Semantic retrieval | `store.searchWithSemantics()` per call (`searchType: vector \| hybrid`, optional `asOf`) |
| Task briefing | `loadProjectForBriefing` + `searchTaskBriefingExtras` + `formatProjectOutput` |
| Memory health | `computeMemoryHealth(store)` (read-only, no model load) |
| Temporal | `asOf` on search for historical eligibility |

`store.lastSearchSemantic` is **not** used.

## Report fields

Per question and mode:

- `evidence`: `expected`, `found`, `missing`, `irrelevant`
- `metrics`: `precision`, `recall`, `meanFirstRank`, `ranks` (null when denominator zero)
- `contextBytes`, `estimatedTokens` (UTF-8 byte heuristic), `latencyMs` (local wall-clock)
- `provider`: mode (`synthetic` \| `real`), model id, state, search metadata

Run-level:

- `modeSummaries`: macro aggregates per mode
- `baselineObservations`: computed from output (no fabricated improvements)
- `notMeasured`: `agent_task_success`, `maintenance_savings`, `universal_superiority`
- `memoryHealth`: snapshot from fixture store
- `limitations`: explicit scope boundaries

## Interpretation

- **Synthetic default** tests retrieval plumbing only — not real-model semantic quality.
- **Real provider mode** is opt-in; when disabled or unavailable the report records `provider.skipped` with reason. Synthetic/FTS fallback is never labeled as real semantic success.
- **Latency** is nondeterministic and not a stable regression threshold.
- **Agent task success** and maintenance savings are not measured without running agents.

## Provider / data flow

```
dataset JSON → buildFixtureStore (TimStore + SessionManager)
            → modes:
                no-memory: empty context
                fixed-handoff: static handoff text
                tim: searchWithSemantics OR briefing path
            → map entry IDs / context markers → gold labels
            → metrics + JSON report
```
