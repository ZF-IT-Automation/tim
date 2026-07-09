export type AgentHost = 'claude' | 'codex' | 'cursor' | 'hermes';
export interface SetupAgentStep {
    id: 'mcp' | 'skills' | 'hooks' | 'smoke';
    description: string;
}
export declare function buildSetupAgentPlan(opts: {
    host: AgentHost;
}): SetupAgentStep[];
export declare function buildCodexMcpConfig(dbPath: string): string;
export declare function replaceCodexTimMcpBlock(existing: string, block: string): string;
export declare function cmdSetupAgent(args: string[]): Promise<void>;
//# sourceMappingURL=setup-agent.d.ts.map