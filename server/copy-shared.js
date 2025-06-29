// server/copy-shared.js
import { mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';

function copyRecursive(src, dest) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stats = statSync(srcPath);

    if (stats.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
}

copyRecursive('../shared', './shared');
console.log('✅ Copied shared/ to server/shared/');
