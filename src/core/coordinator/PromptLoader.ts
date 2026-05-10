// PromptLoader — Load main agent prompts from filesystem
// Reads .md files from ~/.hrids/agents/main/ directory
// Falls back to code built-in defaults when files are missing

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const MAIN_AGENT_DIR = join(homedir(), '.hrids', 'agents', 'main')

/** Get the main agent directory path (~/.hrids/agents/main/) */
export function getMainAgentDir(): string {
  return MAIN_AGENT_DIR
}

/**
 * Load a prompt file by name (e.g., "IDENTITY", "SOUL").
 * Returns the file content as a string, or null if the file doesn't exist.
 */
export function loadPromptFile(name: string): string | null {
  const filePath = join(MAIN_AGENT_DIR, `${name}.md`)
  if (!existsSync(filePath)) return null
  try {
    return readFileSync(filePath, 'utf-8').trim()
  } catch {
    return null
  }
}

/** Check if agents/main/ directory has been initialized */
export function hasMainAgentConfig(): boolean {
  return existsSync(MAIN_AGENT_DIR)
}
