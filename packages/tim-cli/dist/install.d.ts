import { type TimMcpServerOptions } from './mcp-command.js';
export interface HostTool {
    id: string;
    name: string;
    detect: () => boolean;
    mcpConfigPath: (global: boolean) => string;
    format: 'standard' | 'opencode';
}
export declare const HOST_TOOLS: HostTool[];
export declare function detectInstalledHosts(): HostTool[];
export interface McpServerEntry {
    command: string;
    args: string[];
    env?: Record<string, string>;
}
export declare function buildTimMcpEntry(dbPath: string, options?: TimMcpServerOptions): McpServerEntry;
export declare function mergeMcpConfig(existing: Record<string, unknown>, entry: McpServerEntry, format: 'standard' | 'opencode'): Record<string, unknown>;
export declare function installMcpForHosts(dbPath: string, global?: boolean, options?: TimMcpServerOptions): {
    installed: {
        tool: string;
        path: string;
    }[];
    skipped: {
        tool: string;
        path: string;
        reason: string;
    }[];
};
export declare function installMcpEntryForHosts(entry: McpServerEntry, global?: boolean): {
    installed: {
        tool: string;
        path: string;
    }[];
    skipped: {
        tool: string;
        path: string;
        reason: string;
    }[];
};
export declare function installMcpForHostTool(tool: HostTool, dbPath: string, global?: boolean, options?: TimMcpServerOptions): {
    installed: {
        tool: string;
        path: string;
    }[];
    skipped: {
        tool: string;
        path: string;
        reason: string;
    }[];
};
//# sourceMappingURL=install.d.ts.map