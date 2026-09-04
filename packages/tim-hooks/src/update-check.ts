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

/** Numeric + prerelease compare — no external semver dependency. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number, string] => {
    const main = v.split('-')[0] ?? '0.0.0';
    const prerelease = v.includes('-') ? v.slice(v.indexOf('-') + 1) : '';
    const parts = main.split('.').map((n) => Number(n));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, prerelease];
  };

  const [aMaj, aMin, aPat, aPre] = parse(a);
  const [bMaj, bMin, bPat, bPre] = parse(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  if (aPre === bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  const aBeta = aPre.match(/^beta\.(\d+)$/);
  const bBeta = bPre.match(/^beta\.(\d+)$/);
  if (aBeta && bBeta) {
    const aN = Number(aBeta[1]);
    const bN = Number(bBeta[1]);
    if (aN !== bN) return aN < bN ? -1 : 1;
    return 0;
  }
  return aPre < bPre ? -1 : 1;
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
  if (compareVersions(latest, installed) <= 0) return null;
  return `TIM ${latest} available (installed: ${installed}) — npm i -g ${PACKAGE_NAME}`;
}

export async function getUpdateCheckLineBriefing(): Promise<string | null> {
  return raceWithTimeout(getUpdateCheckLine(), DEFAULT_BRIEFING_TIMEOUT_MS);
}
