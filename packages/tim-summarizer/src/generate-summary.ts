import type { UnsummarizedBatch } from './mcp-client.js';

/** Compact thematic summary for a batch (no external API required). */
export function generateSummaryHeuristic(batch: UnsummarizedBatch): string {
  const lines = batch.exchanges.map(e => {
    const agent = e.agentContent?.trim() || '(no agent reply)';
    return `Q${e.seq}: ${e.userContent.trim()}\nA: ${agent}`;
  });
  const body = lines.join('\n\n');
  const prefix = batch.previousSummaries.length
    ? `Prior themes: ${batch.previousSummaries.slice(-2).join(' | ')}\n\n`
    : '';
  const meta = [
    batch.sessionMeta.project && `project=${batch.sessionMeta.project}`,
    batch.sessionMeta.tool && `tool=${batch.sessionMeta.tool}`,
    batch.sessionMeta.task_summary && `task=${batch.sessionMeta.task_summary}`,
  ]
    .filter(Boolean)
    .join(' ');

  let summary = `${prefix}Batch ${batch.batchIndex} (${batch.exchanges.length} exchanges)`;
  if (meta) summary += ` [${meta}]`;
  summary += `:\n${body}`;
  if (summary.length > 4000) summary = summary.slice(0, 3997) + '…';
  return summary;
}

/** Optional Anthropic API when ANTHROPIC_API_KEY is set. */
export async function generateSummary(batch: UnsummarizedBatch): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return generateSummaryHeuristic(batch);

  const model = process.env.TIM_SUMMARIZER_MODEL || 'claude-3-5-haiku-latest';
  const payload = {
    model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content:
          `Summarize this agent session batch thematically (bullet themes, decisions, open items). ` +
          `Batch index ${batch.batchIndex}. JSON:\n${JSON.stringify({
            exchanges: batch.exchanges,
            previousSummaries: batch.previousSummaries,
            sessionMeta: batch.sessionMeta,
          })}`,
      },
    ],
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return generateSummaryHeuristic(batch);
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find(c => c.type === 'text')?.text?.trim();
    return text && text.length > 0 ? text : generateSummaryHeuristic(batch);
  } catch {
    return generateSummaryHeuristic(batch);
  }
}
