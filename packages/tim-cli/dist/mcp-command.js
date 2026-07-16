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
exports.resolveTimMcpServerPath = resolveTimMcpServerPath;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_module_1 = require("node:module");
function isFile(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    }
    catch {
        return false;
    }
}
/** Resolve the built tim-mcp server before any host configuration is changed. */
function resolveTimMcpServerPath(options = {}) {
    const override = options.override ?? process.env.TIM_MCP_SERVER;
    if (override) {
        const resolved = path.resolve(override);
        if (!isFile(resolved)) {
            throw new Error(`TIM MCP server artifact not found: ${resolved}`);
        }
        return resolved;
    }
    let packaged;
    try {
        packaged = (0, node_module_1.createRequire)(__filename).resolve('tim-mcp/dist/server.js');
    }
    catch {
        // Fall through to the sibling layout used by workspace/package installs.
    }
    const sibling = path.resolve(__dirname, '..', '..', 'tim-mcp', 'dist', 'server.js');
    const candidates = [sibling, packaged].filter((candidate) => Boolean(candidate));
    const found = candidates.find(isFile);
    if (found)
        return path.resolve(found);
    throw new Error(`TIM MCP server artifact not found: ${candidates.join(', ')}. Build or install tim-mcp, or set TIM_MCP_SERVER.`);
}
//# sourceMappingURL=mcp-command.js.map