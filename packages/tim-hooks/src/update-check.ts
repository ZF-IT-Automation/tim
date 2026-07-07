import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig } from 'tim-core';

const ONE_DAY_MS = 86_400_000;
const PACKAGE_NAME = 'tim-mcp';
const DEFAULT_FETCH_TIMEOUT_MS = 3000;
const DEFAULT_BRIEFING_TIMEOUT_MS = 500;

function timMcpPackagePath(): string {
  return join(__dirname, '..', '..', 'tim-mcp', 'package.json');
}

function installedVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(timMcpPackagePath(), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function fetchLatestVersion(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

export async function getUpdateCheckLine(options: { fetchTimeoutMs?: number } = {}): Promise<string | null> {
  const config = loadConfig();
  if (config.updateCheck === false) return null;
  const lastAt = config.updateCheckLastAt;
  if (lastAt && Date.now() - new Date(lastAt).getTime() < ONE_DAY_MS) return null;
  const latest = await fetchLatestVersion(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  saveConfig({ ...loadConfig(), updateCheckLastAt: new Date().toISOString() });
  if (!latest) return null;
  const installed = installedVersion();
  if (latest === installed) return null;
  return `TIM ${latest} available (installed: ${installed}) — npm i -g ${PACKAGE_NAME}`;
}

export async function getUpdateCheckLineBriefing(): Promise<string | null> {
  return raceWithTimeout(getUpdateCheckLine(), DEFAULT_BRIEFING_TIMEOUT_MS);
}
