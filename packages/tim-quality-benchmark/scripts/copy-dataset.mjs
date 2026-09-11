import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(pkgRoot, 'src', 'dataset');
const destDir = path.join(pkgRoot, 'dist', 'dataset');

fs.mkdirSync(destDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith('.json')) continue;
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}
