import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DatasetFixture } from './types.js';
import { DATASET_VERSION } from './types.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASET_PATH = path.join(PKG_ROOT, 'src', 'dataset', `${DATASET_VERSION}.json`);

export function loadDataset(): DatasetFixture {
  const raw = JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as DatasetFixture;
  if (raw.schemaVersion !== DATASET_VERSION) {
    throw new Error(`Unsupported dataset schema ${raw.schemaVersion}; expected ${DATASET_VERSION}`);
  }
  return raw;
}
