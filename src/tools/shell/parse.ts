/**
 * 命令解析与白名单 —— shell:false 架构的核心安全层
 *
 * 设计理念（移植自 DeepSeek-Reasonix）：
 * - 不调用真实 shell，所有命令通过 quote-aware tokenizer 解析为 argv
 * - 白名单机制：只有明确安全的命令可以自动执行
 * - 命令链（|、&&、||、;）中的每个 segment 独立检查白名单
 * - 防止通过环境变量展开、glob 展开、命令替换绕过白名单
 */

// ── 内置白名单 ──────────────────────────────────────────────────
// 只读命令 + 测试/检查工具，可在 plan-mode 下自动执行
// 每个条目是命令前缀（空格分隔的 token 序列）

export const BUILTIN_ALLOWLIST: ReadonlyArray<string> = [
  // ── Git 检查 ──
  'git status',
  'git diff',
  'git log',
  'git show',
  'git blame',
  'git branch',
  'git remote',
  'git rev-parse',
  'git config --get',
  'git tag',
  'git describe',
  'git shortlog',
  'git reflog',
  'git ls-files',
  'git ls-remote',
  'git archive',
  'git stash list',
  // ── 文件系统检查 ──
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'tree',
  'find',
  'grep',
  'rg',
  'fd',
  'du',
  'df',
  'free',
  'uptime',
  'id',
  'whoami',
  'hostname',
  'uname',
  'env',
  'printenv',
  'which',
  'whereis',
  'type',
  'echo',
  'printf',
  'date',
  'ps',
  'top',
  'htop',
  'pgrep',
  'lsof',
  'netstat',
  'ss',
  'ip',
  'ifconfig',
  'ping',
  'traceroute',
  'dig',
  'nslookup',
  'host',
  // ── 语言版本探测 ──
  'node --version',
  'node -v',
  'npm --version',
  'npx --version',
  'yarn --version',
  'pnpm --version',
  'bun --version',
  'python --version',
  'python3 --version',
  'pip --version',
  'pip3 --version',
  'cargo --version',
  'go version',
  'rustc --version',
  'deno --version',
  'java --version',
  'javac --version',
  'mvn --version',
  'gradle --version',
  'dotnet --version',
  // ── 测试运行器 ──
  'npm test',
  'npm run test',
  'npx vitest run',
  'npx vitest',
  'npx jest',
  'pytest',
  'python -m pytest',
  'cargo test',
  'cargo check',
  'cargo clippy',
  'go test',
  'go vet',
  'deno test',
  'bun test',
  // ── 代码检查 / 类型检查 ──
  'npm run lint',
  'npm run typecheck',
  'npx tsc --noEmit',
  'npx biome check',
  'npx eslint',
  'npx prettier --check',
  'ruff',
  'ruff check',
  'mypy',
  // ── 包管理器信息 ──
  'npm list',
  'npm ls',
  'npm info',
  'npm view',
  'npm outdated',
  'pip list',
  'pip show',
  'cargo metadata',
  'go list',
  // ── 常用开发工具 ──
  'tsc',
  'npx tsc',
  'python -c',
  'node -e',
]

/** 用于检测链式操作符的正则（排除引号内的内容） */
const CHAIN_OPERATORS = /[;&|`]|&&|\|\||\$\(/

/**
 * 检测命令是否包含 shell 链式操作符
 * 注意：这是快速预检，真正的链式解析由 chain.ts 的 parseCommandChain 完成
 */
export function hasShellOperator(cmd: string): boolean {
  return CHAIN_OPERATORS.test(cmd)
}

// ── Quote-aware Tokenizer ──────────────────────────────────────

/**
 * 双引号内的转义判断：只有 \" 和 \\ 是转义，其他 \X 保持字面量
 * （兼容 Windows 路径如 "C:\Users\foo\.bar"）
 */
export function isDqEscape(prev: string, next: string | undefined): boolean {
  return prev === '\\' && (next === '"' || next === '\\')
}

/**
 * 将命令字符串拆分为 token 数组（quote-aware）
 *
 * 安全保证：
 * - 不进行环境变量展开（$VAR 保持字面量）
 * - 不进行 glob 展开（* ? 保持字面量）
 * - 不进行命令替换（$(…) 保持字面量）
 * - 不进行反引号展开
 * - 引号内的空格不拆分
 * - 未闭合引号抛出错误
 */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"' && isDqEscape(ch, cmd[i + 1])) {
        cur += cmd[++i]
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (cur.length > 0) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (quote) throw new Error(`unclosed ${quote} in command`)
  if (cur.length > 0) out.push(cur)
  return out
}

// ── Shell Operator 检测 ────────────────────────────────────────

/**
 * 前置检测命令中的 shell 操作符（用于后台任务等场景）
 * 在引号外、token 开头检测 |, ||, &&, ;, >, >>, <, 2>, 2>>, 2>&1, &>
 */
export function detectShellOperator(cmd: string): string | null {
  const opPrefix = /^(?:2>&1|&>|\|{1,2}|&{1,2}|2>{1,2}|>{1,2}|<{1,2})/
  let cur = ''
  let curQuoted = false
  let quote: '"' | "'" | null = null
  const check = (): string | null => {
    if (cur.length === 0 && !curQuoted) return null
    if (!curQuoted) {
      const m = opPrefix.exec(cur)
      if (m) return m[0] ?? null
    }
    return null
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"' && isDqEscape(ch, cmd[i + 1])) {
        cur += cmd[++i]
        curQuoted = true
      } else {
        cur += ch
        curQuoted = true
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      curQuoted = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      const op = check()
      if (op) return op
      cur = ''
      curQuoted = false
      continue
    }
    cur += ch
  }
  if (quote) return null // 让 tokenizeCommand 抛出未闭合引号错误
  return check()
}

// ── 白名单匹配 ─────────────────────────────────────────────────

/**
 * 逐前缀降级：某些白名单命令的特定 flag 是危险的，命中后回退到确认流程
 * key 是白名单前缀，value 是该前缀下需要降级的 flag 列表
 */
const RISKY_ARGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  'git branch': ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '--force'],
  'git remote': ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'prune'],
  'git diff': ['--output', '--ext-diff'],
  'git log': ['--output'],
  'git show': ['--output'],
  'git stash': ['drop', 'pop', 'clear', 'apply'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
  tree: ['-o'],
  'npx eslint': ['--fix', '--fix-dry-run'],
  'npx biome check': ['--write', '--apply', '--apply-unsafe'],
  'npx prettier --check': ['--write'],
  ruff: ['--fix', '--unsafe-fixes', 'format'],
  'ruff check': ['--fix', '--unsafe-fixes'],
}

function tailHasRisky(tail: readonly string[], risky: readonly string[]): boolean {
  for (const a of tail) {
    for (const r of risky) {
      if (a === r) return true
      if (a.startsWith(`${r}=`)) return true
    }
  }
  return false
}

/**
 * 检查单条命令是否在白名单内
 *
 * @param cmd 命令字符串
 * @param extra 额外的白名单前缀（用户配置的 always-allow 前缀）
 * @returns true 表示白名单匹配且无危险 flag
 */
export function isAllowed(cmd: string, extra: readonly string[] = []): boolean {
  let argv: string[]
  try {
    argv = tokenizeCommand(cmd)
  } catch {
    return false
  }
  if (argv.length === 0) return false

  const allowlist = [...BUILTIN_ALLOWLIST, ...extra]
  for (const prefix of allowlist) {
    const prefixTokens = prefix.split(' ')
    if (argv.length < prefixTokens.length) continue
    let match = true
    for (let i = 0; i < prefixTokens.length; i++) {
      if (argv[i] !== prefixTokens[i]) {
        match = false
        break
      }
    }
    if (!match) continue

    // 检查是否命中危险 flag 降级
    const risky = RISKY_ARGS[prefix]
    if (risky && tailHasRisky(argv.slice(prefixTokens.length), risky)) return false
    return true
  }
  return false
}

/**
 * 简易链式命令拆分（仅用于白名单检查，不处理重定向）
 * 在引号外拆分 |、||、&&、; 操作符
 */
function splitChainForAllowlist(cmd: string): string[] {
  const segs: string[] = []
  let segStart = 0
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (quote === '"' && isDqEscape(ch, cmd[i + 1])) i++
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i++
      continue
    }
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    // 检查链式操作符（只在 token 开头）
    let opLen = 0
    const next = cmd[i + 1]
    if (ch === '|' && next === '|') opLen = 2
    else if (ch === '&' && next === '&') opLen = 2
    else if (ch === '|') opLen = 1
    else if (ch === ';') opLen = 1
    if (opLen > 0) {
      const seg = cmd.slice(segStart, i).trim()
      if (seg) segs.push(seg)
      i += opLen
      segStart = i
      continue
    }
    i++
  }
  const last = cmd.slice(segStart).trim()
  if (last) segs.push(last)
  return segs
}

/**
 * 检查命令（可能包含链式操作符）是否全部在白名单内
 * 链式命令中的每个 segment 都必须独立通过白名单检查
 */
export function isCommandAllowed(cmd: string, extra: readonly string[] = []): boolean {
  // 如果没有链式操作符，直接检查
  if (!hasShellOperator(cmd)) return isAllowed(cmd, extra)

  // 有链式操作符时，拆分后逐段检查
  const segments = splitChainForAllowlist(cmd)
  if (segments.length === 0) return false
  for (const seg of segments) {
    if (!isAllowed(seg, extra)) return false
  }
  return true
}
