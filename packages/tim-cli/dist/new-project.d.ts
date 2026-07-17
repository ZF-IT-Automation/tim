import { createProjectCoordinated } from 'tim-hooks';
export interface NewProjectDeps {
    createProject: typeof createProjectCoordinated;
}
export declare function cmdNewProject(args: string[], deps?: NewProjectDeps): Promise<void>;
//# sourceMappingURL=new-project.d.ts.map