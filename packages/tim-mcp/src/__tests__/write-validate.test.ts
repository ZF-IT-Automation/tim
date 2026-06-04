import { describe, it, expect } from 'vitest';
import {
  SCHEMA_KINDS,
  MIN_TAGS_FOR_USER_CONTENT,
  validateWriteTags,
} from '../write-validate.js';

describe('validateWriteTags', () => {
  describe('schema entries (exempt)', () => {
    // Every kind in SCHEMA_KINDS must be exempt from the tags rule, with or
    // without tags. These are the structural nodes the system creates
    // automatically — sections, project roots, session sub-trees, etc.
    const structuralCases: Array<{ kind: string; desc: string }> = [
      { kind: 'project', desc: 'project root' },
      { kind: 'section', desc: 'project section (e.g. Tasks, Errors)' },
      { kind: 'sessions-root', desc: 'Sessions section' },
      { kind: 'session', desc: 'session entry' },
      { kind: 'session-summary-root', desc: 'session Summary sub-root' },
      { kind: 'exchanges-root', desc: 'session Exchanges sub-root' },
      { kind: 'exchange-batch', desc: 'exchange batch container' },
      { kind: 'exchange', desc: 'user/agent exchange' },
      { kind: 'batch-summary', desc: 'summarizer batch node' },
      { kind: 'commits-root', desc: 'Commits section' },
      { kind: 'commit', desc: 'commit entry' },
      { kind: 'checkpoint', desc: 'checkpoint entry' },
    ];

    for (const { kind, desc } of structuralCases) {
      it(`section write without tags succeeds — ${desc}`, () => {
        const result = validateWriteTags([], { kind });
        expect(result.ok).toBe(true);
      });

      it(`section write with undefined tags succeeds — ${desc}`, () => {
        const result = validateWriteTags(undefined, { kind });
        expect(result.ok).toBe(true);
      });
    }

    it('section kind is in SCHEMA_KINDS (no drift)', () => {
      // Catches accidental removal of a structural kind.
      for (const k of [
        'project', 'section', 'sessions-root', 'session',
        'session-summary-root', 'exchanges-root', 'exchange-batch',
        'exchange', 'batch-summary', 'commits-root', 'commit', 'checkpoint',
      ]) {
        expect(SCHEMA_KINDS.has(k), `expected ${k} in SCHEMA_KINDS`).toBe(true);
      }
    });
  });

  describe('non-schema entries (require tags)', () => {
    it('leaf write with 0 tags → tags_required error', () => {
      const result = validateWriteTags([], {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('tags_required');
      expect(result.message).toMatch(/at least 2 tags/);
      expect(result.metadata_hint).toHaveProperty('note');
    });

    it('leaf write with 1 tag → tags_required error', () => {
      const result = validateWriteTags(['only-one'], { kind: 'task' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('tags_required');
      // metadata_hint echoes the kind to help the caller fix the call
      expect(result.metadata_hint.kind).toBe('task');
    });

    it('leaf write with undefined tags → tags_required error', () => {
      const result = validateWriteTags(undefined, { kind: 'note' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('tags_required');
    });

    it('leaf write with 2 tags → succeeds', () => {
      const result = validateWriteTags(['#auth', '#refactor'], { kind: 'task' });
      expect(result.ok).toBe(true);
    });

    it('leaf write with 5 tags → succeeds', () => {
      const result = validateWriteTags(
        ['#auth', '#refactor', '#urgent', '#backend', '#oncall'],
        { kind: 'task' },
      );
      expect(result.ok).toBe(true);
    });

    it('error envelope includes metadata_hint for the fix', () => {
      const result = validateWriteTags([], { kind: 'learning', topic: 'vitest' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.metadata_hint).toMatchObject({
        kind: 'learning',
        topic: 'vitest',
      });
    });
  });

  describe('edge cases', () => {
    it('metadata without kind is treated as user content', () => {
      const result = validateWriteTags([], { topic: 'misc' });
      expect(result.ok).toBe(false);
    });

    it('empty metadata with tags passes', () => {
      const result = validateWriteTags(['#a', '#b'], {});
      expect(result.ok).toBe(true);
    });

    it('non-string kind is ignored (treated as user content)', () => {
      const result = validateWriteTags(['#a', '#b'], { kind: 123 });
      expect(result.ok).toBe(true);
    });

    it('MIN_TAGS_FOR_USER_CONTENT is 2', () => {
      expect(MIN_TAGS_FOR_USER_CONTENT).toBe(2);
    });
  });
});
