#!/usr/bin/env node

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'

const MIN_NODE_MAJOR = 18

const [majorStr = '0'] = process.versions.node.split('.')
if (Number(majorStr) < MIN_NODE_MAJOR) {
  process.stderr.write(
    `hrids-agent: Node.js v${MIN_NODE_MAJOR}+ is required (current: v${process.versions.node}).\n`
  )
  process.exit(1)
}

const distEntry = new URL('../dist/main.js', import.meta.url)

try {
  await access(distEntry)
} catch {
  process.stderr.write(
    'hrids-agent: dist/main.js not found.\n' +
    'Run `npm run build` first, or use `npm run dev` for development.\n'
  )
  process.exit(1)
}

await import(distEntry.href)
