import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Entry, EntryMetadata } from 'tim-core';
import { TimStore } from 'tim-store';
import {
  markerPath as projectMarkerPath,
  writeMarkerExclusive,
} from './marker.js';

export const MODE_ERROR = 'Exactly one creation mode is required. Pass an absolute project path for a repository/workspace, or memoryOnly: true only when no directory should be bound.';

export interface ProjectCreationArgs {
  label: string;
  content?: string;
  metadata?: EntryMetadata;
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

export type ProjectCreationResult =
  | MemoryOnlyProjectCreationResult
  | BoundProjectCreationResult;

export interface ProjectCreationDeps {
  sessionId: () => string;
  writeExclusive: typeof writeMarkerExclusive;
  preflight: typeof preflightProjectDirectory;
}

const DEFAULT_DEPS: ProjectCreationDeps = {
  sessionId: () => crypto.randomUUID(),
  writeExclusive: writeMarkerExclusive,
  preflight: preflightProjectDirectory,
};

export function validateMode(args: ProjectCreationArgs): 'bound' | 'memory-only' {
  const hasPath = args.path !== undefined;
  const isMemoryOnly = args.memoryOnly === true;

  if (hasPath === isMemoryOnly) {
    throw new Error(MODE_ERROR);
  }

  return isMemoryOnly ? 'memory-only' : 'bound';
}

export function canonicalDirectory(directory: string): string {
  if (directory.startsWith('~') || directory.includes('$')) {
    throw new Error(`Project path must not use home or environment shorthand: ${directory}`);
  }
  if (!path.isAbsolute(directory)) {
    throw new Error(`Project path must be absolute: ${directory}`);
  }

  const canonical = fs.realpathSync(directory);
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`Project path must be a directory: ${directory}`);
  }
  if (canonical === fs.realpathSync(os.homedir())) {
    throw new Error('The home directory cannot be bound as a project directory');
  }

  return canonical;
}

export function preflightProjectDirectory(directory: string): void {
  const probe = path.join(directory, `.tim-write-probe.${process.pid}.${crypto.randomUUID()}`);
  let created = false;
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
    created = true;
  } finally {
    if (created) fs.rmSync(probe);
  }
}

export async function createProjectCoordinated(
  store: TimStore,
  args: ProjectCreationArgs,
  deps: Partial<ProjectCreationDeps> = {},
): Promise<ProjectCreationResult> {
  const runtime = { ...DEFAULT_DEPS, ...deps };
  const mode = validateMode(args);

  if (mode === 'memory-only') {
    if (args.metadata && Object.prototype.hasOwnProperty.call(args.metadata, 'path')) {
      throw new Error('metadata.path is service-owned and cannot be supplied in memory-only mode');
    }
    const entry = await store.createProject(args.label, {
      content: args.content,
      metadata: args.metadata,
      aliases: args.aliases,
    });
    return { ...entry, mode };
  }

  const projectPath = canonicalDirectory(args.path!);
  const markerPath = projectMarkerPath(projectPath);
  if (fs.existsSync(markerPath)) {
    throw new Error(`A target-local project marker already exists at ${markerPath}`);
  }
  runtime.preflight(projectPath);
  throw new Error(`Bound project creation requires verified marker publication at ${projectPath}`);
}
