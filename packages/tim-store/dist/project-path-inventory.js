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
exports.DEFAULT_STALE_PATH_MAX_AGE_DAYS = exports.KIND_PROJECT_PATH = void 0;
exports.listProjectPathRows = listProjectPathRows;
exports.upsertProjectPathRow = upsertProjectPathRow;
exports.isStalePathRow = isStalePathRow;
const path = __importStar(require("path"));
exports.KIND_PROJECT_PATH = 'project-path';
/** Default staleness threshold for project-path inventory rows (days). */
exports.DEFAULT_STALE_PATH_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** List all project-path inventory rows for a project. */
async function listProjectPathRows(store, projectId) {
    const project = await store.requireProject(projectId);
    return store.getChildByKind(project.id, exports.KIND_PROJECT_PATH);
}
/** Upsert a per-device path observation under the project root. */
async function upsertProjectPathRow(store, projectId, device, absPath) {
    const project = await store.requireProject(projectId);
    const resolvedPath = path.resolve(absPath);
    const now = new Date().toISOString();
    const existingRows = await listProjectPathRows(store, project.id);
    const match = existingRows.find(row => row.metadata.device === device &&
        typeof row.metadata.path === 'string' &&
        path.resolve(row.metadata.path) === resolvedPath);
    if (match) {
        return store.update(match.id, {
            metadata: { ...match.metadata, last_seen_at: now },
        });
    }
    return store.write(`${device}: ${resolvedPath}`, {
        parentId: project.id,
        metadata: {
            kind: exports.KIND_PROJECT_PATH,
            device,
            path: resolvedPath,
            last_seen_at: now,
        },
    });
}
/** True when last_seen_at is older than maxAgeDays (default 30). */
function isStalePathRow(row, now = Date.now(), maxAgeDays = exports.DEFAULT_STALE_PATH_MAX_AGE_DAYS) {
    const lastSeen = row.metadata.last_seen_at;
    if (typeof lastSeen !== 'string')
        return true;
    const ageMs = now - new Date(lastSeen).getTime();
    return ageMs > maxAgeDays * MS_PER_DAY;
}
//# sourceMappingURL=project-path-inventory.js.map