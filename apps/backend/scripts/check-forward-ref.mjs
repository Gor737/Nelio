#!/usr/bin/env node
// CI text search (roadmap M3, Decision 104): `forwardRef` is banned. Circular Nest dependencies are solved by moving
// the dependency (docs/architecture.md section 5), never by forwardRef.
// Usage: node scripts/check-forward-ref.mjs [directory]   (default: src)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'src';
const hits = [];

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/\bforwardRef\b/.test(line))
            hits.push(`${path}:${index + 1}: ${line.trim()}`);
        });
    }
  }
};

walk(root);

if (hits.length > 0) {
  console.error(
    `forwardRef is not allowed (${hits.length} occurrence${hits.length === 1 ? '' : 's'}):\n${hits.join('\n')}`,
  );
  process.exit(1);
}
console.log(`no forwardRef found in ${root}`);
