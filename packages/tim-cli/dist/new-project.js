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
exports.cmdNewProject = cmdNewProject;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const readline = __importStar(require("readline"));
const child_process_1 = require("child_process");
const tim_store_1 = require("tim-store");
const tim_core_1 = require("tim-core");
const tim_hooks_1 = require("tim-hooks");
const STANDARD_SECTIONS = [
    { label: 'Tasks', content: 'Actionable work items and open tasks' },
    { label: 'Ideas', content: 'Brainstorming and undecided proposals' },
    { label: 'Errors', content: 'Bug and error tracking' },
    { label: 'Decisions', content: 'Architecture and project decisions' },
    { label: 'Learnings', content: 'Lessons learned and pitfalls' },
    { label: 'Log', content: 'Project activity log and milestones' },
    { label: 'Testing', content: 'Test scenarios, test plans, coverage notes, and testing methodologies' },
];
function getDbPath() {
    const config = (0, tim_core_1.loadConfig)();
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
function parseNewProjectArgs(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-p' || arg === '--path') {
            const next = args[++i];
            if (next)
                flags.path = next;
        }
        else if (arg === '-n' || arg === '--name') {
            const next = args[++i];
            if (next)
                flags.name = next;
        }
        else if (arg === '--no-git') {
            flags['no-git'] = 'true';
        }
        else if (arg === '--confirm') {
            flags.confirm = 'true';
        }
        else if (arg === '-h' || arg === '--help') {
            flags.help = 'true';
        }
        else if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('-')) {
                flags[key] = next;
                i++;
            }
            else {
                flags[key] = 'true';
            }
        }
    }
    return flags;
}
function exitWith(code, message) {
    console.error(message);
    process.exit(code);
}
function validateName(name) {
    if (!name?.trim()) {
        exitWith(1, 'Error: --name is required and must be non-empty');
    }
}
function precheckNewProjectPath(requestedPath) {
    const environmentShorthand = /\$(?:\{|[A-Za-z_])|%[A-Za-z_][A-Za-z0-9_]*%/;
    if (requestedPath.startsWith('~') || environmentShorthand.test(requestedPath)) {
        exitWith(1, `Error: Invalid --path: home and environment shorthand are not supported (got: ${requestedPath})`);
    }
    if (!path.isAbsolute(requestedPath)) {
        exitWith(1, `Error: Invalid --path: must be absolute path (got: ${requestedPath})`);
    }
    const targetPath = path.resolve(requestedPath);
    if (targetPath === fs.realpathSync(os.homedir())) {
        exitWith(1, `Error: Invalid --path: refusing home directory (${targetPath})`);
    }
    if (!fs.existsSync(targetPath))
        return targetPath;
    const targetStat = fs.statSync(targetPath);
    if (!targetStat.isDirectory()) {
        exitWith(1, `Error: Invalid --path: existing target must be a directory (${targetPath})`);
    }
    if (fs.realpathSync(targetPath) === fs.realpathSync(os.homedir())) {
        exitWith(1, `Error: Invalid --path: refusing home directory (${targetPath})`);
    }
    const markerFile = path.join(targetPath, '.tim-project');
    try {
        fs.lstatSync(markerFile);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return targetPath;
        throw err;
    }
    const boundLabel = (0, tim_hooks_1.readMarker)(targetPath)?.project ?? 'unknown';
    exitWith(1, `Error: Path already bound to ${boundLabel}. tim bind-project is recovery-only and cannot replace a different marker. ` +
        'Inspect the existing binding, reconcile the database projects if necessary, and remove `.tim-project` only when it is confirmed stale; then retry tim new-project.');
}
function isDupProjectError(err) {
    if (!(err instanceof Error))
        return false;
    return /^Project label already exists: P\d{4}(?: \([^)]+\))?$/i.test(err.message) ||
        /^Project label P\d{4} (?:already exists|already resolves to project \S+|has an ambiguous project-label conflict)$/i.test(err.message);
}
/** Advance past a failed label. allocateNext alone can stick if the collision never persisted. */
function incrementLabel(label) {
    const num = parseInt(label.slice(1), 10);
    return `P${String(num + 1).padStart(4, '0')}`;
}
function nextLabelAfterCollision(store, failedLabel) {
    const incremented = incrementLabel(failedLabel);
    const allocated = store.allocateNextProjectLabel();
    const incNum = parseInt(incremented.slice(1), 10);
    const allocNum = parseInt(allocated.slice(1), 10);
    return Number.isFinite(allocNum) && allocNum > incNum ? allocated : incremented;
}
function countDirEntries(dir) {
    try {
        return fs.readdirSync(dir).filter(name => name !== '.git').length;
    }
    catch {
        return 0;
    }
}
async function promptContinue(fileCount, targetPath) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise(resolve => {
        rl.question(`⚠ Directory ${targetPath} is not empty (${fileCount} files).\n` +
            '  Continue anyway? Existing files will not be touched. [y/N]: ', ans => {
            rl.close();
            resolve(ans.trim());
        });
    });
    if (answer !== 'y' && answer !== 'Y') {
        exitWith(6, 'Aborted by user');
    }
}
async function createProjectWithRetry(store, startLabel, name, targetPath, deps) {
    let label = startLabel;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            const result = await deps.createProject(store, {
                label,
                path: targetPath,
                content: name,
                metadata: { name },
            });
            if (result.mode !== 'bound') {
                throw new Error('Coordinated project creation unexpectedly returned a memory-only project');
            }
            return result;
        }
        catch (err) {
            if (isDupProjectError(err)) {
                label = nextLabelAfterCollision(store, label);
                continue;
            }
            throw err;
        }
    }
    throw new Error(`Could not allocate a project label after 10 concurrent collisions starting at ${startLabel}. ` +
        'Retry tim new-project after the other project creations finish.');
}
const DEFAULT_NEW_PROJECT_DEPS = {
    createProject: tim_hooks_1.createProjectCoordinated,
};
async function initProjectSchema(store, projectId) {
    for (const section of STANDARD_SECTIONS) {
        try {
            await store.write(section.content, {
                parentId: projectId,
                metadata: { kind: 'section', label: section.label },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Warning: failed to create section ${section.label}: ${msg}`);
        }
    }
}
async function cmdNewProject(args, deps = DEFAULT_NEW_PROJECT_DEPS) {
    const flags = parseNewProjectArgs(args);
    if (flags.help === 'true') {
        console.log(`Usage: tim new-project --path <dir> --name <string> [--no-git] [--confirm]
       tim new-project -p <dir> -n <string> [--no-git] [--confirm]

Create a new TIM project, register it in the database, write .tim-project, and initialize standard sections.`);
        return;
    }
    const requestedPath = flags.path ?? '';
    const name = flags.name ?? '';
    const noGit = flags['no-git'] === 'true';
    const confirm = flags.confirm === 'true';
    if (!requestedPath) {
        exitWith(1, 'Error: --path is required');
    }
    validateName(name);
    const targetPath = precheckNewProjectPath(requestedPath);
    if (!fs.existsSync(targetPath)) {
        try {
            fs.mkdirSync(targetPath, { recursive: true });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            exitWith(3, `Error: mkdir failed: ${msg}`);
        }
    }
    const fileCount = countDirEntries(targetPath);
    if (fileCount > 0 && !confirm) {
        if (!process.stdin.isTTY) {
            exitWith(6, `Error: Directory ${targetPath} is not empty (${fileCount} files). Use --confirm to proceed non-interactively.`);
        }
        await promptContinue(fileCount, targetPath);
    }
    const dbPath = getDbPath();
    const store = new tim_store_1.TimStore(dbPath);
    let result;
    try {
        const startLabel = store.allocateNextProjectLabel();
        result = await createProjectWithRetry(store, startLabel, name.trim(), requestedPath, deps);
    }
    catch (err) {
        store.close();
        if (!(err instanceof tim_hooks_1.ProjectCreationPartialFailureError) &&
            err instanceof Error &&
            /target-local project marker already exists/i.test(err.message)) {
            throw new Error(`${err.message} tim bind-project is recovery-only and cannot replace a different marker. ` +
                'Inspect the existing binding, reconcile the database projects if necessary, and remove the marker only when it is confirmed stale; then retry tim new-project.');
        }
        if (err instanceof tim_hooks_1.ProjectCreationPartialFailureError)
            throw err;
        const msg = err instanceof Error ? err.message : String(err);
        exitWith(5, `Error: Failed to create project in database: ${msg}`);
    }
    await initProjectSchema(store, result.id);
    if (!noGit) {
        const gitDir = path.join(targetPath, '.git');
        if (fs.existsSync(gitDir)) {
            console.log('⊘ Git repo already initialized');
        }
        else {
            try {
                (0, child_process_1.execSync)('git init', { cwd: targetPath, stdio: 'pipe' });
                console.log('✓ Git repo initialized');
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`Warning: git init failed: ${msg}. DB + marker are in place — run 'cd ${targetPath} && git init' manually.`);
                store.close();
                process.exit(4);
            }
        }
    }
    else {
        console.log('⊘ Git init skipped (--no-git)');
    }
    const createdLabel = String(result.metadata.label);
    console.log(`✓ Created project ${createdLabel} "${name.trim()}" at ${result.projectPath}`);
    console.log(`✓ .tim-project written — next session in this dir binds to ${createdLabel}`);
    store.close();
}
//# sourceMappingURL=new-project.js.map