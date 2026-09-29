#!/usr/bin/env node
/**
 * Summarizer test protocol (docs/summarizer-eval-protocol.md): every chain
 * candidate runs the same frozen inputs through the shipping prompt builders and
 * the shipping CLI invocation, and comes back as numbers.
 *
 *   eval-summarizer extract [--projects P0063,P0054] [--force]
 *   eval-summarizer run [--trials 3] [--candidates <file>]
 *
 * Fixtures and results live under ~/.tim/bench/, never in the repo: they are
 * real session content.
 */
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BATCH_SUMMARY_MAX_CHARS, getTimDir, loadConfig } from 'tim-core';
import {
  TimStore,
  SessionManager,
  findChildByKind,
  KIND_BATCH,
  KIND_EXCHANGES_ROOT,
  KIND_EXCHANGE_BATCH,
  KIND_SUMMARY_ROOT,
  type UnsummarizedBatch,
} from 'tim-store';
import {
  buildCompressPrompt,
  buildProjectSummaryPrompt,
  buildPrompt,
  buildSessionRollupPrompt,
  buildSubstanceVerdictPrompt,
  clampToWholeBullets,
  extractTags,
  parseSubstanceLine,
  PROJECT_SUMMARY_MAX_CHARS,
  tryCli,
  type SubstanceProjectContext,
} from './generate-summary.js';
import { collectProjectSummaryInput } from './summarize.js';

export interface Candidate {
  label: string;
  cli: string;
  model: string;
  provider?: string;
  args?: string[];
}

/** One fact the output must keep; any of the alternatives counts (case-insensitive). */
export type MustKeep = string[];

export type EvalCase =
  | { id: string; kind: 'batch'; batch: UnsummarizedBatch; mustKeep: MustKeep[] }
  | { id: string; kind: 'rollup'; batchSummaries: string[]; mustKeep: MustKeep[] }
  | { id: string; kind: 'project'; sessionSummaries: string[]; maxChars: number; mustKeep: MustKeep[] };

export interface SubstanceCase {
  sessionTitle: string;
  summaryText: string;
  expected: 'none' | 'real' | 'low';
}

export interface FixtureFile {
  extractedAt: string;
  cases: EvalCase[];
  substance: { projectContext: SubstanceProjectContext; sessions: SubstanceCase[] };
}

export interface CallResult {
  candidate: string;
  caseId: string;
  kind: EvalCase['kind'] | 'substance';
  trial: number;
  promptHash: string;
  ok: boolean;
  timedOut: boolean;
  error?: string;
  latencyMs: number;
  tokens: number | null;
  output: string;
  score?: Score;
  substanceMatch?: boolean;
}

export interface Score {
  /** Every contract check for this path passed. */
  contract: boolean;
  violations: string[];
  english: boolean;
  idRecall: number | null;
  hallucinatedIds: string[];
  mustKeep: number | null;
  missedFacts: string[];
}

const BENCH_DIR = path.join(getTimDir(), 'bench');
const FIXTURE_PATH = path.join(BENCH_DIR, 'summarizer-fixtures.json');
const CANDIDATES_PATH = path.join(BENCH_DIR, 'summarizer-candidates.json');
const ACTIVITY_TAGS = ['#design', '#implementation', '#debugging', '#review'];
// Containers and project names the batch prompt forbids, plus the activity
// respellings the closed list exists to stop (see buildPrompt).
const FORBIDDEN_TAGS = [
  '#tim', '#hermes', '#queue', '#tasks', '#tim-project',
  '#bugfix', '#bugfixing', '#bug-fixing', '#codefix', '#decision',
];
const ROLLUP_MAX_WORDS = 200;
const PROBE_TIMEOUT_SEC = 300;

// ── scoring (pure) ───────────────────────────────────────────────────────────

const ID_PATTERNS = [
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, // commit hashes
  /\b[PLEDT]\d{4}\b/g, // TIM labels
  /\bubun-\d{4}-ns-[0-9A-Z]{26}\b/g, // TIM node ids
  /(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b/g, // paths with a directory
  /\b[\w-]+\.(?:ts|js|mjs|json|md|sql|sh|py|toml|yaml|yml)\b/g, // bare file names
];

/** Identifiers a summary is expected to carry over verbatim. */
export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const re of ID_PATTERNS) for (const m of text.match(re) ?? []) out.add(m);
  return out;
}

const DE_WORDS = ['und', 'der', 'die', 'das', 'nicht', 'ist', 'mit', 'für', 'auf', 'ich', 'wir', 'wird', 'auch', 'noch', 'eine'];
const EN_WORDS = ['the', 'and', 'is', 'not', 'with', 'for', 'on', 'of', 'to', 'was', 'are', 'this', 'that', 'in', 'a'];

// ponytail: stopword count, not a language model — enough to catch a German answer.
export function isEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const de = words.filter(w => DE_WORDS.includes(w)).length;
  const en = words.filter(w => EN_WORDS.includes(w)).length;
  return !(de >= 3 && de > en);
}

function bullets(text: string): string[] {
  return text.split('\n').filter(l => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l));
}

function contractViolations(c: EvalCase, output: string, final: string): string[] {
  const v: string[] = [];
  if (c.kind === 'batch') {
    const { body, tags, substance } = extractTags(output);
    if (!substance) v.push('no SUBSTANCE line');
    if (body.length > BATCH_SUMMARY_MAX_CHARS) v.push(`body ${body.length} > ${BATCH_SUMMARY_MAX_CHARS} chars`);
    if (tags.length === 0) v.push('no TAGS');
    const activity = tags.filter(t => ACTIVITY_TAGS.includes(t));
    const forbidden = tags.filter(t => FORBIDDEN_TAGS.includes(t));
    const subjects = tags.filter(t => !ACTIVITY_TAGS.includes(t) && !FORBIDDEN_TAGS.includes(t));
    if (subjects.length < 1 || subjects.length > 3) v.push(`${subjects.length} subject tags`);
    if (activity.length > 1) v.push(`${activity.length} activity tags`);
    if (forbidden.length > 0) v.push(`forbidden tags ${forbidden.join(' ')}`);
  } else if (c.kind === 'rollup') {
    const n = bullets(output).length;
    if (n < 4 || n > 6) v.push(`${n} bullets`);
    const words = output.split(/\s+/).filter(Boolean).length;
    if (words > ROLLUP_MAX_WORDS) v.push(`${words} words`);
    const first = output.split('\n').find(l => l.trim());
    if (first && bullets(first).length === 0) v.push('preamble');
  } else {
    if (!final) v.push('empty after clamp');
    const n = bullets(final).length;
    if (n < 2 || n > 3) v.push(`${n} bullets`);
  }
  return v;
}

function caseInput(c: EvalCase): string {
  if (c.kind === 'batch') return JSON.stringify(c.batch.exchanges) + c.batch.previousSummaries.join('\n');
  if (c.kind === 'rollup') return c.batchSummaries.join('\n');
  return c.sessionSummaries.join('\n');
}

/** Score one output. `final` is what would be stored (project: after compress + clamp). */
export function scoreOutput(c: EvalCase, output: string, final = output): Score {
  const input = caseInput(c);
  const inputLower = input.toLowerCase();
  const inIds = identifiers(input);
  const outIds = identifiers(final);
  const kept = [...outIds].filter(id => inIds.has(id)).length;
  const hallucinatedIds = [...outIds].filter(id => !inputLower.includes(id.toLowerCase()));
  const finalLower = final.toLowerCase();
  const missedFacts = c.mustKeep
    .filter(alts => !alts.some(a => finalLower.includes(a.toLowerCase())))
    .map(alts => alts[0]!);
  const violations = contractViolations(c, output, final);
  return {
    contract: violations.length === 0,
    violations,
    english: isEnglish(final),
    idRecall: inIds.size ? kept / inIds.size : null,
    hallucinatedIds,
    mustKeep: c.mustKeep.length ? (c.mustKeep.length - missedFacts.length) / c.mustKeep.length : null,
    missedFacts,
  };
}

export function parseTokens(stdout: string): number | null {
  const m = stdout.match(/tokens used\s*\n\s*([\d,]+)/i);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface Aggregate {
  candidate: string;
  calls: number;
  reliability: number;
  timeouts: number;
  latencyMedianS: number | null;
  latencyP90S: number | null;
  tokensMedian: number | null;
  contract: number | null;
  english: number | null;
  idRecall: number | null;
  hallucinated: number;
  mustKeep: number | null;
  substanceAccuracy: number | null;
}

export function aggregate(results: CallResult[]): Aggregate[] {
  const byCand = new Map<string, CallResult[]>();
  for (const r of results) byCand.set(r.candidate, [...(byCand.get(r.candidate) ?? []), r]);
  return [...byCand].map(([candidate, rs]) => {
    const ok = rs.filter(r => r.ok);
    const scored = ok.map(r => r.score).filter((s): s is Score => Boolean(s));
    const sub = rs.filter(r => r.kind === 'substance');
    const lat = ok.map(r => r.latencyMs / 1000);
    const tok = ok.map(r => r.tokens).filter((t): t is number => t !== null);
    return {
      candidate,
      calls: rs.length,
      reliability: ok.length / rs.length,
      timeouts: rs.filter(r => r.timedOut).length,
      latencyMedianS: quantile(lat, 0.5),
      latencyP90S: quantile(lat, 0.9),
      tokensMedian: quantile(tok, 0.5),
      contract: mean(scored.map(s => (s.contract ? 1 : 0))),
      english: mean(scored.map(s => (s.english ? 1 : 0))),
      idRecall: mean(scored.map(s => s.idRecall).filter((x): x is number => x !== null)),
      hallucinated: scored.reduce((n, s) => n + s.hallucinatedIds.length, 0),
      mustKeep: mean(scored.map(s => s.mustKeep).filter((x): x is number => x !== null)),
      substanceAccuracy: sub.length ? sub.filter(r => r.substanceMatch).length / sub.length : null,
    };
  });
}

/**
 * The decision rule, fixed before any run: among candidates with 100 % reliability
 * and 100 % contract compliance whose must-keep score is at most 5 points below the
 * best, the cheapest (median tokens) wins, then the fastest (median latency).
 */
export function pickWinner(aggs: Aggregate[]): Aggregate | null {
  const best = Math.max(...aggs.map(a => a.mustKeep ?? 0));
  const eligible = aggs.filter(
    a => a.reliability === 1 && a.contract === 1 && (a.mustKeep ?? 0) >= best - 0.05,
  );
  eligible.sort(
    (a, b) =>
      (a.tokensMedian ?? 0) - (b.tokensMedian ?? 0) ||
      (a.latencyMedianS ?? Infinity) - (b.latencyMedianS ?? Infinity),
  );
  return eligible[0] ?? null;
}

// ── run ──────────────────────────────────────────────────────────────────────

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

async function call(
  cand: Candidate,
  prompt: string,
): Promise<{ text: string | null; tokens: number | null; ms: number; error?: string; timedOut: boolean }> {
  let tokens: number | null = null;
  let error: string | undefined;
  const t0 = Date.now();
  const text = await tryCli(
    cand.cli, cand.model, cand.provider, prompt, PROBE_TIMEOUT_SEC,
    (_label, detail) => { error = detail; },
    cand.args ?? [],
    (stdout, stderr) => { tokens = parseTokens(`${stdout}\n${stderr}`); },
  );
  return { text, tokens, ms: Date.now() - t0, error, timedOut: /timeout=/.test(error ?? '') };
}

async function runCase(cand: Candidate, c: EvalCase, trial: number): Promise<CallResult> {
  const prompt =
    c.kind === 'batch' ? buildPrompt(c.batch)
    : c.kind === 'rollup' ? buildSessionRollupPrompt(c.batchSummaries)
    : buildProjectSummaryPrompt(c.sessionSummaries, c.maxChars);
  const r = await call(cand, prompt);
  const base = { candidate: cand.label, caseId: c.id, kind: c.kind, trial, promptHash: sha(prompt) };
  if (!r.text) {
    return { ...base, ok: false, timedOut: r.timedOut, error: r.error, latencyMs: r.ms, tokens: r.tokens, output: '' };
  }
  let latencyMs = r.ms;
  let tokens = r.tokens;
  let final = r.text;
  if (c.kind === 'project') {
    // Same steps as generateProjectSummary: one compress pass on overshoot, then clamp.
    final = r.text.trim();
    if (final.length > c.maxChars) {
      const again = await call(cand, buildCompressPrompt(final, c.maxChars));
      latencyMs += again.ms;
      if (tokens !== null && again.tokens !== null) tokens += again.tokens;
      final = again.text?.trim() ?? final;
    }
    final = clampToWholeBullets(final, c.maxChars);
  }
  return { ...base, ok: true, timedOut: false, latencyMs, tokens, output: r.text, score: scoreOutput(c, r.text, final) };
}

async function runSubstance(cand: Candidate, fx: FixtureFile['substance']): Promise<CallResult[]> {
  const out: CallResult[] = [];
  for (const s of fx.sessions) {
    const prompt = buildSubstanceVerdictPrompt(s.summaryText, fx.projectContext);
    const r = await call(cand, prompt);
    let got: string | undefined;
    if (r.text) {
      got = extractTags(r.text).substance;
      const line = r.text.split('\n').find(l => /^SUBSTANCE:/i.test(l.trim().replace(/[*_]/g, '')));
      if (!got && line) got = parseSubstanceLine(line);
    }
    out.push({
      candidate: cand.label, caseId: s.sessionTitle, kind: 'substance', trial: 1, promptHash: sha(prompt),
      ok: Boolean(got), timedOut: r.timedOut, error: r.error ?? (r.text && !got ? 'no verdict' : undefined),
      latencyMs: r.ms, tokens: r.tokens, output: r.text ?? '',
      substanceMatch: (got === 'none') === (s.expected === 'none'),
    });
  }
  return out;
}

function loadCandidates(file: string): Candidate[] {
  const listed: Candidate[] = JSON.parse(fs.readFileSync(file, 'utf-8'));
  // The production head always runs as the control row: free-tier and quota
  // latency drift between days, so only gaps inside one run compare.
  const head = loadConfig().summarizer?.chain?.[0];
  if (!head) return listed;
  const same = (c: Candidate) =>
    c.cli === head.cli && c.model === head.model && (c.provider ?? '') === (head.provider ?? '') &&
    JSON.stringify(c.args ?? []) === JSON.stringify(head.args ?? []);
  const found = listed.find(same);
  if (found) {
    found.label = `${found.label} (control)`;
    return listed;
  }
  return [{ label: `control:${head.cli}/${head.model}`, ...head }, ...listed];
}

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)} %`);
const num = (x: number | null, d = 1) => (x === null ? '–' : x.toFixed(d));

export function renderReport(aggs: Aggregate[], meta: Record<string, string>): string {
  const winner = pickWinner(aggs);
  const rows = aggs.map(a =>
    `| ${a.candidate} | ${pct(a.reliability)} (${a.timeouts} TO) | ${num(a.latencyMedianS)} / ${num(a.latencyP90S)} | ` +
    `${a.tokensMedian ?? '–'} | ${pct(a.contract)} | ${pct(a.english)} | ${pct(a.idRecall)} | ${a.hallucinated} | ` +
    `${pct(a.mustKeep)} | ${pct(a.substanceAccuracy)} |`);
  return [
    `# Summarizer eval ${meta.startedAt}`,
    '',
    Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
    '',
    '| Candidate | Reliability | Latency med / p90 s | Tokens med | Contract | English | ID recall | Invented IDs | Must-keep | Substance |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Winner by the fixed rule: ${winner ? `**${winner.candidate}**` : 'none — no candidate met reliability + contract 100 %'}`,
  ].join('\n');
}

async function run(argv: string[]): Promise<void> {
  const trials = Number(flag(argv, '--trials') ?? 3);
  const candidates = loadCandidates(flag(argv, '--candidates') ?? CANDIDATES_PATH);
  const fx: FixtureFile = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  const startedAt = new Date().toISOString();
  const outDir = path.join(BENCH_DIR, 'runs', startedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  // A stable cwd: codex reads AGENTS.md from the working tree, which would make
  // the prompt depend on where the eval was started.
  process.chdir(os.homedir());

  // Candidates run side by side (same load window), cases sequentially within one.
  const perCand = await Promise.all(candidates.map(async cand => {
    const rs: CallResult[] = [];
    for (let t = 1; t <= trials; t++) {
      for (const c of fx.cases) {
        const r = await runCase(cand, c, t);
        rs.push(r);
        console.error(`${cand.label} t${t} ${c.id}: ${r.ok ? `${(r.latencyMs / 1000).toFixed(1)}s` : `FAIL ${r.error?.slice(0, 120)}`}`);
      }
    }
    rs.push(...await runSubstance(cand, fx.substance));
    return rs;
  }));
  const results = perCand.flat();
  const aggs = aggregate(results);
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch { /* not a checkout */ }
  const meta = {
    startedAt,
    commit,
    fixtures: `${FIXTURE_PATH} (extracted ${fx.extractedAt}, ${fx.cases.length} cases + ${fx.substance.sessions.length} substance)`,
    trials: String(trials),
    promptHashes: sha(results.map(r => r.promptHash).sort().join()),
  };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ meta, candidates, aggregates: aggs, results }, null, 2));
  const report = renderReport(aggs, meta);
  fs.writeFileSync(path.join(outDir, 'report.md'), report + '\n');
  console.log(report);
  console.log(`\nresults: ${outDir}`);
}

// ── extract ──────────────────────────────────────────────────────────────────

async function extract(argv: string[]): Promise<void> {
  if (fs.existsSync(FIXTURE_PATH) && !argv.includes('--force')) {
    throw new Error(`${FIXTURE_PATH} exists — fixtures are frozen; pass --force to re-extract (labels are lost)`);
  }
  const projects = (flag(argv, '--projects') ?? 'P0063,P0054').split(',');
  const store = new TimStore(loadConfig().dbPath);
  const sessions = new SessionManager(store);
  const cases: EvalCase[] = [];
  try {
    // Sessions with batch summaries, newest first, across the chosen projects.
    const withBatches: Array<{ id: string; project: string; batches: string[] }> = [];
    for (const label of projects) {
      const project = await store.requireProject(label);
      for (const { id } of store.listProjectSessionsByActivity(project.id, 200)) {
        const summaryNode = await findChildByKind(store, id, KIND_SUMMARY_ROOT);
        if (!summaryNode) continue;
        const batches = (await store.getChildByKind(summaryNode.id, KIND_BATCH))
          .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index))
          .map(b => (b.content || '').trim())
          .filter(t => t && !t.startsWith('Session judged trivial'));
        if (batches.length) withBatches.push({ id, project: label, batches });
      }
      const picked = await collectProjectSummaryInput(store, project.id);
      if (picked.length) {
        cases.push({
          id: `project/${label}`, kind: 'project', mustKeep: [],
          sessionSummaries: picked.flatMap(p => p.summaries),
          // runProjectSummary reserves room for its coverage line.
          maxChars: PROJECT_SUMMARY_MAX_CHARS - 60,
        });
      }
    }

    // Rollups: one short, one medium, one long session.
    for (const [lo, hi] of [[1, 1], [2, 4], [5, 99]] as const) {
      const s = withBatches.find(w => w.batches.length >= lo && w.batches.length <= hi);
      if (s) cases.push({ id: `rollup/${s.id.slice(0, 8)}`, kind: 'rollup', batchSummaries: s.batches, mustKeep: [] });
    }

    // Batches: small, medium and large input, rebuilt the way showUnsummarized builds them.
    const sizes: Array<[number, number]> = [[0, 3000], [3000, 8000], [8000, 30000]];
    for (const [lo, hi] of sizes) {
      let found: EvalCase | null = null;
      for (const s of withBatches) {
        if (found) break;
        const exNode = await findChildByKind(store, s.id, KIND_EXCHANGES_ROOT);
        const session = await store.read(s.id);
        if (!exNode || !session) continue;
        const exBatches = (await store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH))
          .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index));
        for (const b of exBatches) {
          const idx = Number(b.metadata.batch_index);
          const exchanges = await sessions.batchExchanges(b.id);
          const size = JSON.stringify(exchanges).length;
          if (exchanges.length < 2 || size < lo || size >= hi) continue;
          const meta = session.metadata;
          const vocabulary = (await store.projectTagVocabulary(s.project).catch(() => []))
            .filter(t => t.count >= 2).map(t => t.tag);
          found = {
            id: `batch/${s.id.slice(0, 8)}-${idx}`, kind: 'batch', mustKeep: [],
            batch: {
              sessionId: s.id, summaryNodeId: '', exchangesNodeId: exNode.id,
              batchIndex: idx, batchSize: exchanges.length, exchanges, hasMore: false,
              previousSummaries: s.batches.slice(0, Math.max(0, idx - 1)),
              sessionMeta: {
                project: typeof meta.project_ref === 'string' ? meta.project_ref : undefined,
                tool: typeof meta.tool === 'string' ? meta.tool : undefined,
                model: typeof meta.model === 'string' ? meta.model : undefined,
              },
              ...(vocabulary.length ? { vocabulary } : {}),
            },
          };
          break;
        }
      }
      if (found) cases.push(found);
    }
  } finally {
    store.close();
  }

  const substance = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../src/__tests__/fixtures/substance-labels.json'), 'utf-8'));
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const fx: FixtureFile = { extractedAt: new Date().toISOString(), cases, substance };
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fx, null, 2));
  console.log(`${cases.length} cases → ${FIXTURE_PATH}. Label mustKeep per case before the first run.`);
  for (const c of cases) console.log(`  ${c.id}`);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const isMain =
  process.argv[1]?.endsWith('eval-summarizer.js') || process.argv[1]?.endsWith('eval-summarizer.ts');
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  (cmd === 'extract' ? extract(rest) : cmd === 'run' ? run(rest) : Promise.reject(new Error('usage: eval-summarizer extract|run')))
    .catch(err => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
