import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Entry } from 'tim-core';
import { TimStore } from 'tim-store';
import {
  readMarker,
  markerPath as projectMarkerPath,
  validateProjectLabel,
  writeMarkerExclusive,
} from './marker.js';

export const MODE_ERROR = 'Exactly one creation mode is required. Pass an absolute project path for a repository/workspace, or memoryOnly: true only when no directory should be bound.';

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

export type ProjectCreationResult =
  | MemoryOnlyProjectCreationResult
  | BoundProjectCreationResult;

export interface ProjectCreationDeps {
  sessionId: () => string;
  writeExclusive: typeof writeMarkerExclusive;
  preflight: typeof preflightProjectDirectory;
}

export interface RecoverProjectBindingArgs {
  label: string;
  path: string;
  sessionId?: string;
}

export interface RecoverProjectBindingResult {
  label: string;
  projectPath: string;
  markerPath: string;
  alreadyBound: boolean;
}

export class ProjectCreationPartialFailureError extends Error {
  constructor(
    message: string,
    public readonly createdLabel: string,
    public readonly projectPath: string,
  ) {
    super(message);
    this.name = 'ProjectCreationPartialFailureError';
  }
}

const DEFAULT_DEPS: ProjectCreationDeps = {
  sessionId: () => crypto.randomUUID(),
  writeExclusive: writeMarkerExclusive,
  preflight: preflightProjectDirectory,
};

export function validateMode(args: ProjectCreationArgs): 'bound' | 'memory-only' {
  const hasPath = typeof args.path === 'string' && args.path.length > 0;
  const isMemoryOnly = args.memoryOnly === true;

  if (hasPath === isMemoryOnly) {
    throw new Error(MODE_ERROR);
  }
  if (isMemoryOnly && args.metadata && Object.prototype.hasOwnProperty.call(args.metadata, 'path')) {
    throw new Error('metadata.path is service-owned and cannot be supplied in memory-only mode');
  }

  return isMemoryOnly ? 'memory-only' : 'bound';
}

export function canonicalDirectory(directory: string): string {
  const environmentShorthand = /\$(?:\{|[A-Za-z_])|%[A-Za-z_][A-Za-z0-9_]*%/;
  if (directory.startsWith('~') || environmentShorthand.test(directory)) {
    throw new Error(`Project path must not use home or environment shorthand: ${directory}`);
  }
  if (!path.isAbsolute(directory)) {
    throw new Error(`Pass an absolute project path; received: ${directory}`);
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
  let ownsProbe = false;
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
    ownsProbe = true;
  } finally {
    if (ownsProbe) fs.rmSync(probe, { force: true });
  }
}

const UNKNOWN_LOCAL_MARKER = Symbol('unknown-local-marker');
type LocalMarkerLabel = string | null | typeof UNKNOWN_LOCAL_MARKER;

function localMarkerLabel(projectPath: string): LocalMarkerLabel {
  const marker = projectMarkerPath(projectPath);
  let markerStat: fs.Stats;
  try {
    markerStat = fs.lstatSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return UNKNOWN_LOCAL_MARKER;
  }
  if (markerStat.isSymbolicLink()) {
    try {
      markerStat = fs.statSync(marker);
    } catch {
      return UNKNOWN_LOCAL_MARKER;
    }
  }
  if (!markerStat.isFile()) return UNKNOWN_LOCAL_MARKER;
  return readMarker(projectPath)?.project ?? UNKNOWN_LOCAL_MARKER;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function markerInput(label: string, session: string) {
  return {
    project: label,
    session,
    exchanges: 0,
    batch_size: 5,
    batches_summarized: 0,
  };
}

function recoveryCommand(databasePath: string, label: string, projectPath: string): string {
  return `TIM_DB_PATH=${shellSingleQuote(databasePath)} tim bind-project --label ${shellSingleQuote(label)} --cwd ${shellSingleQuote(projectPath)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetMarkerConflict(markerPath: string, label: LocalMarkerLabel): Error {
  const owner = label === UNKNOWN_LOCAL_MARKER ? 'an unknown or corrupt marker' : `project ${label}`;
  return new Error(
    `A target-local project marker already exists at ${markerPath} and belongs to ${owner}. ` +
      'Remove it only if it is stale, or explicitly reconcile/rebind this directory before creating a project.',
  );
}

function publicationFailure(
  databasePath: string,
  label: string,
  projectPath: string,
  reason: string,
): ProjectCreationPartialFailureError {
  return new ProjectCreationPartialFailureError(
    `Project ${label} was created in the database, but its local marker was not published or verified at ${projectPath}: ${reason}. ` +
      `Recover the binding with: ${recoveryCommand(databasePath, label, projectPath)}`,
    label,
    projectPath,
  );
}

function publicationRace(
  requested: string,
  winner: Exclude<LocalMarkerLabel, null>,
  projectPath: string,
): ProjectCreationPartialFailureError {
  const winnerText = winner === UNKNOWN_LOCAL_MARKER ? 'an unknown or corrupt marker' : `project ${winner}`;
  return new ProjectCreationPartialFailureError(
    `Project ${requested} was created in the database, but ${winnerText} won marker publication at ${projectPath}. ` +
      `The existing marker was preserved. Explicit reconciliation is required between the requested project ${requested} and the marker winner; do not overwrite the marker.`,
    requested,
    projectPath,
  );
}

export async function createProjectCoordinated(
  store: TimStore,
  args: ProjectCreationArgs,
  deps: Partial<ProjectCreationDeps> = {},
): Promise<ProjectCreationResult> {
  const runtime: ProjectCreationDeps = {
    sessionId: deps.sessionId ?? DEFAULT_DEPS.sessionId,
    writeExclusive: deps.writeExclusive ?? DEFAULT_DEPS.writeExclusive,
    preflight: deps.preflight ?? DEFAULT_DEPS.preflight,
  };
  const mode = validateMode(args);

  if (mode === 'memory-only') {
    const entry = await store.createProject(args.label, {
      content: args.content,
      metadata: args.metadata,
      aliases: args.aliases,
    });
    return { ...entry, mode };
  }

  if (store.getDatabasePath() === ':memory:') {
    throw new Error(
      'Bound projects require a persistent database. Configure TIM_DB_PATH to a filesystem database, ' +
        'then retry; use memoryOnly:true only for an intentionally virtual project.',
    );
  }

  const projectPath = canonicalDirectory(args.path!);
  if (!validateProjectLabel(args.label)) {
    throw new Error(`Invalid project label for a bound project: ${args.label}`);
  }
  const markerPath = projectMarkerPath(projectPath);
  const existing = localMarkerLabel(projectPath);
  if (existing !== null) {
    throw new Error(
      `${targetMarkerConflict(markerPath, existing).message} Requested project: ${args.label}.`,
    );
  }
  runtime.preflight(projectPath);

  const resolved = await store.resolveProjectLabel(args.label);
  if (resolved.status !== 'not_found') {
    const detail = resolved.status === 'found'
      ? resolved.label === args.label
        ? 'already exists'
        : `already resolves to project ${resolved.label}`
      : 'has an ambiguous project-label conflict';
    throw new Error(`Project label ${args.label} ${detail}`);
  }

  const entry = await store.createProject(args.label, {
    content: args.content,
    metadata: { ...(args.metadata ?? {}), path: projectPath },
    aliases: args.aliases,
  });

  try {
    runtime.writeExclusive(projectPath, markerInput(args.label, runtime.sessionId()));
  } catch (error) {
    const winner = localMarkerLabel(projectPath);
    if (winner !== null && winner !== args.label) {
      throw publicationRace(args.label, winner, projectPath);
    }
    if (winner !== args.label) {
      throw publicationFailure(store.getDatabasePath(), args.label, projectPath, errorText(error));
    }
  }

  const verified = localMarkerLabel(projectPath);
  if (verified !== args.label) {
    if (verified !== null) throw publicationRace(args.label, verified, projectPath);
    throw publicationFailure(
      store.getDatabasePath(),
      args.label,
      projectPath,
      'the marker is absent after publication',
    );
  }

  return { ...entry, mode, projectPath, markerPath };
}

export async function recoverProjectBinding(
  store: TimStore,
  args: RecoverProjectBindingArgs,
  deps: Partial<ProjectCreationDeps> = {},
): Promise<RecoverProjectBindingResult> {
  const runtime: ProjectCreationDeps = {
    sessionId: deps.sessionId ?? DEFAULT_DEPS.sessionId,
    writeExclusive: deps.writeExclusive ?? DEFAULT_DEPS.writeExclusive,
    preflight: deps.preflight ?? DEFAULT_DEPS.preflight,
  };
  const projectPath = canonicalDirectory(args.path);
  const markerPath = projectMarkerPath(projectPath);
  const resolved = await store.resolveProjectLabel(args.label);
  if (resolved.status !== 'found' || resolved.label !== args.label) {
    throw new Error(`Live project label not found: ${args.label}`);
  }

  const existing = localMarkerLabel(projectPath);
  if (existing === args.label) {
    return { label: args.label, projectPath, markerPath, alreadyBound: true };
  }
  if (existing !== null) {
    throw new Error(
      `${targetMarkerConflict(markerPath, existing).message} Requested project: ${args.label}.`,
    );
  }

  runtime.preflight(projectPath);
  try {
    runtime.writeExclusive(
      projectPath,
      markerInput(args.label, args.sessionId ?? runtime.sessionId()),
    );
  } catch (error) {
    const winner = localMarkerLabel(projectPath);
    if (winner === args.label) {
      return { label: args.label, projectPath, markerPath, alreadyBound: true };
    }
    if (winner !== null) {
      throw new Error(
        `${targetMarkerConflict(markerPath, winner).message} Requested project: ${args.label}.`,
      );
    }
    throw new Error(`Could not recover project binding for ${args.label} at ${projectPath}: ${errorText(error)}`);
  }

  const verified = localMarkerLabel(projectPath);
  if (verified !== args.label) {
    if (verified !== null) {
      throw new Error(
        `${targetMarkerConflict(markerPath, verified).message} Requested project: ${args.label}.`,
      );
    }
    throw new Error(`Could not verify recovered project binding for ${args.label} at ${projectPath}`);
  }
  return { label: args.label, projectPath, markerPath, alreadyBound: false };
}
