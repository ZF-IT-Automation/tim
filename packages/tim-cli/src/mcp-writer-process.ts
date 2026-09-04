// Resolve whether a PID is a TIM MCP stdio writer by reading /proc, not argv text.

import * as fs from 'fs';
import * as path from 'path';

export type ProcFs = {
  readFile: (p: string) => string;
  readlink: (p: string) => string;
  exists: (p: string) => boolean;
};

const defaultProcFs: ProcFs = {
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  readlink: (p) => fs.readlinkSync(p),
  exists: (p) => fs.existsSync(p),
};

const SERVER_SUFFIX = `${path.sep}tim-mcp${path.sep}dist${path.sep}server.js`;

export function resolveMcpServerScriptPath(
  pid: string,
  procFs: ProcFs = defaultProcFs,
): string | null {
  const cmdlinePath = `/proc/${pid}/cmdline`;
  if (!procFs.exists(cmdlinePath)) return null;

  const args = procFs.readFile(cmdlinePath).split('\0').filter(Boolean);
  const serverArg = args.find(
    (arg) => !arg.includes(' ') && (arg.endsWith('dist/server.js') || arg.endsWith('/server.js')),
  );
  if (!serverArg) return null;

  let scriptPath: string;
  if (path.isAbsolute(serverArg)) {
    scriptPath = serverArg;
  } else {
    const cwdPath = `/proc/${pid}/cwd`;
    if (!procFs.exists(cwdPath)) return null;
    scriptPath = path.resolve(procFs.readlink(cwdPath), serverArg);
  }

  return path.normalize(scriptPath);
}

export function isTimMcpServerScript(scriptPath: string): boolean {
  return scriptPath.endsWith(SERVER_SUFFIX);
}

export function isTimMcpWriterPid(
  pid: string,
  opts: { http?: boolean; procFs?: ProcFs } = {},
): boolean {
  const scriptPath = resolveMcpServerScriptPath(pid, opts.procFs);
  if (!scriptPath || !isTimMcpServerScript(scriptPath)) return false;

  if (opts.http === false) {
    const cmdlinePath = `/proc/${pid}/cmdline`;
    const procFs = opts.procFs ?? defaultProcFs;
    if (!procFs.exists(cmdlinePath)) return false;
    const cmd = procFs.readFile(cmdlinePath).replace(/\0/g, ' ');
    if (cmd.includes('--http')) return false;
  }

  return true;
}

/** pgrep candidate pattern — post-filtered via /proc identity checks. */
export const WRITER_CANDIDATE_PATTERN = 'dist/server\\.js';
