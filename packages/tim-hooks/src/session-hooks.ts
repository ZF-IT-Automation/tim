import { spawn as nodeSpawn } from 'child_process';
import * as path from 'path';
import type { TimStore } from 'tim-store';
import {
  detectProject,
  reconcileMarker,
  acquireLock,
  MARKER_LOCK,
  type SummarizerConfig,
} from './marker.js';

export interface SpawnContext {
  sessionId: string;
  cwd: string;
}

export type Spawner = (command: string, ctx: SpawnContext) => void;

export interface SessionStopResult {
  spawned: boolean;
  reason: 'spawned' | 'no-marker' | 'below-threshold' | 'locked';
  pending?: number;
}

export const detachedSpawner: Spawner = (command, ctx) => {
  const child = nodeSpawn(command, {
    shell: true,
    cwd: ctx.cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TIM_SESSION_ID: ctx.sessionId },
  });
  child.unref();
};

function buildSummarizerCommand(
  cfg: SummarizerConfig | undefined,
  sessionId: string,
  lockPath: string,
): string {
  const cli = cfg?.cli ?? 'claude';
  const model = cfg?.model ?? 'haiku';
  const prompt =
    `Summarize TIM session ${sessionId}: repeatedly call tim_show_unsummarized({sessionId:"${sessionId}"}), ` +
    `summarize each returned batch thematically, and tim_write the summary as a Batch node under summaryNodeId ` +
    `with metadata.kind="batch-summary". Stop when hasMore is false.`;
  return `${cli} -p --model ${model} ${JSON.stringify(prompt)} ; rm -f ${JSON.stringify(lockPath)}`;
}

export async function onSessionStop(
  store: TimStore,
  cwd: string,
  opts: { spawn?: Spawner } = {},
): Promise<SessionStopResult> {
  const spawn = opts.spawn ?? detachedSpawner;

  const marker = detectProject(cwd);
  if (!marker) return { spawned: false, reason: 'no-marker' };

  const reconciled = await reconcileMarker(store, cwd);
  const pending = reconciled.exchanges - reconciled.batches_summarized * reconciled.batch_size;
  if (pending < reconciled.batch_size) {
    return { spawned: false, reason: 'below-threshold', pending };
  }

  if (!acquireLock(cwd)) return { spawned: false, reason: 'locked', pending };

  const lockPath = path.join(cwd, MARKER_LOCK);
  spawn(buildSummarizerCommand(reconciled.summarizer, reconciled.session, lockPath), {
    sessionId: reconciled.session,
    cwd,
  });
  return { spawned: true, reason: 'spawned', pending };
}
