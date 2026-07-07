import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig } from 'tim-core';

const ONE_DAY_MS = 86_400_000;
const PACKAGE_NAME = 'tim-mcp';

function installedVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Throttled npm registry check (max 1×/day). One briefing line when newer
 * version exists. Silent skip on network error or when disabled.
 */
export async function getUpdateCheckLine(): Promise<string | null> {
  const config = loadConfig();
  if (config.updateCheck === false) return null;

  const lastAt = config.updateCheckLastAt;
  if (lastAt && Date.now() - new Date(lastAt).getTime() < ONE_DAY_MS) {
    return null;
  }

  const latest = await fetchLatestVersion();
  saveConfig({ ...loadConfig(), updateCheckLastAt: new Date().toISOString() });

  if (!latest) return null;

  const installed = installedVersion();
  if (latest === installed) return null;

  return `TIM ${latest} available (installed: ${installed}) — npm i -g ${PACKAGE_NAME}`;
}
