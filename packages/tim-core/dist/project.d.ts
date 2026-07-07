/** Project entry metadata (kind=project). */
export interface ProjectMetadata {
    kind: 'project';
    label: string;
    aliases?: string[];
    [key: string]: unknown;
}
export type ResolveProjectResult = {
    status: 'found';
    label: string;
} | {
    status: 'not_found';
    query: string;
} | {
    status: 'ambiguous';
    query: string;
    labels: string[];
};
/**
 * One candidate for a section title match. Carries enough context to let the
 * caller pick a specific section (e.g. via parentId) without re-querying.
 */
export interface SectionCandidate {
    id: string;
    title: string;
    project: string;
    depth: number;
    createdAt: string;
}
/**
 * Result of resolving a section by (projectId, title).
 *   - found:     exactly one match — caller may proceed with id.
 *   - not_found: zero matches — candidates lists sibling section titles.
 *   - ambiguous: >1 matches — caller must disambiguate by passing parentId.
 */
export type ResolveSectionResult = {
    status: 'found';
    id: string;
    project: string;
    title: string;
} | {
    status: 'not_found';
    project: string;
    title: string;
    candidates: string[];
} | {
    status: 'ambiguous';
    project: string;
    title: string;
    candidates: SectionCandidate[];
};
//# sourceMappingURL=project.d.ts.map