import { describe, it, expect } from 'vitest';
import { TOOL_DEFS } from '../server.js';

const rollup = TOOL_DEFS.find(d => d.name === 'tim_rollup_session_summary')!;

describe('tim_rollup_session_summary schema', () => {
  it('accepts an optional pre-condensed summary', () => {
    expect(rollup).toBeDefined();
    expect(Object.keys(rollup.schema.shape).sort()).toEqual(['sessionId', 'summary']);

    // Omitting it is still valid — the server then folds the batch summaries.
    expect(rollup.schema.parse({ sessionId: 'sess-1' })).toEqual({ sessionId: 'sess-1' });
    expect(rollup.schema.parse({ sessionId: 'sess-1', summary: 'condensed' })).toEqual({
      sessionId: 'sess-1',
      summary: 'condensed',
    });
  });
});
