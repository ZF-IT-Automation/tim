// Formatting for tim_resume_list / tim_session_resume tool responses.
import type { ResumePayload, ResumableSession } from 'tim-store';

export function formatResumeList(projectLabel: string, list: ResumableSession[]): string {
  if (list.length === 0) {
    return `No resumable sessions found for ${projectLabel}.`;
  }
  const lines = list.map((s, i) => {
    const date = (s.date ?? s.lastActivity).slice(0, 16).replace('T', ' ');
    const parts = [
      `${i + 1}. ${s.sessionId} — ${date}`,
      s.tool ?? 'unknown tool',
      `${s.exchangeCount} exchanges`,
      ...(s.taskSummary ? [s.taskSummary] : []),
    ].join(' · ');
    return s.summaryFirstLine ? `${parts}\n   ${s.summaryFirstLine}` : parts;
  });
  return [
    `Resumable sessions for ${projectLabel} (most recent activity first):`,
    ...lines,
    '',
    'ACTION: Present this list to the user and ask which session to resume. ' +
    'On choice, call tim_session_resume with the chosen sessionId.',
  ].join('\n');
}

export function formatResumePayload(p: ResumePayload): string {
  const m = p.sessionMeta;
  const header = [
    `## Resumed Session ${p.sessionId}`,
    [
      m.project && `Project: ${m.project}`,
      m.date && `Started: ${m.date.slice(0, 16).replace('T', ' ')}`,
      m.toolHistory.length ? `Tools: ${m.toolHistory.join(' → ')}` : m.tool && `Tool: ${m.tool}`,
      `${m.exchangeCount} exchanges`,
      m.taskSummary && `Task: ${m.taskSummary}`,
    ].filter(Boolean).join(' · '),
  ].join('\n');

  const summarySection = [
    '## Session Summary',
    p.sessionSummary.trim() || '(no session summary yet)',
  ].join('\n');

  const batchSection = p.batchSummaries.length
    ? [
        `## Batch Summaries (${p.batchSummaries.length})`,
        ...p.batchSummaries.map(b =>
          `### Batch ${b.batchIndex} (seq ${b.seqFrom}–${b.seqTo})\n${b.text.trim()}`),
      ].join('\n\n')
    : '## Batch Summaries\n(none)';

  const exchangeSection = [
    `## Last ${p.recentExchanges.length} Exchanges (raw)`,
    ...p.recentExchanges.map(e => {
      const user = `[seq ${e.seq}] USER: ${e.userContent}`;
      return e.agentContent != null
        ? `${user}\n[seq ${e.seq}] AGENT: ${e.agentContent}`
        : user;
    }),
  ].join('\n\n');

  const warningLines = p.warnings.map(w => `⚠ ${w}`);

  return [
    header,
    summarySection,
    batchSection,
    exchangeSection,
    ...(warningLines.length ? [warningLines.join('\n')] : []),
    'ACTION: Context restored. Continue the conversation from here; ' +
    'all further exchanges append to this session automatically.',
  ].join('\n\n');
}
