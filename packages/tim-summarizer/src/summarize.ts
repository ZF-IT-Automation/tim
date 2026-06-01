#!/usr/bin/env node
import { connectTimMcp, callTimTool, type UnsummarizedBatch } from './mcp-client.js';
import { generateSummary } from './generate-summary.js';

function seqRange(batch: UnsummarizedBatch): { seqFrom: number; seqTo: number } {
  const seqs = batch.exchanges.map(e => e.seq);
  return { seqFrom: Math.min(...seqs), seqTo: Math.max(...seqs) };
}

export async function runSummarizerLoop(sessionId: string): Promise<number> {
  const client = await connectTimMcp();
  let written = 0;
  try {
    let batch = await callTimTool<UnsummarizedBatch>(client, 'tim_show_unsummarized', { sessionId });
    while (batch.exchanges.length > 0) {
      const summary = await generateSummary(batch);
      const { seqFrom, seqTo } = seqRange(batch);
      await callTimTool(client, 'tim_write_batch_summary', {
        sessionId,
        batchIndex: batch.batchIndex,
        summary,
        seqFrom,
        seqTo,
      });
      written += 1;
      if (!batch.hasMore) break;
      batch = await callTimTool<UnsummarizedBatch>(client, 'tim_show_unsummarized', { sessionId });
    }
  } finally {
    await client.close();
  }
  return written;
}

async function main(): Promise<void> {
  const sessionId = process.env.TIM_SESSION_ID;
  if (!sessionId) {
    console.error('TIM_SESSION_ID is required');
    process.exit(1);
  }
  try {
    const count = await runSummarizerLoop(sessionId);
    console.error(`tim-summarizer: wrote ${count} batch summary(ies) for ${sessionId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`tim-summarizer failed: ${msg}`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1]?.endsWith('summarize.js') || process.argv[1]?.endsWith('summarize.ts');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
