"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectCreationPartialFailureError = exports.MODE_ERROR = void 0;
exports.validateMode = validateMode;
exports.canonicalDirectory = canonicalDirectory;
exports.preflightProjectDirectory = preflightProjectDirectory;
exports.createProjectCoordinated = createProjectCoordinated;
exports.recoverProjectBinding = recoverProjectBinding;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const marker_js_1 = require("./marker.js");
exports.MODE_ERROR = 'Exactly one creation mode is required. Pass an absolute project path for a repository/workspace, or memoryOnly: true only when no directory should be bound.';
class ProjectCreationPartialFailureError extends Error {
    createdLabel;
    projectPath;
    constructor(message, createdLabel, projectPath) {
        super(message);
        this.createdLabel = createdLabel;
        this.projectPath = projectPath;
        this.name = 'ProjectCreationPartialFailureError';
    }
}
exports.ProjectCreationPartialFailureError = ProjectCreationPartialFailureError;
const DEFAULT_DEPS = {
    sessionId: () => crypto.randomUUID(),
    writeExclusive: marker_js_1.writeMarkerExclusive,
    preflight: preflightProjectDirectory,
};
function validateMode(args) {
    const hasPath = typeof args.path === 'string' && args.path.length > 0;
    const isMemoryOnly = args.memoryOnly === true;
    if (hasPath === isMemoryOnly) {
        throw new Error(exports.MODE_ERROR);
    }
    if (isMemoryOnly && args.metadata && Object.prototype.hasOwnProperty.call(args.metadata, 'path')) {
        throw new Error('metadata.path is service-owned and cannot be supplied in memory-only mode');
    }
    return isMemoryOnly ? 'memory-only' : 'bound';
}
function canonicalDirectory(directory) {
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
function preflightProjectDirectory(directory) {
    const probe = path.join(directory, `.tim-write-probe.${process.pid}.${crypto.randomUUID()}`);
    let ownsProbe = false;
    try {
        fs.writeFileSync(probe, '', { flag: 'wx' });
        ownsProbe = true;
    }
    finally {
        if (ownsProbe)
            fs.rmSync(probe, { force: true });
    }
}
const UNKNOWN_LOCAL_MARKER = Symbol('unknown-local-marker');
function localMarkerLabel(projectPath) {
    const marker = (0, marker_js_1.markerPath)(projectPath);
    let markerStat;
    try {
        markerStat = fs.lstatSync(marker);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        return UNKNOWN_LOCAL_MARKER;
    }
    if (markerStat.isSymbolicLink()) {
        try {
            markerStat = fs.statSync(marker);
        }
        catch {
            return UNKNOWN_LOCAL_MARKER;
        }
    }
    if (!markerStat.isFile())
        return UNKNOWN_LOCAL_MARKER;
    return (0, marker_js_1.readMarker)(projectPath)?.project ?? UNKNOWN_LOCAL_MARKER;
}
function shellSingleQuote(value) {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
function markerInput(label, session) {
    return {
        project: label,
        session,
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
    };
}
function recoveryCommand(label, projectPath) {
    return `tim bind-project --label ${shellSingleQuote(label)} --cwd ${shellSingleQuote(projectPath)}`;
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function targetMarkerConflict(markerPath, label) {
    const owner = label === UNKNOWN_LOCAL_MARKER ? 'an unknown or corrupt marker' : `project ${label}`;
    return new Error(`A target-local project marker already exists at ${markerPath} and belongs to ${owner}. ` +
        'Remove it only if it is stale, or explicitly reconcile/rebind this directory before creating a project.');
}
function publicationFailure(label, projectPath, reason) {
    return new ProjectCreationPartialFailureError(`Project ${label} was created in the database, but its local marker was not published or verified at ${projectPath}: ${reason}. ` +
        `Recover the binding with: ${recoveryCommand(label, projectPath)}`, label, projectPath);
}
function publicationRace(requested, winner, projectPath) {
    const winnerText = winner === UNKNOWN_LOCAL_MARKER ? 'an unknown or corrupt marker' : `project ${winner}`;
    return new ProjectCreationPartialFailureError(`Project ${requested} was created in the database, but ${winnerText} won marker publication at ${projectPath}. ` +
        `The existing marker was preserved. Explicit reconciliation is required between the requested project ${requested} and the marker winner; do not overwrite the marker.`, requested, projectPath);
}
async function createProjectCoordinated(store, args, deps = {}) {
    const runtime = {
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
    const projectPath = canonicalDirectory(args.path);
    if (!(0, marker_js_1.validateProjectLabel)(args.label)) {
        throw new Error(`Invalid project label for a bound project: ${args.label}`);
    }
    const markerPath = (0, marker_js_1.markerPath)(projectPath);
    const existing = localMarkerLabel(projectPath);
    if (existing !== null) {
        throw new Error(`${targetMarkerConflict(markerPath, existing).message} Requested project: ${args.label}.`);
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
    }
    catch (error) {
        const winner = localMarkerLabel(projectPath);
        if (winner !== null && winner !== args.label) {
            throw publicationRace(args.label, winner, projectPath);
        }
        if (winner !== args.label) {
            throw publicationFailure(args.label, projectPath, errorText(error));
        }
    }
    const verified = localMarkerLabel(projectPath);
    if (verified !== args.label) {
        if (verified !== null)
            throw publicationRace(args.label, verified, projectPath);
        throw publicationFailure(args.label, projectPath, 'the marker is absent after publication');
    }
    return { ...entry, mode, projectPath, markerPath };
}
async function recoverProjectBinding(store, args, deps = {}) {
    const runtime = {
        sessionId: deps.sessionId ?? DEFAULT_DEPS.sessionId,
        writeExclusive: deps.writeExclusive ?? DEFAULT_DEPS.writeExclusive,
        preflight: deps.preflight ?? DEFAULT_DEPS.preflight,
    };
    const projectPath = canonicalDirectory(args.path);
    const markerPath = (0, marker_js_1.markerPath)(projectPath);
    const resolved = await store.resolveProjectLabel(args.label);
    if (resolved.status !== 'found' || resolved.label !== args.label) {
        throw new Error(`Live project label not found: ${args.label}`);
    }
    const existing = localMarkerLabel(projectPath);
    if (existing === args.label) {
        return { label: args.label, projectPath, markerPath, alreadyBound: true };
    }
    if (existing !== null) {
        throw new Error(`${targetMarkerConflict(markerPath, existing).message} Requested project: ${args.label}.`);
    }
    runtime.preflight(projectPath);
    try {
        runtime.writeExclusive(projectPath, markerInput(args.label, args.sessionId ?? runtime.sessionId()));
    }
    catch (error) {
        const winner = localMarkerLabel(projectPath);
        if (winner === args.label) {
            return { label: args.label, projectPath, markerPath, alreadyBound: true };
        }
        if (winner !== null) {
            throw new Error(`${targetMarkerConflict(markerPath, winner).message} Requested project: ${args.label}.`);
        }
        throw new Error(`Could not recover project binding for ${args.label} at ${projectPath}: ${errorText(error)}`);
    }
    const verified = localMarkerLabel(projectPath);
    if (verified !== args.label) {
        if (verified !== null) {
            throw new Error(`${targetMarkerConflict(markerPath, verified).message} Requested project: ${args.label}.`);
        }
        throw new Error(`Could not verify recovered project binding for ${args.label} at ${projectPath}`);
    }
    return { label: args.label, projectPath, markerPath, alreadyBound: false };
}
//# sourceMappingURL=project-creation.js.map