import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';

export const HUMAN_ROOT_LABEL = 'H0000';

export const HUMAN_SECTIONS = [
  'Identity',
  'Skills',
  'Preferences',
  'Context',
] as const;

export interface HumanProfileNode {
  root: Entry;
  sections: Entry[];
}

/** Ensure human profile root (H0000) and standard sections exist. */
export async function ensureHumanProfile(store: TimStore): Promise<HumanProfileNode> {
  let root = await store.read(HUMAN_ROOT_LABEL);
  if (!root) {
    root = await store.write('Structured knowledge about the human user.', {
      title: HUMAN_ROOT_LABEL,
      metadata: { kind: 'human', type: 'human-root', label: HUMAN_ROOT_LABEL },
      tags: ['#human'],
    });
  }

  const sections: Entry[] = [];
  for (const name of HUMAN_SECTIONS) {
    const existing = (await store.getChildren(root.id)).find(c => c.title === name);
    if (existing) {
      sections.push(existing);
      continue;
    }
    const section = await store.write(name, {
      parentId: root.id,
      title: name,
      metadata: { kind: 'human', section: name.toLowerCase() },
      tags: ['#human'],
    });
    sections.push(section);
  }

  return { root, sections };
}

export async function getHumanProfileSummary(store: TimStore): Promise<string> {
  const profile = await ensureHumanProfile(store);
  const lines = [`${profile.root.title} (${HUMAN_ROOT_LABEL})`];
  for (const section of profile.sections) {
    const children = await store.getChildren(section.id);
    lines.push(`  ${section.title}: ${children.length} entries`);
  }
  return lines.join('\n');
}
