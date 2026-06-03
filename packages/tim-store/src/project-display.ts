import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';

const PROJECT_SUMMARY_MARKER = '## Project Summary';

function parseHeaderTitle(title: string, content: string): string {
  const combined = content ? `${title}\n${content}` : title;
  const parts = combined.split('|').map(p => p.trim());
  return (parts[0] || title).trim();
}

function stripLabelPrefix(name: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name.replace(new RegExp(`^${escaped}\\s*[—\\-–:]\\s*`, 'i'), '').trim();
}

/** Human project name from a P-entry (without P-label prefix when duplicated in title). */
export function projectDisplayNameFromEntry(entry: Entry): string {
  const label = String(entry.metadata.label ?? entry.id).trim();
  const contentForParse = entry.content.split(PROJECT_SUMMARY_MARKER)[0].trimEnd();
  let name = parseHeaderTitle(entry.title, contentForParse);
  name = stripLabelPrefix(name, label);
  if (!name) {
    const first = entry.content.split('\n')[0]?.trim() || entry.title.trim();
    name = stripLabelPrefix(first, label);
  }
  return name || label;
}

/** Crop for status bar / narrow UI (default 20 chars, ellipsis included in limit). */
export function cropDisplayName(text: string, maxLen = 20): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  if (maxLen <= 1) return t.slice(0, maxLen);
  return `${t.slice(0, maxLen - 1)}…`;
}

export async function resolveProjectDisplayName(
  store: TimStore,
  query: string,
  maxLen = 20,
): Promise<string> {
  const q = query.trim();
  if (!q) return cropDisplayName('no project', maxLen);

  const resolved = await store.resolveProjectLabel(q);
  if (resolved.status !== 'found') {
    return cropDisplayName(q, maxLen);
  }

  const entry = await store.read(resolved.label);
  if (!entry || entry.metadata.kind !== 'project') {
    return cropDisplayName(q, maxLen);
  }

  return cropDisplayName(projectDisplayNameFromEntry(entry), maxLen);
}
