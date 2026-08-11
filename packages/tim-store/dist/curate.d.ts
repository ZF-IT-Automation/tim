import Database from 'better-sqlite3';
import type { Entry } from 'tim-core';
export interface UpdateManyFlags {
    irrelevant?: boolean;
    favorite?: boolean;
}
export declare class CurateManager {
    private db;
    private deviceId;
    constructor(db: Database.Database, deviceId?: string);
    renameEntry(oldId: string, newId: string): Entry;
    moveEntry(id: string, newParentId: string | null, order?: number): Entry;
    updateMany(ids: string[], flags: UpdateManyFlags): Entry[];
    tagAdd(id: string, tags: string[]): Entry;
    tagRemove(id: string, tags: string[]): Entry;
    /**
     * Rename a tag, optionally only inside one project's subtree.
     *
     * The scope is not a convenience. Merging tag families is the one cleanup
     * that has to happen across a finished corpus — a single entry cannot show
     * that three neighbours name the same thing differently — and the same word
     * routinely means different things in different projects. Measured 2026-08-11:
     * #handoff carried 7 entries in P0062, 6 in P0063 and 1 each in P0054 and
     * P0072, meaning the worker handoff in one place and TIM's handoff note in
     * another. Unscoped, merging it into #handoff-note was a wrong rewrite of
     * three projects to fix one.
     *
     * `rootId` is the project's entry id; the caller resolves the label.
     */
    tagRename(oldTag: string, newTag: string, opts?: {
        rootId?: string;
    }): number;
}
//# sourceMappingURL=curate.d.ts.map