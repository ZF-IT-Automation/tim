import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

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

  let packaged: string | undefined;
  try {
    packaged = createRequire(__filename).resolve('tim-mcp/dist/server.js');
  } catch {
    // Fall through to the sibling layout used by workspace/package installs.
  }

  const sibling = path.resolve(__dirname, '..', '..', 'tim-mcp', 'dist', 'server.js');
  const candidates = [sibling, packaged].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find(isFile);
  if (found) return path.resolve(found);

  throw new Error(
    `TIM MCP server artifact not found: ${candidates.join(', ')}. Build or install tim-mcp, or set TIM_MCP_SERVER.`,
  );
}
