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
function buildCodexMcpConfig(dbPath) {
    const entry = (0, install_js_1.buildTimMcpEntry)(dbPath);
    return [
        '[mcp_servers.tim]',
        `command = "${entry.command}"`,
        `args = [${entry.args.map(arg => `"${arg}"`).join(', ')}]`,
        '',
        '[mcp_servers.tim.env]',
        `TIM_DB_PATH = "${dbPath}"`,
    ].join('\n');
}
function replaceCodexTimMcpBlock(existing, block) {
    const lines = existing.split(/\r?\n/);
    const out = [];
    let replaced = false;
    for (let i = 0; i < lines.length;) {
        const trimmed = lines[i].trim();
        if (trimmed === '[mcp_servers.tim]') {
            if (out.length > 0 && out[out.length - 1] !== '')
                out.push('');
            out.push(...block.split('\n'));
            replaced = true;
            i++;
            while (i < lines.length) {
                const t = lines[i].trim();
                if (t.startsWith('[') && t !== '[mcp_servers.tim]' && t !== '[mcp_servers.tim.env]') {
                    if (out[out.length - 1] !== '')
                        out.push('');
                    break;
                }
                i++;
            }
            continue;
        }
        out.push(lines[i]);
        i++;
    }
    if (!replaced) {
        if (out.length > 0 && out[out.length - 1] !== '')
            out.push('');
        out.push(...block.split('\n'));
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
function installCodexMcpConfig(dbPath, configPath = path.join(os.homedir(), '.codex', 'config.toml')) {
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const next = replaceCodexTimMcpBlock(existing, buildCodexMcpConfig(dbPath));
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