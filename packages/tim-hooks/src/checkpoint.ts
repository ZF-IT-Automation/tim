import type { Entry } from 'tim-core';
import type { HooksConfig } from 'tim-core';
import { getTimDir, loadConfig } from 'tim-core';
import * as fs from 'fs';
import * as path from 'path';
import {
  SessionManager,
  ensureInboxProject,
  INBOX_PROJECT_LABEL,
  type Summarizer,
  type TimStore,
} from 'tim-store';
import { runConfiguredHooks, type HookEnv } from './hooks.js';
import { findMarker, writeMarker } from './marker.js';
import {
  onSessionStop,
  maybeSpawnProjectSummary,
  DEFAULT_PROJECT_SUMMARY_THRESHOLD,
} from './session-hooks.js';

export interface SessionEndOptions {
  summarize?: Summarizer;
  hooksConfig?: HooksConfig;
  env?: HookEnv;
}

export interface SessionStartResult {
  session: Entry;
  project: Entry | null;
}

/** Resolve active project label from TIM_PROJECT env or ~/.tim/active-project. */
export function getActiveProjectLabel(): string | null {
  const fromEnv = process.env.TIM_PROJECT?.trim();
  if (fromEnv) return fromEnv;

  const activeFile = path.join(getTimDir(), 'active-project');
  if (!fs.existsSync(activeFile)) return null;

  const label = fs.readFileSync(activeFile, 'utf8').trim();
  return label || null;
}

/** Load project entry by hmem-style label (e.g. P0062) when configured. */
export async function loadProjectContext(store: TimStore): Promise<Entry | null> {
  const label = getActiveProjectLabel();
  if (!label) return null;
  return store.read(label);
}

async function resolveSessionProjectId(
  store: TimStore,
  cwd: string,
  explicitProjectId?: string,
): Promise<string> {
  if (explicitProjectId) return explicitProjectId;
  const located = findMarker(cwd);
  if (located) return located.marker.project;
  const active = getActiveProjectLabel();
  if (active) return active;
  await ensureInboxProject(store);
  return INBOX_PROJECT_LABEL;
}

export async function runCheckpoint(
  store: TimStore,
  sessionId: string,
  opts: { summarize?: Summarizer; runDecay?: boolean } = {},
): Promise<Entry> {
  const sessions = new SessionManager(store);
  return sessions.checkpoint(sessionId, opts);
}

export async function runSessionStart(
  store: TimStore,
  params: {
    sessionId: string;
    agentName: string;
    cwd: string;
    harness: string;
    hooksConfig?: HooksConfig;
    projectId?: string;
    batchSize?: number;
    tool?: string;
    model?: string;
    taskSummary?: string;
  },
): Promise<SessionStartResult> {
  const sessions = new SessionManager(store);
  const projectId = await resolveSessionProjectId(store, params.cwd, params.projectId);

  const session = await sessions.startProjectSession({
    sessionId: params.sessionId,
    projectId,
    agentName: params.agentName,
    cwd: params.cwd,
    harness: params.harness,
    batchSize: params.batchSize,
  });

  writeMarker(params.cwd, {
    project: projectId,
    session: params.sessionId,
    exchanges: 0,
    batch_size: typeof session.metadata.batch_size === 'number'
      ? session.metadata.batch_size
      : 5,
    batches_summarized: 0,
  });

  await runConfiguredHooks('sessionStart', params.hooksConfig, {
    TIM_SESSION_ID: params.sessionId,
    TIM_CWD: params.cwd,
    TIM_AGENT: params.agentName,
    TIM_HARNESS: params.harness,
    TIM_PROJECT: projectId,
  });

  const project = await store.read(projectId);

  return { session, project };
}

export async function runSessionEnd(
  store: TimStore,
  sessionId: string,
  opts: SessionEndOptions = {},
): Promise<Entry> {
  const cwd = opts.env?.TIM_CWD ?? process.cwd();
  const env: HookEnv = {
    TIM_SESSION_ID: sessionId,
    TIM_CWD: cwd,
    ...opts.env,
  };

  await runConfiguredHooks('sessionEnd', opts.hooksConfig, env);

  await onSessionStop(store, cwd);

  // Periodically regenerate the project-level summary (every Nth session).
  // Fire-and-forget — must never block or fail the session-end hook.
  try {
    const config = loadConfig();
    const threshold = config.projectSummary?.sessions_threshold ?? DEFAULT_PROJECT_SUMMARY_THRESHOLD;
    const located = findMarker(cwd);
    const label = located?.marker.project ?? getActiveProjectLabel();
    await maybeSpawnProjectSummary(store, cwd, label, { threshold });
  } catch {
    /* non-critical */
  }

  return runCheckpoint(store, sessionId, {
    summarize: opts.summarize,
  });
}
