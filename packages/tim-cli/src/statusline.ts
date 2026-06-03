import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from 'tim-core';
import { TimStore, deriveCounters, resolveProjectDisplayName } from 'tim-store';
import type { FindMarkerOptions, ProjectMarker } from 'tim-hooks';
import { findMarker, findMarkerOptionsFromEnv } from 'tim-hooks';

const RECONCILE_TTL_MS = 5_000;
const reconcileCache = new Map<
  string,
  { at: number; exchanges: number; batches_summarized: number }
>();

function dbPath(): string {
  const config = loadConfig();
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

/** DB-authoritative exchange counters (5s in-process cache). */
export async function reconcileMarkerCounters(
  store: TimStore,
  marker: ProjectMarker,
): Promise<ProjectMarker> {
  const sid = marker.session?.trim();
  if (!sid) return marker;

  const entry = await store.read(sid);
  if (!entry || entry.metadata.kind !== 'session') return marker;

  const now = Date.now();
  const hit = reconcileCache.get(sid);
  if (hit && now - hit.at < RECONCILE_TTL_MS) {
    return {
      ...marker,
      exchanges: hit.exchanges,
      batches_summarized: hit.batches_summarized,
    };
  }

  const { exchangeCount, batchesSummarized } = await deriveCounters(store, sid);
  reconcileCache.set(sid, {
    at: now,
    exchanges: exchangeCount,
    batches_summarized: batchesSummarized,
  });
  return {
    ...marker,
    exchanges: exchangeCount,
    batches_summarized: batchesSummarized,
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

export function formatTimStatusLine(marker: ProjectMarker, projectName?: string): string {
  const batchSize = marker.batch_size > 0 ? marker.batch_size : 5;
  const exchanges = Math.max(0, marker.exchanges);
  const inBatch = exchangesInCurrentBatch(exchanges, batchSize);
  const k = summaryIn(exchanges, batchSize);
  const name = projectName?.trim() || marker.project;
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
  marker: ProjectMarker | null,
  projectName?: string,
): HermesStatusJson {
  if (!marker) {
    return { device: '', project: 'no project', o_node: '', counter: '' };
  }
  const batchSize = marker.batch_size > 0 ? marker.batch_size : 5;
  const inBatch = exchangesInCurrentBatch(marker.exchanges, batchSize);
  const k = summaryIn(marker.exchanges, batchSize);
  return {
    device: '',
    project: projectName?.trim() || marker.project,
    o_node: '',
    counter: `${inBatch}/${batchSize} · Σ${k}`,
  };
}

async function resolveStatuslineMarker(
  cwd: string,
  _sessionIdArg: string | undefined,
  options: FindMarkerOptions | undefined,
  store: TimStore,
): Promise<ProjectMarker | null> {
  const located = findMarker(cwd, options);
  if (!located) return null;
  // Project label comes from .tim-project only; DB may refresh exchange counters.
  return reconcileMarkerCounters(store, located.marker);
}

export async function statuslineFromCwd(
  cwd: string,
  options?: FindMarkerOptions,
  sessionIdArg?: string,
): Promise<string> {
  const store = new TimStore(dbPath());
  try {
    const marker = await resolveStatuslineMarker(cwd, sessionIdArg, options, store);
    if (!marker) return formatNoProjectStatusLine();
    const name = await resolveProjectDisplayName(store, marker.project);
    return formatTimStatusLine(marker, name);
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
    const marker = await resolveStatuslineMarker(cwd, sessionIdArg, options, store);
    if (!marker) return formatHermesStatus(null);
    const name = await resolveProjectDisplayName(store, marker.project);
    return formatHermesStatus(marker, name);
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
  const findOpts = findMarkerOptionsFromEnv();
  const store = new TimStore(dbPath());
  try {
    const marker = await resolveStatuslineMarker(cwd, opts.sessionId?.trim(), findOpts, store);
    const projectName = marker
      ? await resolveProjectDisplayName(store, marker.project)
      : undefined;

    const format = opts.format ?? 'text';
    if (format === 'hermes') {
      process.stdout.write(`${JSON.stringify(formatHermesStatus(marker, projectName))}\n`);
      return;
    }
    const line = marker
      ? formatTimStatusLine(marker, projectName)
      : formatNoProjectStatusLine();
    process.stdout.write(`${line}\n`);
  } finally {
    store.close();
  }
}
