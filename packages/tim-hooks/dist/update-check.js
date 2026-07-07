"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUpdateCheckLine = getUpdateCheckLine;
exports.getUpdateCheckLineBriefing = getUpdateCheckLineBriefing;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tim_core_1 = require("tim-core");
const ONE_DAY_MS = 86_400_000;
const PACKAGE_NAME = 'tim-mcp';
const DEFAULT_FETCH_TIMEOUT_MS = 3000;
const DEFAULT_BRIEFING_TIMEOUT_MS = 500;
function timMcpPackagePath() {
    return (0, node_path_1.join)(__dirname, '..', '..', 'tim-mcp', 'package.json');
}
function installedVersion() {
    try {
        const pkg = JSON.parse((0, node_fs_1.readFileSync)(timMcpPackagePath(), 'utf8'));
        return pkg.version ?? '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
async function fetchLatestVersion(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { signal: controller.signal });
        if (!res.ok)
            return null;
        const data = await res.json();
        return data.version ?? null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
function raceWithTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        promise.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
}
async function getUpdateCheckLine(options = {}) {
    const config = (0, tim_core_1.loadConfig)();
    if (config.updateCheck === false)
        return null;
    const lastAt = config.updateCheckLastAt;
    if (lastAt && Date.now() - new Date(lastAt).getTime() < ONE_DAY_MS)
        return null;
    const latest = await fetchLatestVersion(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    (0, tim_core_1.saveConfig)({ ...(0, tim_core_1.loadConfig)(), updateCheckLastAt: new Date().toISOString() });
    if (!latest)
        return null;
    const installed = installedVersion();
    if (latest === installed)
        return null;
    return `TIM ${latest} available (installed: ${installed}) — npm i -g ${PACKAGE_NAME}`;
}
async function getUpdateCheckLineBriefing() {
    return raceWithTimeout(getUpdateCheckLine(), DEFAULT_BRIEFING_TIMEOUT_MS);
}
//# sourceMappingURL=update-check.js.map