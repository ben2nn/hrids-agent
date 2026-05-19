import { readdirSync, statSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, basename, dirname, extname } from 'path';

const SRC = 'src';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'web']);

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) results.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

// Special cases: acronyms / proper nouns that should stay as one unit
const ACRONYM_OVERRIDES = { OpenAI: 'openai', Yaml: 'yaml' };

function pascalToKebab(name) {
  // Replace known acronyms before splitting
  let s = name;
  for (const [from, to] of Object.entries(ACRONYM_OVERRIDES)) {
    s = s.replace(new RegExp(from, 'g'), to);
  }
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

// Collect all .ts files, filter those needing rename
const allTs = walk(SRC);
const renameMap = new Map(); // oldPath -> newPath

for (const filePath of allTs) {
  const name = basename(filePath, '.ts');
  // Skip index.ts, already-kebab-case, and .tsx files
  if (name === 'index') continue;
  const kebab = pascalToKebab(name);
  if (kebab === name) continue; // already kebab-case

  const dir = dirname(filePath);
  const newPath = join(dir, kebab + '.ts');
  renameMap.set(filePath, newPath);
}

console.log(`Found ${renameMap.size} files to rename:`);
for (const [old, np] of renameMap) {
  console.log(`  ${old} -> ${basename(np)}`);
}

// Build import path mapping: old import path (without ext) -> new import path
// e.g., '../tools/TodoTool' -> '../tools/todo-tool'
const importRenames = [];
for (const [oldPath, newPath] of renameMap) {
  const oldName = basename(oldPath, '.ts');
  const newName = basename(newPath, '.ts');
  importRenames.push({ oldName, newName });
}

// Step 1: Update all import/export references in ALL source files (.ts and .tsx)
const allSourceFiles = [];
function walkAll(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walkAll(full);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      allSourceFiles.push(full);
    }
  }
}
walkAll(SRC);

console.log(`\nUpdating imports in ${allSourceFiles.length} files...`);

for (const filePath of allSourceFiles) {
  let content = readFileSync(filePath, 'utf-8');
  let changed = false;

  for (const { oldName, newName } of importRenames) {
    // Match import/export paths containing the old filename
    // Patterns: './OldName', '../path/OldName', with optional .js extension
    const patterns = [
      // With .js extension (ESM style used in this project)
      new RegExp(`((?:from|import|export)\\s+['"][^'"]*?)\\/${oldName}(\\.js)(['"])`, 'g'),
      // Without extension
      new RegExp(`((?:from|import|export)\\s+['"][^'"]*?)\\/${oldName}(['"])`, 'g'),
    ];

    for (const regex of patterns) {
      // For .js pattern: $1=prefix, $2=.js, $3=closing quote
      // For no-ext pattern: $1=prefix, $2=closing quote
      const replacement = regex.source.includes('\\.js')
        ? `$1/${newName}$2$3`
        : `$1/${newName}$2`;
      const newContent = content.replace(regex, replacement);
      if (newContent !== content) {
        content = newContent;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(filePath, content, 'utf-8');
    console.log(`  Updated imports in: ${filePath}`);
  }
}

// Step 2: Rename files
console.log('\nRenaming files...');
for (const [oldPath, newPath] of renameMap) {
  try {
    renameSync(oldPath, newPath);
    console.log(`  Renamed: ${basename(oldPath)} -> ${basename(newPath)}`);
  } catch (err) {
    console.error(`  FAILED to rename ${oldPath}: ${err.message}`);
  }
}

// Step 3: Verify no stale references remain
console.log('\nChecking for stale references...');
let staleCount = 0;
const remainingFiles = [];
function walkRemaining(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walkRemaining(full);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      remainingFiles.push(full);
    }
  }
}
walkRemaining(SRC);

for (const filePath of remainingFiles) {
  const content = readFileSync(filePath, 'utf-8');
  for (const { oldName } of importRenames) {
    // Check if old filename still appears in import paths
    const regex = new RegExp(`(?:from|import|export)\\s+['"][^'"]*?\\/${oldName}(?:\\.js)?['"]`, 'g');
    const matches = content.match(regex);
    if (matches) {
      for (const m of matches) {
        console.log(`  STALE in ${filePath}: ${m}`);
        staleCount++;
      }
    }
  }
}

if (staleCount === 0) {
  console.log('  No stale references found!');
} else {
  console.log(`  WARNING: ${staleCount} stale references remain!`);
}

console.log('\nDone! Run `npm run build` to verify.');
