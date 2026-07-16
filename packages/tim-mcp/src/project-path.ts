import { findMarker, type FindMarkerOptions } from 'tim-hooks';

/**
 * Resolve the filesystem project path for auto-detecting coding-task `vcs`.
 * Stdio MCP: prefer the bound `.tim-project` directory (walk-up), else cwd.
 * HTTP MCP: never guess — server cwd is not the caller's project.
 */
export function resolveCallerProjectPath(
  isHttp: boolean,
  cwd: string = process.cwd(),
  markerOptions?: FindMarkerOptions,
): string | undefined {
  if (isHttp) return undefined;
  return findMarker(cwd, { walkUp: true, ...markerOptions })?.dir ?? cwd;
}
