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

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function monorepoSiblingServer(): string | undefined {
  const cliPackageDir = path.resolve(__dirname, '..');
  const rootDir = path.resolve(cliPackageDir, '..', '..');
  const expectedCliDir = path.join(rootDir, 'packages', 'tim-cli');
  const expectedMcpDir = path.join(rootDir, 'packages', 'tim-mcp');
  if (cliPackageDir !== expectedCliDir) return undefined;

  const rootPackage = readJson(path.join(rootDir, 'package.json'));
  const cliPackage = readJson(path.join(expectedCliDir, 'package.json'));
  const mcpPackage = readJson(path.join(expectedMcpDir, 'package.json'));
  const workspaceValue = rootPackage?.workspaces;
  const workspaces = Array.isArray(workspaceValue)
    ? workspaceValue
    : workspaceValue && typeof workspaceValue === 'object'
      ? (workspaceValue as { packages?: unknown }).packages
      : undefined;

  if (
    rootPackage?.name !== 'tim' ||
    rootPackage.private !== true ||
    !Array.isArray(workspaces) ||
    !workspaces.includes('packages/tim-cli') ||
    !workspaces.includes('packages/tim-mcp') ||
    cliPackage?.name !== 'tim-cli' ||
    mcpPackage?.name !== 'tim-mcp'
  ) {
    return undefined;
  }
  return path.join(expectedMcpDir, 'dist', 'server.js');
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

  const sibling = monorepoSiblingServer();
  const candidates = [sibling, packaged].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find(isFile);
  if (found) return path.resolve(found);

  throw new Error(
    `TIM MCP server artifact not found: ${candidates.join(', ')}. Build or install tim-mcp, or set TIM_MCP_SERVER.`,
  );
}
