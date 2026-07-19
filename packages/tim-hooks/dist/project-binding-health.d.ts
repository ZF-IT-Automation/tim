import { TimStore } from 'tim-store';
import { type ProjectCreationDeps } from './project-creation.js';
export type ProjectBindingStatus = 'bound' | 'unbound' | 'label-mismatch' | 'path-missing' | 'no-path';
export interface ProjectBindingFinding {
    label: string;
    path?: string;
    status: ProjectBindingStatus;
    markerLabel?: string;
}
export interface StalePathFinding {
    label: string;
    path: string;
    device: string;
    lastSeenAt?: string;
}
export interface BindingReport {
    projects: ProjectBindingFinding[];
    stalePaths: StalePathFinding[];
}
export interface BindOutcome {
    label: string;
    outcome: 'bound' | 'already-bound' | 'failed';
    detail?: string;
}
export declare function bindingDeviceId(): string;
/** Classify a project's on-disk binding from store metadata.path. */
export declare function classifyProjectPathBinding(label: string, projectPath: string | undefined): Pick<ProjectBindingFinding, 'status' | 'markerLabel'>;
export declare function collectBindingReport(store: TimStore): Promise<BindingReport>;
export declare function formatBindingFindingLine(finding: ProjectBindingFinding): string;
export declare function formatStalePathLine(finding: StalePathFinding): string;
export declare function formatBindOutcomeLine(outcome: BindOutcome): string;
export declare function bindUnboundBindings(store: TimStore, findings: ProjectBindingFinding[], deps?: Partial<ProjectCreationDeps>): Promise<BindOutcome[]>;
//# sourceMappingURL=project-binding-health.d.ts.map