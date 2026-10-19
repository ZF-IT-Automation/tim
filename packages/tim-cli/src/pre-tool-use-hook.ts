/**
 * Claude Code PreToolUse hook for Bash. Its own entry, not `cli.js hook …`: it starts on every
 * Bash call, and loading the whole CLI costs ~250 ms. Only a risky command with the guard
 * switched on (hooks.preToolUse.enabled) loads the store. Never blocks or approves the call:
 * it prints context or nothing, and always exits 0.
 */
import { preToolUseEnvelope, readJsonStdin } from './claude-hook-io.js';
import { isRiskyCommand } from 'tim-hooks/dist/risky-command.js';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

async function main(): Promise<void> {
  // Same flags as isSummarizerChild / isTeamupWorker: TIM hooks no-op there.
  if (process.env.TIM_SUMMARIZER === '1' || process.env.TEAMUP_WORKER === '1') return;
  const payload = await readJsonStdin();
  const input = (payload?.tool_input ?? {}) as Record<string, unknown>;
  const command = text(input.command);
  if (payload?.tool_name !== 'Bash' || !isRiskyCommand(command)) return;

  const { loadConfig } = await import('tim-core');
  const config = loadConfig();
  if (config.hooks?.preToolUse?.enabled !== true) return;
  const cwd = text(payload.cwd);
  if (!cwd) return;

  const [{ TimStore }, { runToolGuard }, { resolveHookProject }, { getDbPath }] = await Promise.all([
    import('tim-store'),
    import('tim-hooks'),
    import('./hook-project.js'),
    import('./db-path.js'),
  ]);
  const store = new TimStore(getDbPath(config));
  try {
    const sessionId = text(payload.session_id);
    const projectLabel = await resolveHookProject(store, sessionId, cwd);
    if (!projectLabel) return;
    const result = await runToolGuard(store, { command, description: text(input.description), projectLabel, sessionId });
    if (result) process.stdout.write(JSON.stringify(preToolUseEnvelope(result.context)));
  } finally {
    store.close();
  }
}

main().catch(() => {
  // Fail soft: no context, no nonzero exit.
});
