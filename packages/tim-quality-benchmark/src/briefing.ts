import type { TimStore } from 'tim-store';
import { formatProjectOutput } from 'tim-mcp';
import { buildBriefingRenderContext } from 'tim-mcp/dist/briefing-context.js';
import { loadProjectForBriefing } from 'tim-mcp/dist/briefing-load.js';
import { searchTaskBriefingExtras } from 'tim-mcp/dist/task-aware-selection.js';

/** Production briefing path: loadProjectForBriefing + scoped FTS extras + formatProjectOutput. */
export async function renderTimBriefing(
  store: TimStore,
  projectLabel: string,
  query: string,
  tokenBudget: number,
  entryBudget = 250,
): Promise<string> {
  const loaded = await loadProjectForBriefing(store, projectLabel, {
    depth: 4,
    budget: entryBudget,
  });
  if (!loaded) {
    throw new Error(`Project not found for briefing: ${projectLabel}`);
  }
  const queryExtras = await searchTaskBriefingExtras(store, projectLabel, query, 'literal');
  const briefingContext = await buildBriefingRenderContext(
    store,
    projectLabel,
    loaded.project.id,
    3,
  );
  return formatProjectOutput(loaded, entryBudget, undefined, 'read', 3, {
    tokenBudget,
    query,
    queryExtras,
    briefingContext,
  });
}
