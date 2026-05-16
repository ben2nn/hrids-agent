import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const STATS_PATH = join(homedir(), '.hrids', 'command-stats.json')

let stats: Record<string, number> = {}
let loaded = false

function load() {
  if (loaded) return
  try {
    if (existsSync(STATS_PATH)) {
      stats = JSON.parse(readFileSync(STATS_PATH, 'utf-8'))
    }
  } catch { /* 忽略损坏文件 */ }
  loaded = true
}

function save() {
  try {
    const dir = join(homedir(), '.hrids')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2))
  } catch { /* 忽略写入失败 */ }
}

/** 记录一次命令使用 */
export function recordCommandUse(name: string) {
  load()
  stats[name] = (stats[name] ?? 0) + 1
  save()
}

/** 获取命令使用次数 */
export function getCommandCount(name: string): number {
  load()
  return stats[name] ?? 0
}

/** 获取所有命令使用统计 */
export function getAllCommandStats(): Record<string, number> {
  load()
  return { ...stats }
}
