import { afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let currentDir: string | undefined;
let currentDbPath: string | undefined;

/** Give every spawned MCP server test an isolated cwd outside the repository. */
export function isolateChildServerCwd(): void {
  beforeEach(() => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-mcp-child-'));
    currentDbPath = path.join(currentDir, 'tim.db');
  });
  afterEach(() => {
    if (currentDir) fs.rmSync(currentDir, { recursive: true, force: true });
    currentDir = undefined;
    currentDbPath = undefined;
  });
}

export function childServerDbPath(): string {
  if (!currentDbPath) throw new Error('child server database is not initialized');
  return currentDbPath;
}

export function childServerCwd(): string {
  if (!currentDir) throw new Error('child server workspace is not initialized');
  return currentDir;
}
