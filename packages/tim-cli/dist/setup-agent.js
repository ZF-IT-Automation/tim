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
exports.buildSetupAgentPlan = buildSetupAgentPlan;
exports.buildCodexMcpConfig = buildCodexMcpConfig;
exports.replaceCodexTimMcpBlock = replaceCodexTimMcpBlock;
exports.installCodexMcpConfig = installCodexMcpConfig;
exports.cmdSetupAgent = cmdSetupAgent;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const tim_core_1 = require("tim-core");
const tim_store_1 = require("tim-store");
const install_js_1 = require("./install.js");
const update_skills_js_1 = require("./update-skills.js");
const hermes_statusline_install_js_1 = require("./hermes-statusline-install.js");
function buildSetupAgentPlan(opts) {
    assertAgentHost(opts.host);
    return [
        { id: 'mcp', description: `Install MCP config for ${opts.host}` },
        { id: 'skills', description: `Install TIM skills for ${opts.host}` },
        { id: 'hooks', description: `Install supported hooks/statusline for ${opts.host}` },
        { id: 'smoke', description: 'Run tim doctor and MCP smoke guidance' },
    ];
}
function assertAgentHost(host) {
    if (!['claude', 'codex', 'cursor', 'hermes'].includes(host)) {
        throw new Error(`unsupported host: ${host}`);
    }
}
function parseArgs(args) {
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith('--'))
            continue;
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
            parsed[key] = next;
            i++;
        }
        else {
            parsed[key] = 'true';
        }
    }
    return parsed;
}
function getDbPath(config) {
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
function hostTool(host) {
    const id = host === 'claude' ? 'claude-code' : host === 'cursor' ? 'cursor' : null;
    return id ? (install_js_1.HOST_TOOLS.find(tool => tool.id === id) ?? null) : null;
}
function tomlString(value) {
    return JSON.stringify(value).replace(/\u007f/g, '\\u007F');
}
function findOutsideTomlQuotes(value, needle) {
    let quote = null;
    let escaped = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (quote === '"') {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                quote = null;
            continue;
        }
        if (quote === "'") {
            if (char === "'")
                quote = null;
            continue;
        }
        if (char === '"' || char === "'")
            quote = char;
        else if (char === needle)
            return i;
    }
    return -1;
}
function withoutTomlComment(line) {
    const comment = findOutsideTomlQuotes(line, '#');
    return comment < 0 ? line : line.slice(0, comment);
}
function findMultilineClose(line, delimiter, start) {
    let index = line.indexOf(delimiter, start);
    while (index >= 0 && delimiter === '"""') {
        let backslashes = 0;
        for (let i = index - 1; i >= 0 && line[i] === '\\'; i--)
            backslashes++;
        if (backslashes % 2 === 0)
            return index;
        index = line.indexOf(delimiter, index + delimiter.length);
    }
    return index;
}
function findMultilineOpen(line) {
    let quote = null;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quote === '"') {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                quote = null;
            continue;
        }
        if (quote === "'") {
            if (char === "'")
                quote = null;
            continue;
        }
        if (char === '#')
            return null;
        if (line.startsWith('"""', i))
            return { index: i, delimiter: '"""' };
        if (line.startsWith("'''", i))
            return { index: i, delimiter: "'''" };
        if (char === '"' || char === "'")
            quote = char;
    }
    return null;
}
function scanTomlStructuralLine(line, state) {
    if (state.multiline) {
        const close = findMultilineClose(line, state.multiline, 0);
        if (close >= 0)
            state.multiline = null;
        return { structural: null, openedMultiline: false, closedMultiline: close >= 0 };
    }
    const opening = findMultilineOpen(line);
    if (!opening)
        return { structural: line, openedMultiline: false, closedMultiline: false };
    const close = findMultilineClose(line, opening.delimiter, opening.index + opening.delimiter.length);
    if (close < 0)
        state.multiline = opening.delimiter;
    return {
        structural: line.slice(0, opening.index),
        openedMultiline: close < 0,
        closedMultiline: close >= 0,
    };
}
function normalizeTomlKeySegment(segment) {
    const value = segment.trim();
    if (/^[A-Za-z0-9_-]+$/.test(value))
        return value;
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        return value.slice(1, -1).includes("'") ? null : value.slice(1, -1);
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        try {
            return JSON.parse(value);
        }
        catch {
            return null;
        }
    }
    return null;
}
function normalizeTomlKeyPath(source) {
    const segments = [];
    let rest = source;
    while (rest.length > 0) {
        const dot = findOutsideTomlQuotes(rest, '.');
        const raw = dot < 0 ? rest : rest.slice(0, dot);
        const segment = normalizeTomlKeySegment(raw);
        if (segment === null)
            return null;
        segments.push(segment);
        if (dot < 0)
            break;
        rest = rest.slice(dot + 1);
    }
    return segments.length > 0 ? segments : null;
}
function tomlHeaderPath(line) {
    const value = withoutTomlComment(line).trim();
    const arrayTable = value.startsWith('[[') && value.endsWith(']]');
    if (!arrayTable && !(value.startsWith('[') && value.endsWith(']')))
        return null;
    const inner = arrayTable ? value.slice(2, -2) : value.slice(1, -1);
    return normalizeTomlKeyPath(inner);
}
function isTimTable(path) {
    return path[0] === 'mcp_servers' && path[1] === 'tim' && (path.length === 2 || (path.length === 3 && path[2] === 'env'));
}
function tomlAssignmentPath(line) {
    const value = withoutTomlComment(line);
    const equals = findOutsideTomlQuotes(value, '=');
    return equals < 0 ? null : normalizeTomlKeyPath(value.slice(0, equals));
}
function isTopLevelTimAssignment(path) {
    return Boolean(path && path[0] === 'mcp_servers' && path[1] === 'tim');
}
function buildCodexMcpConfig(dbPath, options = {}) {
    const entry = (0, install_js_1.buildTimMcpEntry)(dbPath, options);
    return [
        '[mcp_servers.tim]',
        `command = ${tomlString(entry.command)}`,
        `args = [${entry.args.map(arg => tomlString(arg)).join(', ')}]`,
        '',
        '[mcp_servers.tim.env]',
        `TIM_DB_PATH = ${tomlString(dbPath)}`,
    ].join('\n');
}
function replaceCodexTimMcpBlock(existing, block) {
    const lines = existing.split(/\r?\n/);
    const out = [];
    const scanState = { multiline: null };
    let atTopLevel = true;
    let inTimTable = false;
    let droppingTimMultiline = false;
    for (const line of lines) {
        const scanned = scanTomlStructuralLine(line, scanState);
        if (droppingTimMultiline) {
            if (scanned.closedMultiline)
                droppingTimMultiline = false;
            continue;
        }
        if (scanned.structural === null) {
            if (!inTimTable)
                out.push(line);
            continue;
        }
        const header = tomlHeaderPath(scanned.structural);
        if (header) {
            atTopLevel = false;
            inTimTable = isTimTable(header);
            if (!inTimTable)
                out.push(line);
            continue;
        }
        if (inTimTable) {
            if (line.trim() === '' || line.trimStart().startsWith('#'))
                out.push(line);
            continue;
        }
        if (atTopLevel) {
            const assignment = tomlAssignmentPath(scanned.structural);
            if (assignment?.length === 1 && assignment[0] === 'mcp_servers') {
                throw new Error('Unsupported top-level mcp_servers assignment; cannot safely merge TIM MCP configuration.');
            }
            if (isTopLevelTimAssignment(assignment)) {
                droppingTimMultiline = scanned.openedMultiline;
                continue;
            }
        }
        out.push(line);
    }
    const preserved = out.join('\n').trimEnd();
    return `${preserved}${preserved ? '\n\n' : ''}${block.trimEnd()}\n`;
}
function installCodexMcpConfig(dbPath, configPath = path.join(os.homedir(), '.codex', 'config.toml'), options = {}) {
    const block = buildCodexMcpConfig(dbPath, options);
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const next = replaceCodexTimMcpBlock(existing, block);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, `${configPath}.backup.${Date.now()}`);
    }
    fs.writeFileSync(configPath, next);
    return { installed: [{ tool: 'Codex', path: configPath }], skipped: [] };
}
async function cmdSetupAgent(args) {
    const flags = parseArgs(args);
    const host = flags.host;
    if (!host) {
        console.error('Usage: tim setup-agent --host claude|codex|cursor|hermes [--dry-run]');
        process.exit(1);
    }
    try {
        assertAgentHost(host);
    }
    catch (e) {
        console.error(e.message);
        console.error('Usage: tim setup-agent --host claude|codex|cursor|hermes [--dry-run]');
        process.exit(1);
    }
    const dryRun = flags['dry-run'] === 'true';
    const dbPath = getDbPath((0, tim_core_1.loadConfig)());
    const plan = buildSetupAgentPlan({ host });
    const tool = hostTool(host);
    if (dryRun) {
        console.log(JSON.stringify({
            host,
            dryRun: true,
            dbPath,
            plan,
            mcp: tool
                ? { action: 'would-install', tool: tool.name, path: tool.mcpConfigPath(true) }
                : host === 'codex'
                    ? { action: 'would-install-toml', path: path.join(os.homedir(), '.codex', 'config.toml'), snippet: buildCodexMcpConfig(dbPath) }
                    : { action: 'manual', reason: 'No JSON MCP installer exists for this host yet' },
            skills: { action: host === 'cursor' ? 'manual' : 'would-copy' },
            hooks: { action: host === 'hermes' ? 'would-install-hermes-statusline' : 'not-required' },
            smoke: { action: 'would-run-health-check', command: 'tim doctor' },
        }, null, 2));
        return;
    }
    const mcp = tool
        ? (0, install_js_1.installMcpForHostTool)(tool, dbPath, true)
        : host === 'codex'
            ? installCodexMcpConfig(dbPath)
            : {
                installed: [],
                skipped: [{
                        tool: host,
                        path: '',
                        reason: 'No MCP installer exists for this host yet',
                    }],
            };
    const skills = (0, update_skills_js_1.updateSkillsForHost)(host);
    const hooks = host === 'hermes'
        ? await (0, hermes_statusline_install_js_1.installHermesStatusline)({ skipBuild: true })
        : { ok: true, steps: [{ step: 'hooks', status: 'skip', detail: 'No host hook install needed' }] };
    const store = new tim_store_1.TimStore(dbPath);
    try {
        const health = await store.health();
        console.log(JSON.stringify({
            host,
            dryRun: false,
            dbPath,
            plan,
            mcp,
            skills,
            hooks,
            smoke: {
                status: health.status,
                blockers: health.blockers,
                warnings: health.warnings,
                totalEntries: health.totalEntries,
                ftsIntegrity: health.ftsIntegrity,
            },
            nextSteps: [
                'Restart the agent host so MCP config and skills are reloaded.',
                'Run the tim-mcp-smoke skill or call tim_stats through MCP.',
            ],
        }, null, 2));
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=setup-agent.js.map