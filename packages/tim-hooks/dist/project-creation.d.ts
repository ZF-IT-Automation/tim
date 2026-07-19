import type { Entry } from 'tim-core';
import { TimStore } from 'tim-store';
import { writeMarkerExclusive } from './marker.js';
export declare const MODE_ERROR = "Exactly one creation mode is required. Pass an absolute project path for a repository/workspace, or memoryOnly: true only when no directory should be bound.";
export interface ProjectCreationArgs {
    label: string;
    content?: string;
    metadata?: Record<string, unknown>;
    aliases?: string[];
    path?: string;
    memoryOnly?: boolean;
}
export interface MemoryOnlyProjectCreationResult extends Entry {
    mode: 'memory-only';
}
export interface BoundProjectCreationResult extends Entry {
    mode: 'bound';
    projectPath: string;
    markerPath: string;
}
export type ProjectCreationResult = MemoryOnlyProjectCreationResult | BoundProjectCreationResult;
export interface ProjectCreationDeps {
    sessionId: () => string;
    writeExclusive: typeof writeMarkerExclusive;
    preflight: typeof preflightProjectDirectory;
}
export interface RecoverProjectBindingArgs {
    label: string;
    path: string;
}
export interface RecoverProjectBindingResult {
    label: string;
    projectPath: string;
    markerPath: string;
    alreadyBound: boolean;
}
export declare class ProjectCreationPartialFailureError extends Error {
    readonly createdLabel: string;
    readonly projectPath: string;
    constructor(message: string, createdLabel: string, projectPath: string);
}
export declare function validateMode(args: ProjectCreationArgs): 'bound' | 'memory-only';
export declare function canonicalDirectory(directory: string): string;
export declare function preflightProjectDirectory(directory: string): void;
export declare function createProjectCoordinated(store: TimStore, args: ProjectCreationArgs, deps?: Partial<ProjectCreationDeps>): Promise<ProjectCreationResult>;
export declare function recoverProjectBinding(store: TimStore, args: RecoverProjectBindingArgs, deps?: Partial<ProjectCreationDeps>): Promise<RecoverProjectBindingResult>;
//# sourceMappingURL=project-creation.d.ts.map