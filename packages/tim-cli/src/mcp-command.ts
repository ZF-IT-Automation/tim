import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TimMcpServerOptions {
  override?: string;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Resolve the built tim-mcp server before any host configuration is changed. */
export function resolveTimMcpServerPath(options: TimMcpServerOptions = {}): string {
  const override = options.override ?? process.env.TIM_MCP_SERVER;
  if (override) {
    const resolved = path.resolve(override);
    if (!isFile(resolved)) {
      throw new Error(`TIM MCP server artifact not found: ${resolved}`);
    }
    return resolved;
  }

  // This layout is shared by the monorepo and installed sibling packages:
  // packages/tim-cli/dist -> packages/tim-mcp/dist
  // node_modules/tim-cli/dist -> node_modules/tim-mcp/dist
  const sibling = path.resolve(__dirname, '..', '..', 'tim-mcp', 'dist', 'server.js');
  if (isFile(sibling)) return sibling;

  throw new Error(
    `TIM MCP server artifact not found: ${sibling}. Build or install tim-mcp, or set TIM_MCP_SERVER.`,
  );
}
