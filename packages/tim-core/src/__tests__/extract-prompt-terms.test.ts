import { describe, it, expect } from 'vitest';
import {
  extractPromptTerms,
  buildPromptSearchQuery,
  PROMPT_STOP_WORDS,
} from '../extract-prompt-terms.js';

describe('extractPromptTerms', () => {
  it('strips English function words', () => {
    expect(extractPromptTerms('how can I optimize the deployment pipeline')).toEqual([
      'optimize', 'deployment', 'pipeline',
    ]);
  });

  it('strips German function words', () => {
    expect(extractPromptTerms('Wie kann ich die Wal-Größe für dieses Projekt optimieren')).toEqual([
      'wal', 'größe', 'projekt', 'optimieren',
    ]);
  });

  it('keeps tokens at or above min length', () => {
    expect(extractPromptTerms('go to sql')).toEqual(['sql']);
  });

  it('exports stop words as a set', () => {
    expect(PROMPT_STOP_WORDS.has('der')).toBe(true);
    expect(PROMPT_STOP_WORDS.has('the')).toBe(true);
  });
});

describe('buildPromptSearchQuery', () => {
  it('joins content terms with OR for FTS recall', () => {
    expect(buildPromptSearchQuery('how can I fix sqlite WAL size'))
      .toBe('"fix" OR "sqlite" OR "wal" OR "size"');
  });

  it('falls back to trimmed prompt when no terms survive', () => {
    expect(buildPromptSearchQuery('  a b  ')).toBe('a b');
  });
});
