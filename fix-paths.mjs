import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SRC = 'src';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'web']);

function walkAll(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) results.push(...walkAll(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

const files = walkAll(SRC);
let totalFixed = 0;

for (const filePath of files) {
  let content = readFileSync(filePath, 'utf-8');
  let changed = false;

  // Fix 1: ../core/providers/ -> ../providers/ (providers is at src/providers/, not src/core/providers/)
  // Also handles ../../core/providers/ -> ../../providers/
  {
    const regex = /((?:from|import|export)\s+['"])(\.\.?\/(?:\.\.\/)*)core\/providers\//g;
    const newContent = content.replace(regex, '$1$2providers/');
    if (newContent !== content) {
      content = newContent;
      changed = true;
    }
  }

  // Fix 2: Also handle dynamic import() and type import() patterns for core/providers
  {
    const regex = /(import\s*\(\s*['"])(\.\.?\/(?:\.\.\/)*)core\/providers\//g;
    const newContent = content.replace(regex, '$1$2providers/');
    if (newContent !== content) {
      content = newContent;
      changed = true;
    }
  }

  // Fix 3: Config.js -> config.js (case fix for remaining references)
  // These appear in _require() calls and inline import() type annotations
  {
    const regex = /Config\.js/g;
    const newContent = content.replace(regex, 'config.js');
    if (newContent !== content) {
      content = newContent;
      changed = true;
    }
  }

  // Fix 4: FallbackProvider.js -> fallback-provider.js (in import() type annotations)
  // Already handled by the main script, but catch any remaining
  {
    const regex = /FallbackProvider\.js/g;
    const newContent = content.replace(regex, 'fallback-provider.js');
    if (newContent !== content) {
      content = newContent;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(filePath, content, 'utf-8');
    totalFixed++;
    console.log(`Fixed: ${filePath}`);
  }
}

console.log(`\nTotal files fixed: ${totalFixed}`);
