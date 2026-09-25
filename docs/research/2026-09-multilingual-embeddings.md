# Multilingual embeddings for TIM: September 2026 evaluation

## Method (five lines)

1. Copy `~/.tim/snapshots/latest.db` after resolving its symlink; open only the copy through `TimStore`, with migrations and staging disabled.
2. Join the shuffled `label-in-*`/`label-out-*` files to candidate IDs in `7-needle-gate/cands3.json` and `8-noise/cands8.json`; `9-gate` reuses these 90 prompts and is not another test set.
3. Restrict each query to its original project subtree and entries created before its timestamp, apply temporal validity and suppression, and exclude exchanges, checkpoints, and harness rows.
4. Compare current FTS and stored MiniLM vectors, rebuilt MiniLM and multilingual E5 over the same corpus, and deduplicated FTS/vector unions; use 2,000-character title/body slices and exact cosine ranking.
5. Report micro recall of labelled-useful pairs, labelled-useless and unjudged shares, vector-only useful hits at k=5/12, and measured CPU encoding time, query latency, model bytes, and process RAM.

## Dataset and scope

The two sets contain 40 and 50 prompts, with 542/537 labelled pairs and 79/54 useful pairs respectively: **90 prompts, 1,079 labels, 133 useful prompt-entry pairs, 95 distinct useful entries**. There are 78 German and 12 English prompts; 125 useful pairs are attached to German prompts, only eight to English prompts. Useful pairs occur in 44 prompts (27 in the first set, 17 in the second).

These are earlier agent judgments, not new human labels. `helpful: true` means the entry contains a concrete prior fact, decision, result, or constraint that helps with this particular prompt. The positive label often includes a `best` excerpt. Topic overlap alone, an unresolved referent such as “those bugs,” and unrelated history are negative. This experiment measures candidate retrieval, not whether the final reminder preserves the useful excerpt, and does not call Jev or any paid API.

The scoped projects are P0054, P0062, P0063, P0073, P0076, and P0077. Five second-set prompts originally had `project: null`; their collector searched without a project restriction. Preserving that behavior requires an unrestricted corpus for those five queries. Every other query keeps its own project boundary; scoped-only results are reported separately.

The copied 2026-09-25 19:00 Europe/Berlin snapshot contains **4,814 fresh MiniLM vectors**, rather than the 4,802 in the task's earlier observation. The FTS-eligible, historically available corpus has **10,253 entries**, including 4,800 eligible under the current vector kind policy. All 133 useful labelled pairs remain available. Four negative candidate excerpts differ from the labelled files; no positive excerpt differs. Nevertheless, 36 useful pairs refer to entries updated after the prompt timestamp. This is a date-restricted evaluation against current snapshot contents and usage counts, not a reconstruction of every historical database state.

The current index excludes every `SCHEMA_KINDS` value. This removes **74/133 useful pairs before vector ranking**: 38 batch summaries, 22 session summary roots, 10 commits, three projects, and one section. The expanded-corpus MiniLM control and the E5/current-kinds control separate that coverage problem from the model comparison. See [`getUnembedded` and vector search](../../packages/tim-store/src/store.ts), [schema kinds](../../packages/tim-core/src/schema-kinds.ts), and [the current FTS hook](../../packages/tim-hooks/src/prompt-submit.ts).

## Model and ranking contract

The one multilingual model tested is **intfloat/multilingual-e5-small**, its official `onnx/model_qint8_avx512_vnni.onnx` export at revision `614241f622f53c4eeff9890bdc4f31cfecc418b3`. The model supports German and English, has 384-dimensional output, and prescribes `query:`/`passage:` prefixes, masked mean pooling, normalization, and at most 512 tokens. These settings follow the [pinned model card](https://huggingface.co/intfloat/multilingual-e5-small/blob/614241f622f53c4eeff9890bdc4f31cfecc418b3/README.md) and [official ONNX files](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx). Quantization is part of the tested model; full-precision E5 and a second multilingual model were not tested.

No packages were added. E5 uses the installed `onnxruntime-node@1.21.0` and `@anush008/tokenizers@0.0.0`, dynamic batch padding, two intra-op threads, one inter-op thread, CPU execution, and batches of eight. The current English baseline uses `fastembed@2.1.0`, its existing local `all-MiniLM-L6-v2` artifact, unprefixed text, and the shipped pooling/padding behavior. The installed fastembed code extracts the first output token; passing E5 through its generic custom-model path would not implement E5's prescribed pooling. That path also cannot infer the required query/passage distinction. See [fastembed source](https://github.com/Anush008/fastembed-js/blob/main/src/fastembed.ts) and [TIM's current provider](../../packages/tim-store/src/embedding-provider.ts).

FTS uses the current `buildPromptSearchQuery`, `or-terms` mode where applicable, and current usage ranking. It follows the labelled collectors' historical replay window: fetch 40, filter pre-prompt creation dates/harness rows, then take 12. The production hook currently requests 12 directly; this evaluation is a candidate-source comparison, not an end-to-end hook replay. Stored MiniLM uses `TimStore.search(searchType: 'vector')`; rebuilt models use the same eligible corpus and exact cosine search. E5/current-kinds filters to today's indexable kinds before taking top-k.

A union means **FTS top-k ∪ vector top-k**, at most 2k candidates, with duplicates removed. It is not a k-slot ranking. The separate equal-budget RRF row fuses those two lists with `1/(60 + rank + 1)`, breaking ties by FTS insertion order, and keeps only k. No fusion weights or thresholds were fitted to labels.

## Results

Micro recall is labelled-useful hits divided by the 133 useful pairs. Vector-only useful counts hits in that source that are absent from the same prompt's FTS list at the same k. Noise share is labelled-useless divided by returned rows; unknown share is unjudged divided by returned rows. A union is the deduplicated pair of lists and may return up to 2k rows. RRF keeps k. Macro recall is stored in `results.json` and is not the figure below.

### All 90 prompts

| Source | Recall@5 | Noise@5 | Unknown@5 | Vector-only@5 | Recall@12 | Noise@12 | Unknown@12 | Vector-only@12 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FTS | 80/133 (60.2%) | 81.2% | 0.0% | 0 | 129/133 (97.0%) | 86.1% | 0.6% | 0 |
| Stored MiniLM | 18/133 (13.5%) | 12.9% | 83.1% | 6 | 31/133 (23.3%) | 11.8% | 85.4% | 0 |
| Rebuilt MiniLM | 23/133 (17.3%) | 15.8% | 79.1% | 5 | 45/133 (33.8%) | 11.9% | 83.9% | 3 |
| E5, current kinds | 18/133 (13.5%) | 14.4% | 81.6% | 7 (5 entries) | 35/133 (26.3%) | 11.0% | 85.7% | 0 |
| E5 | 35/133 (26.3%) | 16.0% | 76.2% | 8 | 57/133 (42.9%) | 12.9% | 81.9% | 1 |
| FTS ∪ stored MiniLM | 86/133 (64.7%) | 45.2% | 44.6% | 6 | 129/133 (97.0%) | 44.5% | 48.7% | 0 |
| FTS ∪ rebuilt MiniLM | 85/133 (63.9%) | 46.5% | 43.2% | 5 | 132/133 (99.2%) | 44.8% | 48.2% | 3 |
| FTS ∪ E5 | 88/133 (66.2%) | 47.2% | 42.0% | 8 | 130/133 (97.7%) | 45.4% | 47.6% | 1 |
| RRF (FTS, E5) | 64/133 (48.1%) | 53.1% | 32.7% | 3 | 105/133 (78.9%) | 47.8% | 42.5% | 1 |

FTS returns 426 rows at k=5 and 973 at k=12, because some prompts have fewer than k hits. Each pure vector list returns 450 and 1,080. FTS ∪ E5 returns 816 and 1,867. Every vector-only count above is a pair that FTS ranked below k and that the original FTS collectors had already labelled. See Limits.

On the 78 German prompts (125 useful pairs), E5 recalls 30/125 (24.0%) at k=5 and 49/125 (39.2%) at k=12. Rebuilt MiniLM recalls 17/125 (13.6%) and 38/125 (30.4%). FTS recalls 75/125 (60.0%) and 121/125 (96.8%). FTS ∪ E5 recalls 82/125 (65.6%) and 122/125 (97.6%). The 12 English prompts carry 8 useful pairs. Rebuilt MiniLM recalls 6/8 at k=5 and 7/8 at k=12; E5 recalls 5/8 and 8/8. That English slice is too small to rank the models.

All 133 useful pairs sit in the 85 project-scoped prompts, so the scoped cut matches the table above. The five unrestricted prompts contribute no useful labels. The single k=12 E5 vector-only hit is in the needle set: FTS recalls 75/79 there, FTS ∪ E5 recalls 76/79. The noise set is already 54/54 for FTS at k=12.

E5 restricted to current indexable kinds matches stored MiniLM at k=5 (18/133) and reaches 35/133 at k=12, below rebuilt MiniLM on the expanded corpus (45/133). Of the E5 standalone gain over stored MiniLM, a large part is the 74 useful pairs that `SCHEMA_KINDS` currently drops before ranking.

### Cost

Encoders ran one at a time on an AMD EPYC-Milan host with 4 logical CPUs. E5 used two intra-op threads and one inter-op thread. Query latency is per prompt: FTS is the collector-style search, stored MiniLM is `TimStore.search(searchType: 'vector')`, and rebuilt MiniLM / E5 are one query embedding plus exact cosine over the eligible slice. The union row adds FTS time and E5 time for the same prompt.

| | FTS | Stored MiniLM | Rebuilt MiniLM | E5 |
| --- | ---: | ---: | ---: | ---: |
| Corpus encode | — | already in the snapshot (4,814 vectors) | 21 min 45 s (1,304.9 s) | 11 min 56 s (715.8 s) |
| Model load | — | — | 0.39 s | 1.14 s |
| Model bytes | — | 91,333,577 | 91,333,577 | 135,431,043 |
| ONNX weights | — | 90,387,630 | 90,387,630 | 118,346,824 |
| Query p50 / p90 | 9.5 / 24.0 ms | 226.6 / 339.3 ms | 207.7 / 299.4 ms | 38.2 / 100.4 ms |
| RSS baseline → end | — | same process as rebuilt MiniLM | 132 MiB → 739 MiB | 127 MiB → 635 MiB |
| Peak RSS | — | same process as rebuilt MiniLM | 795 MiB | 1,000 MiB |

FTS ∪ E5 query latency is 49.8 ms p50 and 124.6 ms p90. Peak RSS is `process.resourceUsage().maxRSS` converted from kilobytes to bytes (E5 1,048,924,160; MiniLM 833,122,304). E5's extra bytes beyond the ONNX file are mostly `tokenizer.json` (17,082,730 bytes).


## Limits on the conclusion

Labels were collected from FTS candidate pools: two lexical variants for the first set and the shipped lexical query for the second. This creates a strong FTS ceiling advantage and leaves most novel vector candidates unjudged. An unjudged result is neither helpful nor useless. The noise statistic is therefore a **lower bound on irrelevant results**, not total precision, and a lower labelled-noise share alone does not prove cleaner retrieval. These data cannot measure recall of useful entries outside the original label pools or isolate German-query/English-entry recall, since entry language was not labelled.

The same sets previously informed the prompt hook. There is no untouched embedding holdout, no newly labelled vector-only pool, and no end-to-end Jev latency/quality run here. The model comparison changes both language coverage and the model's intended encoding contract; it is not a controlled claim that language alone explains the difference.

## Recommendation

**Drop the vector index.** Do not adopt `intfloat/multilingual-e5-small` as a second candidate source.

The prompt hook requests 12 FTS hits. At that cutoff FTS recalls **129/133 (97.0%)** labelled-useful pairs. FTS ∪ E5 recalls **130/133 (97.7%)**: one vector-only pair. The stored MiniLM union adds **zero** pairs at k=12. Equal-budget RRF is worse than FTS alone, **105/133 (78.9%)** at k=12 and **64/133 (48.1%)** at k=5. At k=5 the union lift is larger (80/133 to 88/133, eight vector-only pairs), and 42.0% of those union rows are unjudged. The lower labelled-noise share is the unjudged mass described in Limits, measured inside a pool that FTS already supplied.

E5 does beat MiniLM as a standalone ranker on this German-heavy set: **35/133 vs 23/133** at k=5 and **57/133 vs 45/133** at k=12, with a shorter corpus encode (11 min 56 s vs 21 min 45 s). That still leaves E5 at under half of FTS. On the expanded corpus, FTS ∪ rebuilt MiniLM at k=12 (**132/133**) beats FTS ∪ E5 (**130/133**), so the multilingual model is the weaker vector partner at the hook's width. The model is 135,431,043 bytes and the E5 run peaked at 1,000 MiB RSS. Those costs buy one labelled pair at k=12, and the labels cannot show recovery of useful entries outside the original FTS pools.

Next steps:

1. Leave `multilingual-e5-small` unwired. Do not backfill E5 vectors. The downloaded ONNX file stays in the ignored scratch directory.
2. Stop maintaining MiniLM vectors. The background writer is `embedUnembeddedEntries` in [`packages/tim-hooks/src/hooks.ts`](../../packages/tim-hooks/src/hooks.ts) (`TIM_EMBEDDING_DISABLED` already skips it). The query surfaces are `searchType` `vector` and `hybrid` on `tim_search` in [`packages/tim-mcp/src/server.ts`](../../packages/tim-mcp/src/server.ts) and [`packages/tim-mcp/src/tim-search-tool.ts`](../../packages/tim-mcp/src/tim-search-tool.ts). [`packages/tim-hooks/src/prompt-submit.ts`](../../packages/tim-hooks/src/prompt-submit.ts) already requests FTS only; keep that call.
3. Remove the index machinery with those callers: [`packages/tim-store/src/embedding-provider.ts`](../../packages/tim-store/src/embedding-provider.ts), [`packages/tim-store/src/vector-index.ts`](../../packages/tim-store/src/vector-index.ts), `getUnembedded` / `setVectors` / `entry_vectors` in [`packages/tim-store/src/store.ts`](../../packages/tim-store/src/store.ts), and the semantic-index section of [`packages/tim-store/src/memory-health.ts`](../../packages/tim-store/src/memory-health.ts). Drop the `fastembed` dependency and the local `all-MiniLM-L6-v2` cache (91,333,577 bytes under `~/.tim/models`).
4. Leave `SCHEMA_KINDS` as it is for this decision. The exclusion removes 74/133 useful pairs before vector ranking. Giving those kinds back to MiniLM still adds only three labelled pairs at k=12 (FTS ∪ rebuilt MiniLM = 132/133).
5. Keep FTS (`buildPromptSearchQuery`, hook top-12). Reconsider an embedding model only after a label pass on candidates that the original FTS collectors never returned.


## Reproduction and evidence

Run from this worktree after `npm run build`, using a fresh scratch directory. The labelled data remains read-only in the main checkout. The script refuses to open the snapshot in place, refuses to overwrite an existing scratch snapshot, and never issues SQL itself.

```bash
export EVAL_DIR="$PWD/tmp/multilingual-eval-replay"
export EVAL_LABELS="$HOME/projects/tim/tmp/jev-eval"
EVAL_COMMIT=$(git rev-parse HEAD) node scripts/multilingual-embeddings.mjs prepare
node scripts/multilingual-embeddings.mjs download
node scripts/multilingual-embeddings.mjs model e5
node scripts/multilingual-embeddings.mjs model minilm
node scripts/multilingual-embeddings.mjs summarize
```

The encoder processes are run sequentially. `results.json` records aggregates, per-prompt metrics, timings, file sizes, and artifact hashes; `provenance.json` records snapshot and label hashes. `corpus.json`, `cases.json`, database copies, downloaded models, and raw output stay under ignored `tmp/`. The committed [per-prompt CSV](2026-09-multilingual-embeddings.csv) contains counts without prompt or memory text. The [evaluation script](../../scripts/multilingual-embeddings.mjs) and [regression tests](../../scripts/__tests__/multilingual-embeddings.test.mjs) are the only code additions.

Snapshot SHA-256: `9c739e72b9b3ee4ccec66f746e4d5999f5b886f1ac6b0e1a812b89d34106c1f0`.
Repository baseline: `4406ff073e651d07ed73e3daa124e9a0b74a00b6`.

## Verification

Worktree `HEAD` was `4406ff073e651d07ed73e3daa124e9a0b74a00b6`, matching `provenance.json`. `EVAL_DIR` was `tmp/multilingual-eval` (gitignored). `prepare` was not rerun: `snapshot.db` was already there, and the script refuses to overwrite it. Snapshot SHA-256 in `provenance.json` matches the hash above. `download` was not rerun: `models/e5-small/model_qint8_avx512_vnni.onnx` and the tokenizer files were already present.

`model e5` was not rerun. `e5.log` records progress through `10008/10253` and then the cost object. `e5.json` has 90 rows, each with 12 ids, 12 scores, and `currentKinds`, and `corpusMs` 715,804.7. `model minilm` was run to completion:

```bash
export EVAL_DIR="$PWD/tmp/multilingual-eval"
node scripts/multilingual-embeddings.mjs model minilm
```

The log ends with the MiniLM cost object (`corpusMs` 1,304,910.9). `minilm.json` has 90 rows, each with a stored-vector `current` list of length 12. Then:

```bash
node scripts/multilingual-embeddings.mjs summarize
```

Exit 0. It wrote `tmp/multilingual-eval/results.json` and `tmp/multilingual-eval/per-prompt.csv` (1,621 lines: header plus 90 × 2 cutoffs × 9 sources). The committed CSV is that file copied to `docs/research/2026-09-multilingual-embeddings.csv`. Its columns are counts and ids-free keys only.

Regression tests, from this worktree, against the already-built `packages/*/dist`:

```bash
npx vitest run scripts/__tests__/multilingual-embeddings.test.mjs
```

`vitest` 3.2.7, started 2026-09-25 20:10:05 local: 1 file passed, 6 tests passed, duration 497 ms, exit 0. `node --test` does not apply; the file imports `vitest`, and `vitest.config.ts` includes `scripts/__tests__/*.test.mjs`.

