import type { Entry } from 'tim-core';
import type { HooksConfig } from 'tim-core';
import { getTimDir } from 'tim-core';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager, type Summarizer, type TimStore } from 'tim-store';
import { runConfiguredHooks, type HookEnv } from './hooks.js';

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
  },
): Promise<SessionStartResult> {
  const sessions = new SessionManager(store);
  const session = await sessions.sessionStart({
    sessionId: params.sessionId,
    agentName: params.agentName,
    cwd: params.cwd,
    harness: params.harness,
  });

  await runConfiguredHooks('sessionStart', params.hooksConfig, {
    TIM_SESSION_ID: params.sessionId,
    TIM_CWD: params.cwd,
    TIM_AGENT: params.agentName,
    TIM_HARNESS: params.harness,
  });

  const project = await loadProjectContext(store);

  return { session, project };
}

export async function runSessionEnd(
  store: TimStore,
  sessionId: string,
  opts: SessionEndOptions = {},
): Promise<Entry> {
  const env: HookEnv = {
    TIM_SESSION_ID: sessionId,
    ...opts.env,
  };

  await runConfiguredHooks('sessionEnd', opts.hooksConfig, env);

  return runCheckpoint(store, sessionId, {
    summarize: opts.summarize,
  });
}
