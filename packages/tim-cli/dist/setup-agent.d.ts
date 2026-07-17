import type { TimMcpServerOptions } from './mcp-command.js';
export type AgentHost = 'claude' | 'codex' | 'cursor' | 'hermes';
export interface SetupAgentStep {
    id: 'mcp' | 'skills' | 'hooks' | 'smoke';
    description: string;
}
export declare function buildSetupAgentPlan(opts: {
    host: AgentHost;
}): SetupAgentStep[];
export declare function buildCodexMcpConfig(dbPath: string, options?: TimMcpServerOptions): string;
export declare function replaceCodexTimMcpBlock(existing: string, block: string): string;
export declare function installCodexMcpConfig(dbPath: string, configPath?: string, options?: TimMcpServerOptions): {
    installed: {
        tool: string;
        path: string;
    }[];
    skipped: never[];
};
export declare function cmdSetupAgent(args: string[]): Promise<void>;
//# sourceMappingURL=setup-agent.d.ts.map