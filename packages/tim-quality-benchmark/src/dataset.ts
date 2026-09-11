import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DatasetFixture } from './types.js';
import { DATASET_VERSION } from './types.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveDatasetPath(): string {
  const distPath = path.join(PKG_ROOT, 'dist', 'dataset', `${DATASET_VERSION}.json`);
  const srcPath = path.join(PKG_ROOT, 'src', 'dataset', `${DATASET_VERSION}.json`);
  if (existsSync(distPath)) return distPath;
  return srcPath;
}

export function loadDataset(): DatasetFixture {
  const datasetPath = resolveDatasetPath();
  const raw = JSON.parse(readFileSync(datasetPath, 'utf8')) as DatasetFixture;
  if (raw.schemaVersion !== DATASET_VERSION) {
    throw new Error(`Unsupported dataset schema ${raw.schemaVersion}; expected ${DATASET_VERSION}`);
  }
  return raw;
}
