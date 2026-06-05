"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const write_validate_js_1 = require("../write-validate.js");
(0, vitest_1.describe)('validateWriteTags', () => {
    (0, vitest_1.describe)('schema entries (exempt)', () => {
        // Every kind in SCHEMA_KINDS must be exempt from the tags rule, with or
        // without tags. These are the structural nodes the system creates
        // automatically — sections, project roots, session sub-trees, etc.
        const structuralCases = [
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
            (0, vitest_1.it)(`section write without tags succeeds — ${desc}`, () => {
                const result = (0, write_validate_js_1.validateWriteTags)([], { kind });
                (0, vitest_1.expect)(result.ok).toBe(true);
            });
            (0, vitest_1.it)(`section write with undefined tags succeeds — ${desc}`, () => {
                const result = (0, write_validate_js_1.validateWriteTags)(undefined, { kind });
                (0, vitest_1.expect)(result.ok).toBe(true);
            });
        }
        (0, vitest_1.it)('section kind is in SCHEMA_KINDS (no drift)', () => {
            // Catches accidental removal of a structural kind.
            for (const k of [
                'project', 'section', 'sessions-root', 'session',
                'session-summary-root', 'exchanges-root', 'exchange-batch',
                'exchange', 'batch-summary', 'commits-root', 'commit', 'checkpoint',
            ]) {
                (0, vitest_1.expect)(write_validate_js_1.SCHEMA_KINDS.has(k), `expected ${k} in SCHEMA_KINDS`).toBe(true);
            }
        });
    });
    (0, vitest_1.describe)('non-schema entries (require tags)', () => {
        (0, vitest_1.it)('leaf write with 0 tags → tags_required error', () => {
            const result = (0, write_validate_js_1.validateWriteTags)([], {});
            (0, vitest_1.expect)(result.ok).toBe(false);
            if (result.ok)
                return;
            (0, vitest_1.expect)(result.error).toBe('tags_required');
            (0, vitest_1.expect)(result.message).toMatch(/at least 2 tags/);
            (0, vitest_1.expect)(result.metadata_hint).toHaveProperty('note');
        });
        (0, vitest_1.it)('leaf write with 1 tag → tags_required error', () => {
            const result = (0, write_validate_js_1.validateWriteTags)(['only-one'], { kind: 'task' });
            (0, vitest_1.expect)(result.ok).toBe(false);
            if (result.ok)
                return;
            (0, vitest_1.expect)(result.error).toBe('tags_required');
            // metadata_hint echoes the kind to help the caller fix the call
            (0, vitest_1.expect)(result.metadata_hint.kind).toBe('task');
        });
        (0, vitest_1.it)('leaf write with undefined tags → tags_required error', () => {
            const result = (0, write_validate_js_1.validateWriteTags)(undefined, { kind: 'note' });
            (0, vitest_1.expect)(result.ok).toBe(false);
            if (result.ok)
                return;
            (0, vitest_1.expect)(result.error).toBe('tags_required');
        });
        (0, vitest_1.it)('leaf write with 2 tags → succeeds', () => {
            const result = (0, write_validate_js_1.validateWriteTags)(['#auth', '#refactor'], { kind: 'task' });
            (0, vitest_1.expect)(result.ok).toBe(true);
        });
        (0, vitest_1.it)('leaf write with 5 tags → succeeds', () => {
            const result = (0, write_validate_js_1.validateWriteTags)(['#auth', '#refactor', '#urgent', '#backend', '#oncall'], { kind: 'task' });
            (0, vitest_1.expect)(result.ok).toBe(true);
        });
        (0, vitest_1.it)('error envelope includes metadata_hint for the fix', () => {
            const result = (0, write_validate_js_1.validateWriteTags)([], { kind: 'learning', topic: 'vitest' });
            (0, vitest_1.expect)(result.ok).toBe(false);
            if (result.ok)
                return;
            (0, vitest_1.expect)(result.metadata_hint).toMatchObject({
                kind: 'learning',
                topic: 'vitest',
            });
        });
    });
    (0, vitest_1.describe)('edge cases', () => {
        (0, vitest_1.it)('metadata without kind is treated as user content', () => {
            const result = (0, write_validate_js_1.validateWriteTags)([], { topic: 'misc' });
            (0, vitest_1.expect)(result.ok).toBe(false);
        });
        (0, vitest_1.it)('empty metadata with tags passes', () => {
            const result = (0, write_validate_js_1.validateWriteTags)(['#a', '#b'], {});
            (0, vitest_1.expect)(result.ok).toBe(true);
        });
        (0, vitest_1.it)('non-string kind is ignored (treated as user content)', () => {
            const result = (0, write_validate_js_1.validateWriteTags)(['#a', '#b'], { kind: 123 });
            (0, vitest_1.expect)(result.ok).toBe(true);
        });
        (0, vitest_1.it)('MIN_TAGS_FOR_USER_CONTENT is 2', () => {
            (0, vitest_1.expect)(write_validate_js_1.MIN_TAGS_FOR_USER_CONTENT).toBe(2);
        });
    });
});
//# sourceMappingURL=write-validate.test.js.map