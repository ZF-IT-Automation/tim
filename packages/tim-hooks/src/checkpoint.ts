import type { Entry } from 'tim-core';
import type { HooksConfig } from 'tim-core';
import { getTimDir, loadConfig } from 'tim-core';
import {
  getCheckpointEveryN,
  shouldAutoCheckpoint,
  checkpointCadenceReminder,
} from './cadence.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  SessionManager,
  ensureInboxProject,
  ensureProjectForPath,
  INBOX_PROJECT_LABEL,
  type Summarizer,
  type TimStore,
} from 'tim-store';
import { runConfiguredHooks, type HookEnv } from './hooks.js';
import { getDeltaBriefing } from './delta.js';
import { getUpdateCheckLineBriefing } from './update-check.js';
import { readMarker, writeMarker, validateMarkerAgainstStore } from './marker.js';
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
  /** Optional briefing supplement (delta, update check, …). */
  briefing?: string;
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

/**
 * Resolve the active project from a .tim-project marker in cwd ONLY.
 *
 * No walk-up. No parent traversal. This is the Auto-Load Hook contract:
 * a session binds to a project only if the marker is in the directory the
 * user explicitly invoked the harness from. Walking up to a parent has
 * caused repeated cross-project binding bugs (Worker A→B→C in 2 days);
 * cwd-only is the same pattern Hermes statusline uses after the 133c5abd
 * fix in its-over-9k, kept consistent here.
 *
 * Falls back to:
 *  - readMarker(cwd) which checks .tim-project and then tim.json
 *  - validateMarkerAgainstStore which gates the project label against the DB
 *
 * Returns the project label, or null when no cwd marker exists, the marker
 * is corrupt, or the project does not exist in the DB.
 */
export async function resolveActiveProjectFromCwd(
  cwd: string,
  store: TimStore,
): Promise<string | null> {
  const marker = readMarker(cwd);
  if (!marker) return null;
  const validated = await validateMarkerAgainstStore(marker, store);
  return validated?.project ?? null;
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
  if (explicitProjectId) {
    // Validate explicit project ids against the DB so a hand-edited
    // `--project=P9999` (or a botched upstream commit) can't smuggle
    // a bogus label into the marker. The Inbox (P0000) is exempt —
    // it's a system project that tim-store.ensureInboxProject()
    // materializes on first use. This closes the second half of the
    // P9999 bug: even if the on-disk marker was repaired, an
    // explicit override could re-poison the file.
    if (explicitProjectId !== 'P0000') {
      const resolved = await store.resolveProjectLabel(explicitProjectId);
      if (resolved.status === 'found') return resolved.label;
      if (resolved.status === 'not_found') {
        throw new Error(
          `Project not found: ${explicitProjectId}. Use tim_load_project to pick a real project.`,
        );
      }
      throw new Error(
        `Ambiguous project label: ${explicitProjectId} matches ${resolved.labels.join(', ')}.`,
      );
    }
    return explicitProjectId;
  }
  const cwdLabel = await resolveActiveProjectFromCwd(cwd, store);
  if (cwdLabel) return cwdLabel;

  const active = getActiveProjectLabel();
  if (active) {
    const validated = await validateMarkerAgainstStore(
      {
        version: 2,
        project: active,
        session: '',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      },
      store,
    );
    if (validated) return validated.project;
  }

  const auto = await ensureProjectForPath(store, cwd);
  if (auto) return auto.label;

  await ensureInboxProject(store);
  return INBOX_PROJECT_LABEL;
}

export async function runCheckpoint(
  store: TimStore,
  sessionId: string,
  opts: { summarize?: Summarizer; runDecay?: boolean; handoffNote?: string } = {},
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
    version: 2,
  });

  await runConfiguredHooks('sessionStart', params.hooksConfig, {
    TIM_SESSION_ID: params.sessionId,
    TIM_CWD: params.cwd,
    TIM_AGENT: params.agentName,
    TIM_HARNESS: params.harness,
    TIM_PROJECT: projectId,
  });

  const project = await store.read(projectId);

  let briefing: string | undefined;
  const briefingParts: string[] = [];
  if (projectId !== INBOX_PROJECT_LABEL) {
    const delta = await getDeltaBriefing(store, projectId, {
      sessionId: params.sessionId,
    });
    if (delta) briefingParts.push(delta);
  }
  const updateLine = await getUpdateCheckLineBriefing();
  if (updateLine) briefingParts.push(updateLine);

  const marker = readMarker(params.cwd);
  if (marker && marker.exchanges > 0) {
    const everyN = getCheckpointEveryN(loadConfig());
    const reminder = checkpointCadenceReminder(marker.exchanges, everyN);
    if (reminder) briefingParts.push(reminder);
  }

  if (briefingParts.length > 0) briefing = briefingParts.join('\n');

  return { session, project, briefing };
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
    const cwdLabel = await resolveActiveProjectFromCwd(cwd, store);
    const label = cwdLabel ?? getActiveProjectLabel();
    await maybeSpawnProjectSummary(store, cwd, label, { threshold });
  } catch {
    /* non-critical */
  }

  return runCheckpoint(store, sessionId, {
    summarize: opts.summarize,
  });
}
