/**
 * 低级执行引擎 —— shell:false 架构的核心
 *
 * 设计理念（移植自 DeepSeek-Reasonix）：
 * - 所有 spawn 调用都使用 shell: false，不调用真实 shell
 * - 命令通过 quote-aware tokenizer 拆分为 argv，直接传给 spawn
 * - Windows 兼容：PATHEXT 解析、cmd.exe 包装 .cmd/.bat、PowerShell UTF-8 注入
 * - GBK/UTF-8 智能解码（中文 Windows 兼容）
 * - 进程树杀死（Windows taskkill /T /F，Unix SIGKILL 进程组）
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import * as pathMod from 'node:path'
import { parseCommandChain, runChain } from './chain.js'
import { tokenizeCommand } from './parse.js'

export const DEFAULT_TIMEOUT_SEC = 120
export const DEFAULT_MAX_OUTPUT_CHARS = 32_000

// ── 进程树杀死 ────────────────────────────────────────────────

/**
 * 杀死子进程及其所有后代
 * Windows: taskkill /T /F
 * Unix: SIGKILL 进程组（需要 detached: true），回退到直接 kill
 */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      return
    } catch { /* fall through to SIGKILL */ }
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
    return
  } catch { /* not a process group leader */ }
  try {
    child.kill('SIGKILL')
  } catch { /* already gone */ }
}

// ── 执行结果 ──────────────────────────────────────────────────

export interface RunCommandResult {
  exitCode: number | null
  /** 合并的 stdout+stderr，截断到 maxOutputChars 并附加标记 */
  output: string
  /** 进程因超时被杀死 */
  timedOut: boolean
}

// ── 主执行函数 ────────────────────────────────────────────────

/**
 * 执行单条命令或命令链
 *
 * 流程：
 * 1. tokenize → 检测是否为命令链
 * 2. 命令链 → 委托给 chain.ts 的 runChain
 * 3. 单命令 → prepareSpawn（Windows 兼容） → spawn(bin, args, { shell: false })
 * 4. 收集输出 → smartDecodeOutput → 截断
 */
export async function runCommand(
  cmd: string,
  opts: {
    cwd: string
    timeoutSec?: number
    maxOutputChars?: number
    signal?: AbortSignal
  },
): Promise<RunCommandResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const argv = tokenizeCommand(cmd)
  if (argv.length === 0) throw new Error('run_command: empty command')

  // 检测命令链
  const chain = parseCommandChain(cmd)
  if (chain !== null) {
    return await runChain(chain, {
      cwd: opts.cwd,
      timeoutSec,
      maxOutputChars: maxChars,
      signal: opts.signal,
    })
  }

  const timeoutMs = timeoutSec * 1000
  const normalizedEnv = normalizeWindowsEnvVars(process.env)

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    shell: false,
    windowsHide: true,
    env: { ...normalizedEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  }

  // Windows 兼容层：PATHEXT 解析 + cmd.exe 包装
  const { bin, args, spawnOverrides } = prepareSpawn(argv, { env: normalizedEnv as any })
  const effectiveSpawnOpts = { ...spawnOpts, ...spawnOverrides }

  return await new Promise<RunCommandResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(bin, args, effectiveSpawnOpts)
    } catch (err) {
      reject(err)
      return
    }

    // 收集原始 Buffer（避免多字节序列跨 chunk 导致的解码错误）
    const chunks: Buffer[] = []
    let totalBytes = 0
    const byteCap = maxChars * 2 * 4
    let timedOut = false
    const killChildTree = () => killProcessTree(child)
    const killTimer = setTimeout(() => {
      timedOut = true
      killChildTree()
    }, timeoutMs)
    const onAbort = () => killChildTree()
    if (opts.signal?.aborted) {
      onAbort()
    } else {
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    }

    const onData = (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (totalBytes >= byteCap) return
      const remaining = byteCap - totalBytes
      if (b.length > remaining) {
        chunks.push(b.subarray(0, remaining))
        totalBytes = byteCap
      } else {
        chunks.push(b)
        totalBytes += b.length
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      clearTimeout(killTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      const merged = Buffer.concat(chunks)
      const buf = smartDecodeOutput(merged)
      const output =
        buf.length > maxChars
          ? `${buf.slice(0, maxChars)}\n\n[… truncated ${buf.length - maxChars} chars …]`
          : buf
      resolve({ exitCode: code, output, timedOut })
    })
  })
}

// ── 智能输出解码 ──────────────────────────────────────────────

/**
 * UTF-8 优先，GBK/GB18030 回退（中文 Windows 兼容）
 * cmd.exe 的本地化错误 DLL 和原生 EXE stderr 可能忽略 chcp 65001
 */
export function smartDecodeOutput(buf: Buffer): string {
  if (buf.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch { /* fall through */ }
  if (process.platform === 'win32') {
    try {
      return new TextDecoder('gb18030').decode(buf)
    } catch { /* fall through */ }
  }
  return buf.toString('utf8')
}

// ── Windows 可执行文件解析 ────────────────────────────────────

export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform
  env?: { PATH?: string; PATHEXT?: string }
  isFile?: (path: string) => boolean
  pathDelimiter?: string
}

/**
 * Windows PATHEXT 解析
 * CreateProcess 忽略 PATHEXT，裸名 `npm` 在 shell:false 下会 ENOENT
 * 遍历 PATH × PATHEXT 寻找可执行文件
 */
export function resolveExecutable(cmd: string, opts: ResolveExecutableOptions = {}): string {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return cmd
  if (!cmd) return cmd
  if (cmd.includes('/') || cmd.includes('\\') || pathMod.isAbsolute(cmd)) return cmd
  if (pathMod.extname(cmd)) return cmd

  const env = opts.env ?? process.env
  const pathExt = (getEnvCaseInsensitive(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
  const delimiter = opts.pathDelimiter ?? (platform === 'win32' ? ';' : pathMod.delimiter)
  const pathDirs = (getEnvCaseInsensitive(env, 'PATH') ?? '').split(delimiter).filter(Boolean)
  const isFile = opts.isFile ?? defaultIsFile

  for (const dir of pathDirs) {
    for (const ext of pathExt) {
      const full = pathMod.win32.join(dir, cmd + ext)
      if (isFile(full)) return full
    }
  }
  return cmd
}

// ── Windows 环境变量规范化 ─────────────────────────────────────

/**
 * 规范化 Windows 环境变量（合并重复的 Path/PATH/PATHEXT）
 */
export function normalizeWindowsEnvVars(
  env: NodeJS.ProcessEnv,
  opts: { platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return { ...env }

  const out: NodeJS.ProcessEnv = {}
  const pathValues: string[] = []
  const pathExtValues: string[] = []

  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase()
    if (lower === 'path') {
      if (typeof value === 'string') pathValues.push(value)
      continue
    }
    if (lower === 'pathext') {
      if (typeof value === 'string') pathExtValues.push(value)
      continue
    }
    out[key] = value
  }

  if (pathValues.length > 0) out.Path = mergeWindowsPathLike(pathValues, ';')
  if (pathExtValues.length > 0) out.PATHEXT = mergeWindowsPathLike(pathExtValues, ';')

  return out
}

// ── spawn 准备 ────────────────────────────────────────────────

/**
 * Windows spawn 兼容层
 *
 * 1. PATHEXT 解析裸命令名
 * 2. .cmd/.bat 需要通过 cmd.exe /d /s /c 包装（CVE-2024-27980）
 * 3. 裸 Windows 内置命令（dir, echo, type 等）需要 cmd.exe 包装
 * 4. PowerShell 需要注入 UTF-8 前缀
 */
export function prepareSpawn(
  argv: readonly string[],
  opts: ResolveExecutableOptions = {},
): { bin: string; args: string[]; spawnOverrides: SpawnOptions } {
  const head = argv[0] ?? ''
  const tail = argv.slice(1)
  const platform = opts.platform ?? process.platform
  const resolved = resolveExecutable(head, opts)

  if (platform !== 'win32') {
    return { bin: resolved, args: [...tail], spawnOverrides: {} }
  }

  // .cmd / .bat 需要 cmd.exe 包装（CVE-2024-27980）
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const cmdline = [resolved, ...tail].map(quoteForCmdExe).join(' ')
    return {
      bin: 'cmd.exe',
      args: ['/d', '/s', '/c', withUtf8Codepage(cmdline)],
      spawnOverrides: { windowsVerbatimArguments: true },
    }
  }

  // 裸 Windows 内置命令（dir, echo, type 等）
  if (isBareWindowsName(resolved) && resolved === head) {
    const cmdline = [head, ...tail].map(quoteForCmdExe).join(' ')
    return {
      bin: 'cmd.exe',
      args: ['/d', '/s', '/c', withUtf8Codepage(cmdline)],
      spawnOverrides: { windowsVerbatimArguments: true },
    }
  }

  // PowerShell UTF-8 注入
  if (isPowerShellExe(resolved)) {
    const patched = injectPowerShellUtf8(tail)
    if (patched) {
      return { bin: resolved, args: patched, spawnOverrides: {} }
    }
  }

  return { bin: resolved, args: [...tail], spawnOverrides: {} }
}

// ── 内部辅助函数 ──────────────────────────────────────────────

function getEnvCaseInsensitive(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const exact = env[key]
  if (exact !== undefined) return exact
  const target = key.toLowerCase()
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toLowerCase() === target) return value
  }
  return undefined
}

function mergeWindowsPathLike(values: readonly string[], delimiter: string): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const value of values) {
    for (const part of value.split(delimiter)) {
      const entry = part.trim()
      if (!entry) continue
      const normalized = entry.toLowerCase()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      merged.push(entry)
    }
  }
  return merged.join(delimiter)
}

function defaultIsFile(full: string): boolean {
  try {
    return existsSync(full) && statSync(full).isFile()
  } catch {
    return false
  }
}

function isPowerShellExe(resolved: string): boolean {
  return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(resolved)
}

/** 仅针对 -Command 参数注入 UTF-8 前缀 */
export function injectPowerShellUtf8(args: readonly string[]): string[] | null {
  const prelude =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;'
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (/^-(?:Command|c)$/i.test(a) && i + 1 < args.length) {
      const out = [...args]
      out[i + 1] = `${prelude}${args[i + 1] ?? ''}`
      return out
    }
  }
  return null
}

/** chcp 65001 前缀（单 & 而非 &&，兼容 Win7） */
export function withUtf8Codepage(cmdline: string): string {
  return `chcp 65001 >nul & ${cmdline}`
}

function isBareWindowsName(s: string): boolean {
  if (!s) return false
  if (s.includes('/') || s.includes('\\')) return false
  if (pathMod.isAbsolute(s)) return false
  if (pathMod.extname(s)) return false
  return true
}

/** cmd.exe 的 "" 转义规则；纯字母数字不加引号 */
export function quoteForCmdExe(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"&|<>^%(),;!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}
