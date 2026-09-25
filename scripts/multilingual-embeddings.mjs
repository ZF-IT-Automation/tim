// Offline retrieval evaluation. Private inputs and outputs stay in the ignored scratch directory.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = resolve(process.env.EVAL_DIR ?? join(repo, 'tmp/multilingual-eval'));
const labelsRoot = resolve(process.env.EVAL_LABELS ?? join(homedir(), 'projects/tim/tmp/jev-eval'));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, data) => writeFileSync(join(scratch, name), JSON.stringify(data, null, 2) + '\n');
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const modelSpec = {
  repository: 'intfloat/multilingual-e5-small',
  revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
  weights: 'model_qint8_avx512_vnni.onnx',
};

export function meanPool(data, dims, masks) {
  const [batch, tokens, dimension] = dims;
  return Array.from({ length: batch }, (_, b) => {
    const vector = new Float32Array(dimension);
    for (let t = 0; t < tokens; t++) {
      if (!masks[b][t]) continue;
      for (let d = 0; d < dimension; d++) vector[d] += data[(b * tokens + t) * dimension + d];
    }
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid pooled embedding');
    return vector.map(x => x / norm);
  });
}

export function union(fts, vectors, k) {
  return [...new Set([...fts.slice(0, k), ...vectors.slice(0, k)])];
}

export function fuse(fts, vectors, k) {
  const scores = new Map();
  for (const source of [fts.slice(0, k), vectors.slice(0, k)]) {
    source.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1)));
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

export function measure(ids, labels, fts = []) {
  const unique = [...new Set(ids)];
  const totalUseful = Object.values(labels).filter(x => x === true).length;
  const useful = unique.filter(id => labels[id] === true);
  const useless = unique.filter(id => labels[id] === false).length;
  return {
    returned: unique.length, totalUseful, useful: useful.length, useless,
    unknown: unique.filter(id => labels[id] === undefined).length,
    recall: totalUseful ? useful.length / totalUseful : null,
    onlyVector: useful.filter(id => !fts.includes(id)),
  };
}

export function eligible(entry, prompt) {
  return entry.createdAt < prompt.createdAt
    && (prompt.project === null || entry.scopes.includes(prompt.project));
}

export function joinLabels(cases, inputs, outputs) {
  const canonical = new Map(cases.flatMap(p => p.candidates.map((c, n) => [`${p.i}:${n}`, { i: p.i, id: c.id }])));
  const byCid = new Map(inputs.flatMap(p => p.candidates.map(c => {
    const ref = canonical.get(c.cid);
    if (!ref || ref.i !== p.i || (c.id !== undefined && c.id !== ref.id)) throw new Error(`Candidate mismatch ${c.cid}`);
    return [c.cid, ref];
  })));
  const labelled = new Map();
  for (const row of outputs) {
    const ref = byCid.get(row.cid);
    if (!ref || typeof row.helpful !== 'boolean') throw new Error(`Invalid label ${row.cid}`);
    const key = `${ref.i}:${ref.id}`;
    if (labelled.has(key) && labelled.get(key) !== row.helpful) throw new Error(`Conflicting label ${row.cid}`);
    labelled.set(key, row.helpful);
  }
  return cases.map(p => ({
    ...p,
    labels: Object.fromEntries(p.candidates.filter(c => labelled.has(`${p.i}:${c.id}`))
      .map(c => [c.id, labelled.get(`${p.i}:${c.id}`)])),
  }));
}

export async function readRecallEntries(store) {
  const { SCHEMA_KINDS } = require('../packages/tim-core/dist/index.js');
  const { shouldSkipPromptRecall } = require('../packages/tim-store/dist/index.js');
  // A deliberately unmatched model enumerates indexable entries; FTS also admits schema kinds.
  const entries = await store.getUnembedded(Number.MAX_SAFE_INTEGER, 'evaluation-enumeration-only');
  for (const kind of SCHEMA_KINDS) {
    if (!['exchange', 'checkpoint'].includes(kind)) entries.push(...await store.getByMetadataKind(kind, Number.MAX_SAFE_INTEGER));
  }
  return store.filterSuppressed(entries).filter(entry => !['exchange', 'checkpoint'].includes(entry.metadata.kind) && !shouldSkipPromptRecall(entry));
}

async function prepare() {
  const { TimStore, shouldSkipPromptRecall } = require('../packages/tim-store/dist/index.js');
  const { buildPromptSearchQuery, SCHEMA_KINDS } = require('../packages/tim-core/dist/index.js');
  const source = realpathSync(join(homedir(), '.tim/snapshots/latest.db'));
  if (!source.startsWith(realpathSync(join(homedir(), '.tim/snapshots')) + '/')) throw new Error('Snapshot must resolve inside snapshots');
  const db = join(scratch, 'snapshot.db');
  if (existsSync(db)) throw new Error('Scratch snapshot already exists; use a fresh EVAL_DIR');
  copyFileSync(source, db);
  const provenance = { source, snapshotSha256: sha(db), codeCommit: process.env.EVAL_COMMIT ?? null, inputs: {} };
  const load = path => {
    provenance.inputs[path] = sha(join(labelsRoot, path));
    return readJson(join(labelsRoot, path));
  };
  const oldPrompts = load('2-prompt-recall/prompts.json').prompts;
  const cases = [];
  for (const [set, file] of [['7-needle-gate', 'cands3.json'], ['8-noise', 'cands8.json']]) {
    const inputs = [], outputs = [];
    for (const name of readdirSync(join(labelsRoot, set)).sort()) {
      if (name.startsWith('label-in-')) inputs.push(...load(`${set}/${name}`));
      if (name.startsWith('label-out-')) outputs.push(...load(`${set}/${name}`));
    }
    const rows = load(`${set}/${file}`).map(p => {
      const old = set === '7-needle-gate' ? oldPrompts[p.i] : p;
      if (old.prompt !== p.prompt) throw new Error(`Prompt mismatch ${set}:${p.i}`);
      return { ...p, key: `${set}:${p.i}`, set, createdAt: old.createdAt, lang: old.lang ?? old.langGuess };
    });
    cases.push(...joinLabels(rows, inputs, outputs));
  }
  const gates = load('9-gate/gate-raw.json');
  if (gates.length !== cases.length) throw new Error('Gate set differs from labelled cases');
  const store = new TimStore(db, { allowMigrations: false, staging: false });
  try {
    const indexHealth = store.getSemanticIndexHealth();
    const all = await readRecallEntries(store);
    const roots = new Map();
    for (const project of new Set(cases.map(p => p.project).filter(Boolean))) {
      const result = await store.resolveProjectLabel(project);
      if (result.status !== 'found') throw new Error(`Project does not resolve: ${project}`);
      roots.set((await store.read(result.label)).id, project);
    }
    const cache = new Map(all.map(e => [e.id, e]));
    const corpus = [];
    for (const entry of all) {
      const scopes = [];
      let cursor = entry;
      const visited = new Set();
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        if (roots.has(cursor.id)) scopes.push(roots.get(cursor.id));
        if (!cursor.parentId) break;
        if (!cache.has(cursor.parentId)) cache.set(cursor.parentId, await store.read(cursor.parentId, { showIrrelevant: true }));
        cursor = cache.get(cursor.parentId);
        if (cursor?.tombstonedAt) break;
      }
      const item = { id: entry.id, title: entry.title, content: entry.content, createdAt: entry.createdAt, updatedAt: entry.updatedAt, metadata: entry.metadata, scopes, currentIndexEligible: !SCHEMA_KINDS.has(entry.metadata.kind) };
      if (cases.some(p => eligible(item, p))) corpus.push(item);
    }
    const corpusIds = new Set(corpus.map(e => e.id));
    const { entryTemporallyEligibleAt } = require('../packages/tim-store/dist/temporal.js');
    for (const p of cases) {
      const query = buildPromptSearchQuery(p.prompt);
      const start = performance.now();
      const hits = query ? await store.search({ query, topK: 40, searchType: 'fts', project: p.project ?? undefined, ftsQueryMode: query.includes(' OR ') ? 'or-terms' : 'literal', excludeKinds: ['exchange', 'checkpoint'], asOf: p.createdAt }) : [];
      p.ftsMs = performance.now() - start;
      p.fts = hits.filter(e => !shouldSkipPromptRecall(e) && e.createdAt < p.createdAt).slice(0, 12).map(e => e.id);
      p.eligibleIds = corpus.filter(e => eligible(e, p) && entryTemporallyEligibleAt(e, new Date(p.createdAt))).map(e => e.id);
      p.unavailableUseful = Object.keys(p.labels).filter(id => p.labels[id] && !p.eligibleIds.includes(id));
      p.missingLabelIds = Object.keys(p.labels).filter(id => !corpusIds.has(id));
      delete p.candidates;
    }
    save('corpus.json', corpus);
    save('cases.json', cases);
    save('provenance.json', { ...provenance, indexHealth, corpusCount: corpus.length, projects: [...roots.values()], unrestrictedPrompts: cases.filter(p => p.project === null).length, cpu: cpus()[0].model, logicalCpus: cpus().length });
    console.log(JSON.stringify({ corpus: corpus.length, prompts: cases.length, useful: cases.reduce((n, p) => n + Object.values(p.labels).filter(Boolean).length, 0), unavailableUseful: cases.flatMap(p => p.unavailableUseful).length, indexHealth }));
  } finally {
    store.close();
  }
}

async function download() {
  const dir = join(scratch, 'models/e5-small');
  mkdirSync(dir, { recursive: true });
  for (const file of [modelSpec.weights, 'config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json']) {
    if (existsSync(join(dir, file))) continue;
    const response = await fetch(`https://huggingface.co/${modelSpec.repository}/resolve/${modelSpec.revision}/onnx/${file}`);
    if (!response.ok) throw new Error(`Download ${file}: ${response.status}`);
    writeFileSync(join(dir, file), Buffer.from(await response.arrayBuffer()));
  }
}

async function e5Provider() {
  const { Tokenizer } = require('@anush008/tokenizers');
  const ort = require('onnxruntime-node');
  const dir = join(scratch, 'models/e5-small');
  const tokenizer = Tokenizer.fromFile(join(dir, 'tokenizer.json'));
  tokenizer.setTruncation(512);
  tokenizer.disablePadding();
  const session = await ort.InferenceSession.create(join(dir, modelSpec.weights), {
    executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 2, interOpNumThreads: 1,
  });
  return {
    modelId: 'multilingual-e5-small-qint8', dimension: 384, state: 'enabled',
    async embed(texts, prefix = 'passage: ') {
      const encoded = (await Promise.all(texts.map(text => tokenizer.encode(prefix + text))))
        .map(e => ({ ids: e.getIds(), mask: e.getAttentionMask(), types: e.getTypeIds() }));
      const length = Math.max(...encoded.map(e => e.ids.length));
      const masks = encoded.map(e => Array.from({ length }, (_, i) => e.mask[i] ?? 0));
      const fields = {
        input_ids: encoded.map(e => Array.from({ length }, (_, i) => e.ids[i] ?? 1)),
        attention_mask: masks,
        token_type_ids: encoded.map(e => Array.from({ length }, (_, i) => e.types[i] ?? 0)),
      };
      const inputs = Object.fromEntries(session.inputNames.map(name => [name, new ort.Tensor('int64', BigInt64Array.from(fields[name].flat(), BigInt), [texts.length, length])]));
      const result = await session.run(inputs);
      const output = result.last_hidden_state;
      if (output.dims[2] !== 384) throw new Error('Unexpected E5 output dimension');
      return meanPool(output.data, output.dims, masks);
    },
    close: () => session.release(),
  };
}

async function runModel(name) {
  const { TimStore, cosineSimilarity, shouldSkipPromptRecall } = require('../packages/tim-store/dist/index.js');
  const { embeddingText } = require('../packages/tim-store/dist/vector-index.js');
  const corpus = readJson(join(scratch, 'corpus.json'));
  const cases = readJson(join(scratch, 'cases.json'));
  const baselineRss = process.memoryUsage().rss;
  const started = performance.now();
  let provider;
  let modelDir;
  if (name === 'minilm') {
    const { FlagEmbedding, EmbeddingModel } = require('fastembed');
    const embedder = await FlagEmbedding.init({ model: EmbeddingModel.AllMiniLML6V2, cacheDir: join(homedir(), '.tim/models') });
    provider = { modelId: 'all-MiniLM-L6-v2', dimension: 384, state: 'enabled', async embed(texts) { return (await embedder.embed(texts, texts.length).next()).value.map(v => new Float32Array(v)); } };
    modelDir = join(homedir(), '.tim/models/fast-all-MiniLM-L6-v2');
  } else if (name === 'e5') {
    provider = await e5Provider();
    modelDir = join(scratch, 'models/e5-small');
  } else throw new Error('Model must be minilm or e5');
  const loadMs = performance.now() - started;
  const modelFiles = Object.fromEntries(readdirSync(modelDir).filter(f => statSync(join(modelDir, f)).isFile()).map(f => [f, { bytes: statSync(join(modelDir, f)).size, sha256: sha(join(modelDir, f)) }]));
  const vectors = [];
  const embedStart = performance.now();
  for (let i = 0; i < corpus.length; i += 8) {
    vectors.push(...await provider.embed(corpus.slice(i, i + 8).map(e => embeddingText(e.title, e.content))));
    if (i % 400 === 0) console.log(`${name}: ${vectors.length}/${corpus.length} entries, ${((performance.now() - embedStart) / 1000).toFixed(1)}s`);
  }
  const corpusMs = performance.now() - embedStart;
  const store = name === 'minilm' ? new TimStore(join(scratch, 'snapshot.db'), { allowMigrations: false, staging: false, embeddingProvider: provider }) : null;
  const rows = [];
  for (const p of cases) {
    const start = performance.now();
    const [query] = await provider.embed([p.prompt], 'query: ');
    const embeddingMs = performance.now() - start;
    const allowed = new Set(p.eligibleIds);
    const scored = corpus.flatMap((e, i) => allowed.has(e.id) ? [{ id: e.id, similarity: cosineSimilarity(query, vectors[i]), currentIndexEligible: e.currentIndexEligible }] : [])
      .sort((a, b) => b.similarity - a.similarity);
    const ranked = scored.slice(0, 12);
    const totalMs = performance.now() - start;
    const row = { key: p.key, ids: ranked.map(e => e.id), scores: ranked.map(e => e.similarity), currentKinds: scored.filter(e => e.currentIndexEligible).slice(0, 12).map(e => e.id), embeddingMs, totalMs };
    if (store) {
      const currentStart = performance.now();
      row.current = (await store.search({ query: p.prompt, topK: 40, searchType: 'vector', project: p.project ?? undefined, asOf: p.createdAt }))
        .filter(e => allowed.has(e.id) && !shouldSkipPromptRecall(e)).slice(0, 12).map(e => e.id);
      row.currentMs = performance.now() - currentStart;
    }
    rows.push(row);
  }
  store?.close();
  const cost = { model: provider.modelId, modelSpec: name === 'e5' ? modelSpec : null, loadMs, corpusMs, baselineRss, rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024, modelFiles, modelBytes: Object.values(modelFiles).reduce((n, f) => n + f.bytes, 0) };
  save(`${name}.json`, { cost, rows });
  console.log(JSON.stringify(cost));
  await provider.close?.();
}

function summarize() {
  const cases = readJson(join(scratch, 'cases.json'));
  const mini = readJson(join(scratch, 'minilm.json'));
  const e5 = readJson(join(scratch, 'e5.json'));
  const perPrompt = cases.map(p => {
    const m = mini.rows.find(r => r.key === p.key), e = e5.rows.find(r => r.key === p.key);
    const result = { key: p.key, project: p.project, lang: p.lang, metrics: {} };
    for (const k of [5, 12]) {
      const sources = {
        fts: p.fts.slice(0, k), currentMiniLM: m.current.slice(0, k), rebuiltMiniLM: m.ids.slice(0, k),
        e5CurrentKinds: e.currentKinds.slice(0, k), e5: e.ids.slice(0, k),
        unionCurrentMiniLM: union(p.fts, m.current, k), unionRebuiltMiniLM: union(p.fts, m.ids, k),
        unionE5: union(p.fts, e.ids, k), rrfE5: fuse(p.fts, e.ids, k),
      };
      result.metrics[k] = Object.fromEntries(Object.entries(sources).map(([name, ids]) => [name, measure(ids, p.labels, p.fts.slice(0, k))]));
    }
    return result;
  });
  const groups = { all: perPrompt, needle: perPrompt.filter(p => p.key.startsWith('7-')), noise: perPrompt.filter(p => p.key.startsWith('8-')), de: perPrompt.filter(p => p.lang === 'de'), en: perPrompt.filter(p => p.lang === 'en'), scoped: perPrompt.filter(p => p.project !== null) };
  const aggregates = {};
  for (const [group, prompts] of Object.entries(groups)) {
    aggregates[group] = {};
    for (const k of [5, 12]) {
      aggregates[group][k] = {};
      for (const source of Object.keys(perPrompt[0].metrics[k])) {
        const rows = prompts.map(p => p.metrics[k][source]);
        const sums = Object.fromEntries(['returned', 'totalUseful', 'useful', 'useless', 'unknown'].map(key => [key, rows.reduce((n, r) => n + r[key], 0)]));
        const hasUseful = rows.filter(r => r.recall !== null);
        aggregates[group][k][source] = { ...sums, recall: sums.totalUseful ? sums.useful / sums.totalUseful : null, macroRecall: hasUseful.length ? hasUseful.reduce((n, r) => n + r.recall, 0) / hasUseful.length : null, noiseShare: sums.returned ? sums.useless / sums.returned : null, unknownShare: sums.returned ? sums.unknown / sums.returned : null, onlyVectorPairs: rows.reduce((n, r) => n + r.onlyVector.length, 0), onlyVectorEntries: new Set(rows.flatMap(r => r.onlyVector)).size, prompts: rows.length, usefulPrompts: hasUseful.length };
      }
    }
  }
  const distribution = numbers => {
    const sorted = [...numbers].sort((a, b) => a - b);
    return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p90: sorted[Math.ceil(sorted.length * 0.9) - 1] };
  };
  const latency = { fts: distribution(cases.map(p => p.ftsMs)), currentMiniLM: distribution(mini.rows.map(r => r.currentMs)), rebuiltMiniLM: distribution(mini.rows.map(r => r.totalMs)), e5: distribution(e5.rows.map(r => r.totalMs)), unionE5: distribution(cases.map((p, i) => p.ftsMs + e5.rows[i].totalMs)) };
  save('results.json', { aggregates, latency, costs: { minilm: mini.cost, e5: e5.cost }, perPrompt });
  const csv = ['prompt,project,language,k,source,labelled_useful,returned,useful,useless,unjudged,vector_only_useful'];
  for (const p of perPrompt) for (const k of [5, 12]) {
    for (const [source, m] of Object.entries(p.metrics[k])) {
      csv.push([p.key, p.project ?? 'unrestricted', p.lang, k, source, m.totalUseful, m.returned, m.useful, m.useless, m.unknown, m.onlyVector.length].join(','));
    }
  }
  writeFileSync(join(scratch, 'per-prompt.csv'), csv.join('\n') + '\n');
  console.log(JSON.stringify({ aggregates: aggregates.all, latency }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!scratch.startsWith(join(repo, 'tmp') + '/')) throw new Error('EVAL_DIR must be under this worktree tmp/');
  mkdirSync(scratch, { recursive: true });
  const [command, model] = process.argv.slice(2);
  if (command === 'prepare') await prepare();
  else if (command === 'download') await download();
  else if (command === 'model') await runModel(model);
  else if (command === 'summarize') summarize();
  else throw new Error('Usage: node scripts/multilingual-embeddings.mjs prepare|download|model minilm|model e5|summarize');
}
