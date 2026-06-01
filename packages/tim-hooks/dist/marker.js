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
exports.LOCK_TTL_MS = exports.MARKER_LOCK = exports.MARKER_FILENAME = void 0;
exports.markerPath = markerPath;
exports.readMarker = readMarker;
exports.writeMarker = writeMarker;
exports.detectProject = detectProject;
exports.reconcileMarker = reconcileMarker;
exports.acquireLock = acquireLock;
exports.releaseLock = releaseLock;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tim_store_1 = require("tim-store");
exports.MARKER_FILENAME = '.tim-project';
exports.MARKER_LOCK = '.tim-project.lock';
function markerPath(cwd) {
    return path.join(cwd, exports.MARKER_FILENAME);
}
function readMarker(cwd) {
    const p = markerPath(cwd);
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
function writeMarker(cwd, marker) {
    fs.writeFileSync(markerPath(cwd), JSON.stringify(marker, null, 2));
}
/** Project detection — v1: .tim-project marker only. */
function detectProject(cwd) {
    return readMarker(cwd);
}
/** Re-derive counters from the DB and persist them into the marker. */
async function reconcileMarker(store, cwd) {
    const marker = readMarker(cwd);
    if (!marker)
        throw new Error(`No ${exports.MARKER_FILENAME} in ${cwd}`);
    const { exchangeCount, batchesSummarized } = await (0, tim_store_1.deriveCounters)(store, marker.session);
    const reconciled = {
        ...marker,
        exchanges: exchangeCount,
        batches_summarized: batchesSummarized,
    };
    writeMarker(cwd, reconciled);
    return reconciled;
}
exports.LOCK_TTL_MS = 10 * 60_000;
function acquireLock(cwd) {
    const lock = path.join(cwd, exports.MARKER_LOCK);
    try {
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
        return true;
    }
    catch {
        try {
            const raw = JSON.parse(fs.readFileSync(lock, 'utf8'));
            if (Date.now() - raw.ts > exports.LOCK_TTL_MS) {
                fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
                return true;
            }
        }
        catch {
            /* unreadable lock → treat as held */
        }
        return false;
    }
}
function releaseLock(cwd) {
    try {
        fs.rmSync(path.join(cwd, exports.MARKER_LOCK), { force: true });
    }
    catch {
        /* ignore */
    }
}
//# sourceMappingURL=marker.js.map