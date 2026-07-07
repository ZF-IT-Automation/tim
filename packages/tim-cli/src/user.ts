import { TimStore, ensureHumanProfile, getHumanProfileSummary } from 'tim-store';
import { loadConfig } from 'tim-core';
import * as os from 'node:os';
import * as path from 'node:path';

function getDbPath(): string {
  const config = loadConfig();
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

export async function cmdUserInit(): Promise<void> {
  const store = new TimStore(getDbPath());
  try {
    const profile = await ensureHumanProfile(store);
    console.log(`✓ Human profile ready: ${profile.root.title}`);
    for (const s of profile.sections) {
      console.log(`  - ${s.title}`);
    }
  } finally {
    store.close();
  }
}

export async function cmdUserProfile(): Promise<void> {
  const store = new TimStore(getDbPath());
  try {
    const summary = await getHumanProfileSummary(store);
    console.log(summary);
  } finally {
    store.close();
  }
}

export async function cmdUpdateSkills(): Promise<void> {
  const { updateSkills } = await import('./update-skills.js');
  const result = updateSkills();
  for (const c of result.copied) {
    console.log(`✓ ${c.skill} → ${c.target}`);
  }
  for (const s of result.skipped) {
    console.log(`⊘ ${s}`);
  }
}
