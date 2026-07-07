import type Database from 'better-sqlite3';
import type { TimStore } from './store.js';
/** Walk parent chain; true if any ancestor has metadata.secret=true. */
export declare function parentIsSecret(db: Database.Database, parentId: string | null): boolean;
/** Own secret flag OR inherited via parent chain. */
export declare function isSecret(db: Database.Database, id: string): boolean;
/** First ancestor (including self) with secret=true, or null. */
export declare function findSecretSource(db: Database.Database, id: string): string | null;
/** Synchronous materialization for moveEntry transaction path. */
export declare function materializeSecretSubtreeSync(db: Database.Database, rootId: string, deviceId?: string): number;
/** BFS subtree; materialize secret via store.update() for sync staging. */
export declare function setSecretSubtree(store: TimStore, id: string): Promise<number>;
/** After reparent: materialize secret on moved subtree when new parent is secret. */
export declare function ensureSecretInheritance(store: TimStore, id: string, newParentId: string | null): Promise<void>;
//# sourceMappingURL=secret.d.ts.map