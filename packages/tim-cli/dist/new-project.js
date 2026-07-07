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
const ulid_1 = require("ulid");
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
function validatePath(targetPath) {
    if (!targetPath) {
        exitWith(1, 'Error: --path is required');
    }
    if (targetPath.startsWith('~') || targetPath.includes('$HOME')) {
        exitWith(1, `Error: Invalid --path: must be absolute path (got: ${targetPath})`);
    }
    if (!path.isAbsolute(targetPath)) {
        exitWith(1, `Error: Invalid --path: must be absolute path (got: ${targetPath})`);
    }
    const resolved = path.resolve(targetPath);
    if (resolved === path.resolve(os.homedir())) {
        exitWith(1, `Error: Invalid --path: refusing home directory (${resolved})`);
    }
}
function validateName(name) {
    if (!name?.trim()) {
        exitWith(1, 'Error: --name is required and must be non-empty');
    }
}
function isDupProjectError(err) {
    return err instanceof Error && /already exists/i.test(err.message);
}
function incrementLabel(label) {
    const num = parseInt(label.slice(1), 10);
    return `P${String(num + 1).padStart(4, '0')}`;
}
async function getNextProjectLabel(store) {
    const projects = await store.listProjects();
    let maxNum = 0;
    for (const p of projects) {
        const match = /^P(\d{4})$/.exec(p.label);
        if (!match)
            continue;
        const num = parseInt(match[1], 10);
        if (p.label === 'P0000' || p.label === 'P9999')
            continue;
        if (num > maxNum)
            maxNum = num;
    }
    return `P${String(maxNum + 1).padStart(4, '0')}`;
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
async function createProjectWithRetry(store, startLabel, name, targetPath) {
    let label = startLabel;
    let attempt = 0;
    while (attempt < 10) {
        try {
            const entry = await store.createProject(label, {
                content: name,
                metadata: { name, path: targetPath },
            });
            return { label, projectId: entry.id };
        }
        catch (err) {
            if (isDupProjectError(err)) {
                label = incrementLabel(label);
                attempt++;
                continue;
            }
            const msg = err instanceof Error ? err.message : String(err);
            exitWith(5, `Error: Failed to create project in database: ${msg}`);
        }
    }
    exitWith(5, `Error: Project label ${startLabel} already exists (race condition retry exhausted after 10 attempts)`);
}
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
async function cmdNewProject(args) {
    const flags = parseNewProjectArgs(args);
    if (flags.help === 'true') {
        console.log(`Usage: tim new-project --path <dir> --name <string> [--no-git] [--confirm]
       tim new-project -p <dir> -n <string> [--no-git] [--confirm]

Create a new TIM project, register it in the database, write .tim-project, and initialize standard sections.`);
        return;
    }
    const targetPath = path.resolve(flags.path ?? '');
    const name = flags.name ?? '';
    const noGit = flags['no-git'] === 'true';
    const confirm = flags.confirm === 'true';
    validatePath(flags.path ?? '');
    validateName(name);
    if (!fs.existsSync(targetPath)) {
        try {
            fs.mkdirSync(targetPath, { recursive: true });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            exitWith(3, `Error: mkdir failed: ${msg}`);
        }
    }
    const markerFile = path.join(targetPath, '.tim-project');
    if (fs.existsSync(markerFile)) {
        const existing = (0, tim_hooks_1.readMarker)(targetPath);
        const boundLabel = existing?.project ?? 'unknown';
        exitWith(1, `Error: Path already bound to ${boundLabel} — use \`tim bind-project --label <new-label> --cwd ${targetPath}\` to rebind, or remove \`.tim-project\` manually.`);
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
    let label;
    let projectId;
    try {
        const startLabel = await getNextProjectLabel(store);
        ({ label, projectId } = await createProjectWithRetry(store, startLabel, name.trim(), targetPath));
    }
    catch (err) {
        store.close();
        throw err;
    }
    try {
        (0, tim_hooks_1.writeMarker)(targetPath, {
            project: label,
            session: (0, ulid_1.ulid)(),
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: DB registered as ${label}, but .tim-project write failed: ${msg}. ` +
            `Run: tim bind-project --label ${label} --cwd ${targetPath}`);
        store.close();
        process.exit(1);
    }
    if (!fs.existsSync(markerFile)) {
        console.error(`Warning: DB registered as ${label}, but .tim-project write failed. ` +
            `Run: tim bind-project --label ${label} --cwd ${targetPath}`);
        store.close();
        process.exit(1);
    }
    await initProjectSchema(store, projectId);
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
    console.log(`✓ Created project ${label} "${name.trim()}" at ${targetPath}`);
    console.log(`✓ .tim-project written — next session in this dir binds to ${label}`);
    store.close();
}
//# sourceMappingURL=new-project.js.map