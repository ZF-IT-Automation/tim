import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from 'tim-core';
import {
  TimStore,
  deriveCounters,
  resolveCurrentSession,
  resolveProjectDisplayName,
  DEFAULT_BATCH_SIZE,
} from 'tim-store';
import type { FindMarkerOptions } from 'tim-hooks';
import {
  findMarker,
  findMarkerOptionsFromEnv,
  validateMarkerAgainstStore,
  formatUnboundProjectLabel,
  stripUnboundProjectSuffix,
  isUnboundProjectLabel,
} from 'tim-hooks';

const COUNTERS_TTL_MS = 5_000;
const countersCache = new Map<
  string,
  { at: number; exchanges: number; batchesSummarized: number; batchSize: number }
>();

export interface StatuslineCounters {
  project: string;
  exchanges: number;
  batchSize: number;
  batchesSummarized: number;
}

function dbPath(): string {
  const config = loadConfig();
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

/** DB-authoritative exchange counters (5s in-process cache keyed by session id). */
export async function resolveStatuslineCounters(
  store: TimStore,
  project: string,
  cwd: string,
  sessionIdArg?: string,
): Promise<StatuslineCounters> {
  const noSession: StatuslineCounters = {
    project,
    exchanges: 0,
    batchSize: DEFAULT_BATCH_SIZE,
    batchesSummarized: 0,
  };

  let sessionId = sessionIdArg?.trim();
  if (!sessionId) {
    const sessionEntry = await resolveCurrentSession(store, project, cwd);
    if (!sessionEntry) return noSession;
    sessionId = sessionEntry.id;
  }

  const sessionEntry = await store.read(sessionId);
  if (!sessionEntry || sessionEntry.metadata.kind !== 'session') return noSession;

  const batchSize =
    typeof sessionEntry.metadata.batch_size === 'number'
      ? sessionEntry.metadata.batch_size
      : DEFAULT_BATCH_SIZE;

  const now = Date.now();
  const hit = countersCache.get(sessionId);
  if (hit && now - hit.at < COUNTERS_TTL_MS) {
    return {
      project,
      exchanges: hit.exchanges,
      batchSize: hit.batchSize,
      batchesSummarized: hit.batchesSummarized,
    };
  }

  const { exchangeCount, batchesSummarized } = await deriveCounters(store, sessionId);
  countersCache.set(sessionId, {
    at: now,
    exchanges: exchangeCount,
    batchesSummarized,
    batchSize,
  });
  return {
    project,
    exchanges: exchangeCount,
    batchSize,
    batchesSummarized,
  };
}

export interface StatusLineInput {
  cwd?: string;
  workspace?: { current_dir?: string };
}

export function resolveStatuslineCwd(input: StatusLineInput, fallback = process.cwd()): string {
  const fromWorkspace = input.workspace?.current_dir?.trim();
  if (fromWorkspace) return fromWorkspace;
  const fromCwd = input.cwd?.trim();
  if (fromCwd) return fromCwd;
  return fallback;
}

/** User exchanges in current batch (1..batch_size at boundary). */
export function exchangesInCurrentBatch(exchanges: number, batchSize: number): number {
  const bs = Math.max(1, batchSize);
  const mod = ((exchanges % bs) + bs) % bs;
  return mod === 0 && exchanges > 0 ? bs : mod;
}

/** Exchanges until next batch summary trigger. */
export function summaryIn(exchanges: number, batchSize: number): number {
  const bs = Math.max(1, batchSize);
  const mod = ((exchanges % bs) + bs) % bs;
  if (mod === 0) return exchanges === 0 ? bs : 0;
  return bs - mod;
}

export function formatTimStatusLine(counters: StatuslineCounters, projectName?: string): string {
  const batchSize = counters.batchSize > 0 ? counters.batchSize : DEFAULT_BATCH_SIZE;
  const exchanges = Math.max(0, counters.exchanges);
  const inBatch = exchangesInCurrentBatch(exchanges, batchSize);
  const k = summaryIn(exchanges, batchSize);
  const name = projectName?.trim() || counters.project;
  return `${name} · ${inBatch}/${batchSize} exchanges · summary in ${k}`;
}

export function formatNoProjectStatusLine(): string {
  return 'no project';
}

/** JSON for Hermes CLI status bar (see packages/tim-hooks/scripts/hermes-cli-tim-statusline.patch). */
export interface HermesStatusJson {
  device: string;
  project: string;
  o_node: string;
  counter: string;
}

export function formatHermesStatus(
  counters: StatuslineCounters | null,
  projectName?: string,
): HermesStatusJson {
  if (!counters) {
    return { device: '', project: 'no project', o_node: '', counter: '' };
  }
  const batchSize = counters.batchSize > 0 ? counters.batchSize : DEFAULT_BATCH_SIZE;
  const inBatch = exchangesInCurrentBatch(counters.exchanges, batchSize);
  const k = summaryIn(counters.exchanges, batchSize);
  return {
    device: '',
    project: projectName?.trim() || counters.project,
    o_node: '',
    counter: `${inBatch}/${batchSize} · Σ${k}`,
  };
}

async function projectNameForStatusline(
  store: TimStore,
  counters: StatuslineCounters,
): Promise<string> {
  if (isUnboundProjectLabel(counters.project)) {
    return formatUnboundProjectLabel(stripUnboundProjectSuffix(counters.project));
  }
  return resolveProjectDisplayName(store, counters.project);
}

async function resolveStatuslineData(
  cwd: string,
  sessionIdArg: string | undefined,
  options: FindMarkerOptions | undefined,
  store: TimStore,
): Promise<StatuslineCounters | null> {
  const located = findMarker(cwd, { walkUp: true, ...options });
  if (!located) return null;

  const validated = await validateMarkerAgainstStore(located.marker, store);
  const project = validated?.project ?? formatUnboundProjectLabel(located.marker.project);
  if (!validated) {
    return {
      project,
      exchanges: 0,
      batchSize: DEFAULT_BATCH_SIZE,
      batchesSummarized: 0,
    };
  }
  const counters = await resolveStatuslineCounters(store, validated.project, located.dir, sessionIdArg);
  return { ...counters, project };
}

export async function statuslineFromCwd(
  cwd: string,
  options?: FindMarkerOptions,
  sessionIdArg?: string,
): Promise<string> {
  const store = new TimStore(dbPath());
  try {
    const counters = await resolveStatuslineData(cwd, sessionIdArg, options, store);
    if (!counters) return formatNoProjectStatusLine();
    const name = await projectNameForStatusline(store, counters);
    return formatTimStatusLine(counters, name);
  } finally {
    store.close();
  }
}

export async function hermesStatusFromCwd(
  cwd: string,
  options?: FindMarkerOptions,
  sessionIdArg?: string,
): Promise<HermesStatusJson> {
  const store = new TimStore(dbPath());
  try {
    const counters = await resolveStatuslineData(cwd, sessionIdArg, options, store);
    if (!counters) return formatHermesStatus(null);
    const name = await projectNameForStatusline(store, counters);
    return formatHermesStatus(counters, name);
  } finally {
    store.close();
  }
}

/** Sync stdin read — reliable when Claude pipes JSON (async iterator can miss short pipes). */
export function readStatuslineInputSync(): StatusLineInput {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as StatusLineInput;
  } catch {
    return {};
  }
}

export interface StatuslineCliOptions {
  cwd?: string;
  sessionId?: string;
  format?: 'text' | 'hermes';
}

export async function runStatusline(opts: StatuslineCliOptions = {}): Promise<void> {
  const input = readStatuslineInputSync();
  const cwd = opts.cwd?.trim() || resolveStatuslineCwd(input);
  const findOpts = { walkUp: true, ...findMarkerOptionsFromEnv() };
  const store = new TimStore(dbPath());
  try {
    const counters = await resolveStatuslineData(cwd, opts.sessionId?.trim(), findOpts, store);
    const projectName = counters ? await projectNameForStatusline(store, counters) : undefined;

    const format = opts.format ?? 'text';
    if (format === 'hermes') {
      process.stdout.write(`${JSON.stringify(formatHermesStatus(counters, projectName))}\n`);
      return;
    }
    const line = counters
      ? formatTimStatusLine(counters, projectName)
      : formatNoProjectStatusLine();
    process.stdout.write(`${line}\n`);
  } finally {
    store.close();
  }
}
