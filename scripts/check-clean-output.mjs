import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

const packages = await readdir('packages', { withFileTypes: true });
const leftovers = [];

for (const pkg of packages) {
  if (!pkg.isDirectory()) continue;
  for (const relative of ['dist', 'tsconfig.tsbuildinfo']) {
    const candidate = path.join('packages', pkg.name, relative);
    try {
      await access(candidate);
      leftovers.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

if (leftovers.length > 0) {
  throw new Error(`Clean left generated state behind:\n${leftovers.join('\n')}`);
}

console.log('Clean removed dist directories and TypeScript build caches.');
