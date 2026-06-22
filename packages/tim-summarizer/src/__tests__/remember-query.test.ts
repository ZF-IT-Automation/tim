import { describe, it, expect } from 'vitest';
import {
  buildRerankPrompt,
  parseRerankOutput,
  REMEMBER_FALLBACK_MARKER,
} from '../remember-query.js';

describe('buildRerankPrompt', () => {
  it('includes query, candidate IDs, JSON array instructions, and fallback marker', () => {
    const prompt = buildRerankPrompt({
      query: 'Telegram bot crash',
      candidates: [
        {
          id: '01ABC',
          title: 'Telegram Single-Client',
          excerpt: 'Polling race condition fix',
          parents: [{ id: 'P0062', title: 'bbbee PM Workflow' }],
        },
        {
          id: '01DEF',
          title: 'Worker reliability',
          excerpt: 'Hermes spawn patterns',
          parents: [{ id: 'P0062', title: 'bbbee PM Workflow' }],
        },
      ],
      topK: 5,
    });

    expect(prompt).toContain('Telegram bot crash');
    expect(prompt).toContain('01ABC');
    expect(prompt).toContain('01DEF');
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain(REMEMBER_FALLBACK_MARKER);
  });
});

describe('parseRerankOutput', () => {
  it('returns empty array for empty JSON array', () => {
    expect(parseRerankOutput('[]', 5)).toEqual([]);
  });

  it('parses valid single item', () => {
    const result = parseRerankOutput(
      '[{"node_id":"01ABC","confidence":0.8,"reasoning":"match"}]',
      5,
    );
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      node_id: '01ABC',
      confidence: 0.8,
      reasoning: 'match',
    });
  });

  it('returns null for non-JSON text', () => {
    expect(parseRerankOutput('not json', 5)).toBeNull();
  });

  it('filters out confidence above 1.0', () => {
    expect(
      parseRerankOutput('[{"node_id":"x","confidence":1.5,"reasoning":"x"}]', 5),
    ).toEqual([]);
  });

  it('truncates reasoning to 120 chars', () => {
    const longReasoning = 'a'.repeat(200);
    const result = parseRerankOutput(
      `[{"node_id":"x","confidence":0.8,"reasoning":"${longReasoning}"}]`,
      5,
    );
    expect(result).toHaveLength(1);
    expect(result![0]!.reasoning).toHaveLength(120);
    expect(result![0]!.reasoning).toBe('a'.repeat(120));
  });

  it('strips markdown fences', () => {
    const fenced = '```json\n[{"node_id":"01ABC","confidence":0.8,"reasoning":"x"}]\n```';
    const result = parseRerankOutput(fenced, 5);
    expect(result).toHaveLength(1);
    expect(result![0]!.node_id).toBe('01ABC');
  });

  it('caps output at topK * 2', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      node_id: `id${i}`,
      confidence: 0.9 - i * 0.1,
      reasoning: 'y',
    }));
    const result = parseRerankOutput(JSON.stringify(items), 1);
    expect(result!.length).toBeLessThanOrEqual(2);
  });

  it('sorts by confidence descending', () => {
    const result = parseRerankOutput(
      '[{"node_id":"low","confidence":0.3,"reasoning":"a"},{"node_id":"high","confidence":0.9,"reasoning":"b"}]',
      5,
    );
    expect(result).toHaveLength(2);
    expect(result![0]!.node_id).toBe('high');
    expect(result![1]!.node_id).toBe('low');
  });
});
