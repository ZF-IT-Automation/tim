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
exports.updateSkills = updateSkills;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const install_js_1 = require("./install.js");
function updateSkills() {
    const srcRoot = (() => {
        const candidates = [
            path.join(process.cwd(), 'packages', 'tim-skills', 'skills'),
            path.join(__dirname, '..', '..', 'tim-skills', 'skills'),
            path.join(__dirname, '..', 'skills'),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c))
                return c;
        }
        throw new Error('Bundled skills directory not found');
    })();
    const skillNames = fs.readdirSync(srcRoot).filter(name => {
        const p = path.join(srcRoot, name);
        return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'));
    });
    const copied = [];
    const skipped = [];
    for (const tool of install_js_1.HOST_TOOLS) {
        if (!tool.detect())
            continue;
        const skillsBase = tool.id === 'claude-code'
            ? path.join(process.env.HOME ?? '', '.claude', 'skills')
            : tool.id === 'opencode'
                ? path.join(process.env.HOME ?? '', '.config', 'opencode', 'skills')
                : null;
        if (!skillsBase) {
            skipped.push(`${tool.name} (no skills dir)`);
            continue;
        }
        if (!fs.existsSync(skillsBase))
            fs.mkdirSync(skillsBase, { recursive: true });
        for (const name of skillNames) {
            const from = path.join(srcRoot, name);
            const to = path.join(skillsBase, name);
            fs.cpSync(from, to, { recursive: true });
            copied.push({ skill: name, target: to });
        }
    }
    if (copied.length === 0 && skipped.length === 0) {
        skipped.push('No supported hosts detected');
    }
    return { copied, skipped };
}
//# sourceMappingURL=update-skills.js.map