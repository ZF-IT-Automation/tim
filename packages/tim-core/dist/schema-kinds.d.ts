/**
 * Kind values that identify schema/structural entries. Entries with these kinds
 * are exempt from the "tags required" rule in tim_write. Everything else
 * (user-generated content) MUST carry at least 2 tags for discoverability.
 *
 * Sourced from:
 *   - packages/tim-core/src/project.ts   (project)
 *   - packages/tim-store/src/session-tree.ts  (sessions/summary/batch/exchange)
 *   - packages/tim-store/src/commit-tree.ts  (commits)
 *   - ad-hoc structural kinds in checkpoint + section code paths
 */
export declare const SCHEMA_KINDS: Set<string>;
//# sourceMappingURL=schema-kinds.d.ts.map