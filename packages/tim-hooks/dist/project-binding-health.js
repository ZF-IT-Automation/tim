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
exports.bindingDeviceId = bindingDeviceId;
exports.classifyProjectPathBinding = classifyProjectPathBinding;
exports.collectBindingReport = collectBindingReport;
exports.formatBindingFindingLine = formatBindingFindingLine;
exports.formatStalePathLine = formatStalePathLine;
exports.formatBindOutcomeLine = formatBindOutcomeLine;
exports.bindUnboundBindings = bindUnboundBindings;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const tim_store_1 = require("tim-store");
const marker_js_1 = require("./marker.js");
const project_creation_js_1 = require("./project-creation.js");
function bindingDeviceId() {
    return os.hostname();
}
/** Classify a project's on-disk binding from store metadata.path. */
function classifyProjectPathBinding(label, projectPath) {
    if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
        return { status: 'no-path' };
    }
    const resolved = path.resolve(projectPath);
    if (!fs.existsSync(resolved)) {
        return { status: 'path-missing' };
    }
    const marker = (0, marker_js_1.readMarker)(resolved);
    if (!marker) {
        return { status: 'unbound' };
    }
    if (marker.project === label) {
        return { status: 'bound' };
    }
    return { status: 'label-mismatch', markerLabel: marker.project };
}
async function collectBindingReport(store) {
    const projects = [];
    const stalePaths = [];
    const device = bindingDeviceId();
    const now = Date.now();
    for (const row of await store.listProjects()) {
        const entry = await store.read(row.id);
        if (!entry || entry.metadata.kind !== 'project')
            continue;
        const projectPath = typeof entry.metadata.path === 'string' ? entry.metadata.path : undefined;
        const classification = classifyProjectPathBinding(row.label, projectPath);
        projects.push({
            label: row.label,
            path: projectPath,
            ...classification,
        });
        for (const pathRow of await (0, tim_store_1.listProjectPathRows)(store, row.label)) {
            if (pathRow.metadata.device !== device)
                continue;
            if (!(0, tim_store_1.isStalePathRow)(pathRow, now, tim_store_1.DEFAULT_STALE_PATH_MAX_AGE_DAYS))
                continue;
            const inventoryPath = typeof pathRow.metadata.path === 'string' ? pathRow.metadata.path : '';
            stalePaths.push({
                label: row.label,
                path: inventoryPath,
                device,
                lastSeenAt: typeof pathRow.metadata.last_seen_at === 'string'
                    ? pathRow.metadata.last_seen_at
                    : undefined,
            });
        }
    }
    projects.sort((a, b) => a.label.localeCompare(b.label));
    stalePaths.sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
    return { projects, stalePaths };
}
function formatBindingFindingLine(finding) {
    switch (finding.status) {
        case 'no-path':
            return `  ${finding.label} no-path`;
        case 'path-missing':
            return `  ${finding.label} ${finding.path} path-missing`;
        case 'label-mismatch':
            return `  ${finding.label} ${finding.path} label-mismatch (marker ${finding.markerLabel})`;
    }
    return `  ${finding.label} ${finding.path} ${finding.status}`;
}
function formatStalePathLine(finding) {
    const seen = finding.lastSeenAt ?? 'unknown';
    return `  stale ${finding.label} ${finding.path} (${finding.device}, last seen ${seen})`;
}
function formatBindOutcomeLine(outcome) {
    if (outcome.outcome === 'failed') {
        return `  ${outcome.label}: failed (${outcome.detail ?? 'unknown error'})`;
    }
    return `  ${outcome.label}: ${outcome.outcome}`;
}
async function bindUnboundBindings(store, findings, deps = {}) {
    const outcomes = [];
    for (const finding of findings) {
        if (finding.status !== 'unbound' || !finding.path)
            continue;
        try {
            const result = await (0, project_creation_js_1.recoverProjectBinding)(store, { label: finding.label, path: finding.path }, deps);
            outcomes.push({
                label: finding.label,
                outcome: result.alreadyBound ? 'already-bound' : 'bound',
            });
        }
        catch (error) {
            outcomes.push({
                label: finding.label,
                outcome: 'failed',
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return outcomes;
}
//# sourceMappingURL=project-binding-health.js.map