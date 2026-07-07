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
    tagRename(oldTag: string, newTag: string): number;
}
//# sourceMappingURL=curate.d.ts.map