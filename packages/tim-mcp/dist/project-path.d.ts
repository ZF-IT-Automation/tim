import { type FindMarkerOptions } from 'tim-hooks';
/**
 * Resolve the filesystem project path for auto-detecting coding-task `vcs`.
 * Stdio MCP: prefer the bound `.tim-project` directory (walk-up), else cwd.
 * HTTP MCP: never guess — server cwd is not the caller's project.
 */
export declare function resolveCallerProjectPath(isHttp: boolean, cwd?: string, markerOptions?: FindMarkerOptions): string | undefined;
//# sourceMappingURL=project-path.d.ts.map