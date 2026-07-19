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
exports.buildMigrateFromHmemPlan = buildMigrateFromHmemPlan;
exports.evaluateDryRunGate = evaluateDryRunGate;
exports.buildImportAuditArgs = buildImportAuditArgs;
exports.listHmemImportedProjectLabels = listHmemImportedProjectLabels;
exports.collectMigrationProjectBindings = collectMigrationProjectBindings;
exports.formatMigrationBindingLines = formatMigrationBindingLines;
exports.cmdMigrateFromHmem = cmdMigrateFromHmem;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const tim_core_1 = require("tim-core");
const tim_store_1 = require("tim-store");
const tim_migrate_1 = require("tim-migrate");
const tim_hooks_1 = require("tim-hooks");
const snapshot_js_1 = require("./snapshot.js");
const args_js_1 = require("./args.js");
function buildMigrateFromHmemPlan(source, opts = {}) {
    const deduplicate = opts.deduplicate !== false;
    return [
        { id: 'manifest', description: `Inspect ${source}` },
        { id: 'dry-run', description: `Import dry-run with deduplicate=${deduplicate}` },
        { id: 'snapshot', description: 'Create TIM snapshot before writing' },
        { id: 'import', description: 'Run live import' },
        { id: 'audit', description: 'Run import audit and print repair suggestions' },
        { id: 'doctor', description: 'Run TIM doctor' },
        { id: 'bindings', description: 'Report per-imported-project binding state on this device' },
        { id: 'handoff', description: 'Print source, snapshot, counts, warnings, next steps' },
    ];
}
function evaluateDryRunGate(report) {
    const blockers = [];
    if (report.format === 'unknown') {
        blockers.push('Dry-run could not identify the source hmem format.');
    }
    for (const warning of report.warnings) {
        blockers.push(`Dry-run warning: ${warning}`);
    }
    return blockers;
}
function buildImportAuditArgs(source) {
    return { source, includeRepairPlan: true };
}
/** Labels for project roots imported from hmem (metadata.hmemUid present). */
async function listHmemImportedProjectLabels(store) {
    const labels = [];
    for (const row of await store.listProjects()) {
        const entry = await store.read(row.id);
        if (!entry || entry.metadata.kind !== 'project')
            continue;
        if (entry.metadata.hmemUid)
            labels.push(row.label);
    }
    return labels.sort();
}
/** Binding findings for hmem-imported projects only — reuses doctor classification. */
async function collectMigrationProjectBindings(store) {
    const importedLabels = new Set(await listHmemImportedProjectLabels(store));
    const { projects } = await (0, tim_hooks_1.collectBindingReport)(store);
    return projects.filter(project => importedLabels.has(project.label));
}
function formatMigrationBindingLines(findings) {
    return findings.map(finding => (0, tim_hooks_1.formatBindingFindingLine)(finding).trimStart());
}
function getDbPath(config) {
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
function resolveDeduplicate(flags) {
    if (flags['no-deduplicate'] === 'true')
        return false;
    if (flags.deduplicate === 'false')
        return false;
    return true;
}
async function cmdMigrateFromHmem(args) {
    const { flags, positional } = (0, args_js_1.parseArgs)(args, {
        valueOptions: (0, args_js_1.valueOptionsFor)('migrate-from-hmem'),
    });
    const sourcePath = positional[0];
    if (!sourcePath) {
        console.error('Usage: tim migrate-from-hmem <path.hmem> [--deduplicate] [--no-deduplicate] [--dry-run]');
        process.exit(1);
    }
    if (!fs.existsSync(sourcePath)) {
        console.error(`hmem source not found: ${sourcePath}`);
        process.exit(1);
    }
    const dryRunOnly = flags['dry-run'] === 'true';
    const deduplicate = resolveDeduplicate(flags);
    const config = (0, tim_core_1.loadConfig)();
    const dbPath = getDbPath(config);
    const manifest = (0, tim_migrate_1.inspectHmemManifest)(sourcePath);
    const plan = buildMigrateFromHmemPlan(sourcePath, { deduplicate });
    let store = new tim_store_1.TimStore(dbPath);
    let dryRunReport;
    try {
        dryRunReport = (0, tim_migrate_1.tim_import)(store, sourcePath, { dryRun: true, deduplicate });
    }
    finally {
        store.close();
    }
    const dryRunBlockers = evaluateDryRunGate(dryRunReport);
    if (dryRunOnly) {
        console.log(JSON.stringify({
            sourcePath,
            dbPath,
            dryRun: true,
            deduplicate,
            plan: plan.filter(step => step.id === 'manifest' || step.id === 'dry-run' || step.id === 'handoff'),
            manifest,
            dryRunReport,
            dryRunBlockers,
            nextSteps: [
                'Run without --dry-run to snapshot the TIM database and import.',
                'After live import, run MCP tool tim_import_audit for structure verification.',
            ],
        }, null, 2));
        return;
    }
    if (dryRunBlockers.length > 0) {
        console.error(JSON.stringify({
            sourcePath,
            dbPath,
            dryRun: false,
            blocked: true,
            manifest,
            dryRunReport,
            blockers: dryRunBlockers,
            nextSteps: [
                'Resolve the dry-run blockers or inspect the source .hmem before retrying.',
                'Run with --dry-run to review the full manifest and dry-run report without writing.',
            ],
        }, null, 2));
        process.exit(1);
    }
    const snapshot = await (0, snapshot_js_1.runSnapshot)({ dbPath, quiet: true });
    if (!snapshot.ok) {
        console.error(`snapshot failed before import: ${snapshot.error}`);
        process.exit(1);
    }
    store = new tim_store_1.TimStore(dbPath);
    try {
        const importReport = (0, tim_migrate_1.tim_import)(store, sourcePath, { deduplicate });
        const health = await store.health();
        const bindingFindings = await collectMigrationProjectBindings(store);
        const bindingLines = formatMigrationBindingLines(bindingFindings);
        const warnings = [
            ...dryRunReport.warnings,
            ...importReport.warnings,
            ...health.issues,
        ];
        console.log(JSON.stringify({
            sourcePath,
            dbPath,
            dryRun: false,
            deduplicate,
            plan,
            manifest,
            snapshot,
            dryRunReport,
            importReport,
            doctor: {
                status: health.status,
                blockers: health.blockers,
                warnings: health.warnings,
                totalEntries: health.totalEntries,
                brokenLinks: health.brokenLinks,
                orphanEntries: health.orphanEntries,
                ftsIntegrity: health.ftsIntegrity,
            },
            bindings: {
                projects: bindingFindings,
                lines: bindingLines,
            },
            audit: {
                tool: 'tim_import_audit',
                args: buildImportAuditArgs(sourcePath),
                guidance: 'Run the MCP tool after import. If it reports WARNING/BLOCKER, apply the repairPlan manually or with an explicit follow-up.',
            },
            warnings,
            nextSteps: [
                'Run MCP tool tim_import_audit with includeRepairPlan=true.',
                'Review imported project roots and O-entry nesting against docs/hmem-to-tim-migration.md.',
                'For each imported project: bind via `tim bind-project --label P#### --cwd <dir>` (ask the user when metadata.path is absent) or record it as intentionally memory-only; never hand-write `.tim-project`.',
                'Run tim doctor again after binding or any manual repair.',
            ],
        }, null, 2));
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=migrate-from-hmem.js.map