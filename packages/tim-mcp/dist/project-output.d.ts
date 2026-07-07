import type { LoadProjectResult } from 'tim-store';
export interface ProjectSchemaSection {
    name: string;
    description?: string;
    render_depth?: number | 'full';
    render_tail?: boolean;
    children?: ProjectSchemaSection[];
}
export interface ProjectSchema {
    sections: ProjectSchemaSection[];
}
export declare function formatProjectOutput(result: LoadProjectResult, budget: number, schema?: ProjectSchema, renderMode?: 'load' | 'read'): string;
//# sourceMappingURL=project-output.d.ts.map