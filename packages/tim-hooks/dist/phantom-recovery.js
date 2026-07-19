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
exports.repairPhantomProjectBinding = repairPhantomProjectBinding;
exports.stripUnboundProjectSuffix = stripUnboundProjectSuffix;
exports.formatUnboundProjectLabel = formatUnboundProjectLabel;
exports.isUnboundProjectLabel = isUnboundProjectLabel;
exports.markerWithRepairedProject = markerWithRepairedProject;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const marker_js_1 = require("./marker.js");
function readTimJsonProjectLabel(dir) {
    const filePath = path.join(dir, marker_js_1.CANONICAL_PROJECT_FILENAME);
    if (!fs.existsSync(filePath))
        return null;
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const label = raw.project;
        return typeof label === 'string' && (0, marker_js_1.validateProjectLabel)(label) ? label : null;
    }
    catch {
        return null;
    }
}
async function labelIfValidProject(store, label) {
    const validated = await (0, marker_js_1.validateMarkerAgainstStore)({ version: 3, project: label }, store);
    return validated?.project ?? null;
}
/**
 * Attempt to recover a real project label when `.tim-project` points at a
 * phantom (pattern-valid label missing from the DB).
 */
async function repairPhantomProjectBinding(store, dir) {
    const resolvedDir = path.resolve(dir);
    const fromTimJson = readTimJsonProjectLabel(resolvedDir);
    if (fromTimJson) {
        const label = await labelIfValidProject(store, fromTimJson);
        if (label)
            return label;
    }
    const byPath = await store.findProjectByPath(resolvedDir);
    if (byPath && byPath.metadata.kind === 'project' && !byPath.irrelevant) {
        const label = typeof byPath.metadata.label === 'string'
            ? byPath.metadata.label
            : byPath.id;
        return label;
    }
    const alias = path.basename(resolvedDir).toLowerCase();
    if (alias) {
        const resolved = await store.resolveProjectLabel(alias);
        if (resolved.status === 'found') {
            const entry = await store.read(resolved.label);
            if (entry?.metadata.kind === 'project' && !entry.irrelevant) {
                return resolved.label;
            }
        }
        // ambiguous → leave unrepaired (caller must not mint another contested alias)
    }
    return null;
}
/** Strip trailing `?` from statusline unbound display labels. */
function stripUnboundProjectSuffix(label) {
    return label.endsWith('?') ? label.slice(0, -1) : label;
}
function formatUnboundProjectLabel(label) {
    return label.endsWith('?') ? label : `${label}?`;
}
function isUnboundProjectLabel(label) {
    return label.endsWith('?');
}
function markerWithRepairedProject(marker, recoveredLabel) {
    return { ...marker, project: recoveredLabel };
}
//# sourceMappingURL=phantom-recovery.js.map