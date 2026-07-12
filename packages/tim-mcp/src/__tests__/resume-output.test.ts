import { describe, it, expect } from 'vitest';
import { formatResumePayload, formatResumeList } from '../resume-output.js';
import type { ResumePayload, ResumableSession } from 'tim-store';

describe('formatResumeList', () => {
  it('renders numbered list with ACTION line', () => {
    const list: ResumableSession[] = [{
      sessionId: 'sess-1',
      title: '2026-07-12-0930',
      date: '2026-07-12T09:30:00Z',
      lastActivity: '2026-07-12T11:00:00Z',
      tool: 'claude',
      taskSummary: 'queue ordering',
      exchangeCount: 14,
      summaryFirstLine: 'Implemented insert-between gaps',
    }];
    const text = formatResumeList('P0063', list);
    expect(text).toContain('1. sess-1');
    expect(text).toContain('claude');
    expect(text).toContain('14 exchanges');
    expect(text).toContain('Implemented insert-between gaps');
    expect(text).toContain('ACTION:');
    expect(text).toContain('tim_session_resume');
  });

  it('handles empty list', () => {
    expect(formatResumeList('P0063', [])).toContain('No resumable sessions');
  });
});

describe('formatResumePayload', () => {
  const payload: ResumePayload = {
    sessionId: 'sess-1',
    sessionMeta: {
      project: 'P0063', date: '2026-07-12T09:30:00Z', tool: 'cursor',
      toolHistory: ['claude', 'cursor'], exchangeCount: 12, taskSummary: 'queue ordering',
    },
    sessionSummary: 'overall summary',
    batchSummaries: [{ batchIndex: 1, seqFrom: 1, seqTo: 5, text: 'batch one text' }],
    recentExchanges: [{ seq: 11, userContent: 'do X', agentContent: 'done X' }],
    warnings: ['No batch summaries yet — summarizer may be behind.'],
  };

  it('renders all sections and the ACTION footer', () => {
    const text = formatResumePayload(payload);
    expect(text).toContain('## Resumed Session');
    expect(text).toContain('## Session Summary');
    expect(text).toContain('overall summary');
    expect(text).toContain('### Batch 1 (seq 1–5)');
    expect(text).toContain('batch one text');
    expect(text).toContain('[seq 11] USER: do X');
    expect(text).toContain('[seq 11] AGENT: done X');
    expect(text).toContain('⚠');
    expect(text).toContain('ACTION: Context restored');
  });

  it('omits empty summary section gracefully', () => {
    const text = formatResumePayload({ ...payload, sessionSummary: '', batchSummaries: [] });
    expect(text).toContain('(no session summary yet)');
  });
});
