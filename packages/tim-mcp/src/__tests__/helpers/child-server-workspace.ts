import { afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let currentOuterDir: string | undefined;
let currentBoundaryDir: string | undefined;
let currentDir: string | undefined;
let currentDbPath: string | undefined;
let previousMarkerMaxRoot: string | undefined;
let previousCacheDir: string | undefined;

/** Give every spawned MCP server test an isolated cwd outside the repository. */
export function isolateChildServerCwd(): void {
  beforeEach(() => {
    currentOuterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-mcp-child-'));
    currentBoundaryDir = path.join(currentOuterDir, 'sandbox');
    currentDir = path.join(currentBoundaryDir, 'cwd');
    fs.mkdirSync(currentDir, { recursive: true });
    currentDbPath = path.join(currentDir, 'tim.db');
    previousMarkerMaxRoot = process.env.TIM_MARKER_MAX_ROOT;
    previousCacheDir = process.env.TIM_CACHE_DIR;
    process.env.TIM_MARKER_MAX_ROOT = currentBoundaryDir;
    process.env.TIM_CACHE_DIR = path.join(currentBoundaryDir, 'cache');
  });
  afterEach(() => {
    if (previousMarkerMaxRoot === undefined) delete process.env.TIM_MARKER_MAX_ROOT;
    else process.env.TIM_MARKER_MAX_ROOT = previousMarkerMaxRoot;
    if (previousCacheDir === undefined) delete process.env.TIM_CACHE_DIR;
    else process.env.TIM_CACHE_DIR = previousCacheDir;
    if (currentOuterDir) fs.rmSync(currentOuterDir, { recursive: true, force: true });
    currentOuterDir = undefined;
    currentBoundaryDir = undefined;
    currentDir = undefined;
    currentDbPath = undefined;
    previousMarkerMaxRoot = undefined;
    previousCacheDir = undefined;
  });
}

export function childServerDbPath(): string {
  if (!currentDbPath) throw new Error('child server database is not initialized');
  return currentDbPath;
}

/** Marker outside TIM_MARKER_MAX_ROOT but still on the child's ancestor chain. */
export function childServerOutsideMarkerPath(): string {
  if (!currentOuterDir) throw new Error('child server outer workspace is not initialized');
  return path.join(currentOuterDir, '.tim-project');
}

export function childServerCwd(): string {
  if (!currentDir) throw new Error('child server workspace is not initialized');
  return currentDir;
}
