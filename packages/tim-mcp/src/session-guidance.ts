import type { TimStore } from 'tim-store';

/**
 * Guidance block prepended when tim_session_start fell back to the Inbox
 * (no projectId argument, no active project binding). Lists the most
 * recently active projects so the agent can bind explicitly instead of
 * silently logging exchanges into P0000. Response-driven guidance: weak
 * models follow tool-response text more reliably than system prompts.
 */
export async function buildInboxFallbackGuidance(store: TimStore): Promise<string | null> {
  let recents: { label: string; title: string | null; lastActive: string }[];
  try {
    recents = await store.recentActiveProjects(5);
  } catch {
    return null;
  }
  if (recents.length === 0) return null;
  const lines = recents.map(r => {
    const title = r.title ? ` — ${r.title}` : '';
    return `  ${r.label}${title} (last active ${r.lastActive.slice(0, 10)})`;
  });
  return [
    '⚠️ No project binding found — this session is bound to the Inbox (P0000).',
    'Exchanges logged here are NOT attached to any project.',
    'Recently active projects:',
    ...lines,
    'ACTION: if this session belongs to one of these projects, call',
    'tim_load_project(label="P00XX") now to bind it. Otherwise continue in the Inbox.',
  ].join('\n');
}
