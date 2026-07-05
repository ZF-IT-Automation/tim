# TIM Retrieval Benchmark

## Purpose

Measure retrieval quality as Plans add new signals (FTS5 → hybrid → graph-boost).
Every change to search ranking MUST show a net improvement or no regression on
the golden query suite.

## Golden Queries

The suite lives in `packages/tim-store/src/__tests__/retrieval-benchmark.test.ts`.
To add a query: (1) write some entries with known relevant IDs, (2) add a
GoldenQuery with expectedIds, (3) ensure the test still passes.

## Running

```bash
NODE_ENV=development npx vitest run packages/tim-store/src/__tests__/retrieval-benchmark.test.ts
```

## LongMemEval Integration (future)

For Plan 12 §A: load LongMemEval-style suites, run the same Benchmark interface,
compare scores. The harness format (GoldenQuery → BenchmarkResult) is designed
to work with external suites via a JSON loader.
