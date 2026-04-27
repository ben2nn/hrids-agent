// 路径安全检查工具函数
// 防止路径穿越、Shell 展开注入、危险删除等攻击

import { homedir } from 'os'
import { dirname, isAbsolute, resolve } from 'path'

export type PathSafetyResult =
  | { safe: true }
  | { safe: false; reason: string }

/**
 * 对写/编辑操作的目标路径做安全检查。
 * 按优先级依次检查，遇到第一个问题立即返回。
 */
export function checkWritePath(inputPath: string, cwd: string): PathSafetyResult {
  // 1. Shell 展开语法拦截（TOCTOU 攻击）
  //    验证时路径是字面量，执行时 shell 会展开为不同路径
  if (inputPath.includes('$') || inputPath.includes('%')) {
    return {
      safe: false,
      reason: '路径中包含 Shell 变量展开语法（$ 或 %），存在安全风险，请使用绝对路径或相对路径',
    }
  }

  // 2. Tilde 变体拦截（~user、~+、~- 等未展开变体）
  //    expandTilde 只处理 ~ 和 ~/，其他变体会被 shell 展开为意外路径
  if (inputPath.startsWith('~') && inputPath !== '~' && !inputPath.startsWith('~/') && !inputPath.startsWith('~\\')) {
    return {
      safe: false,
      reason: '路径中包含不支持的 tilde 变体（~user、~+、~- 等），请使用绝对路径',
    }
  }

  // 3. 展开 ~ 为 home 目录
  const expandedPath = inputPath.startsWith('~/') || inputPath.startsWith('~\\')
    ? homedir() + inputPath.slice(1)
    : inputPath === '~'
      ? homedir()
      : inputPath

  // 4. 解析为绝对路径
  const absPath = isAbsolute(expandedPath) ? expandedPath : resolve(cwd, expandedPath)

  // 5. 禁止写入用户主目录根层级（~/xxx.md 这类）
  const home = homedir()
  if (dirname(absPath) === home) {
    return {
      safe: false,
      reason: `不允许直接写入用户主目录根层级 (${home})，请使用相对路径或写入子目录`,
    }
  }

  // 6. 禁止写入 .git 目录（防止篡改版本控制元数据）
  const normalizedAbs = absPath.replace(/\\/g, '/')
  if (normalizedAbs.includes('/.git/') || normalizedAbs.endsWith('/.git')) {
    return {
      safe: false,
      reason: '不允许写入 .git 目录，这可能破坏版本控制元数据',
    }
  }

  return { safe: true }
}

/**
 * 检查 rm/Remove-Item 等删除命令的目标路径是否危险。
 * 危险路径：根目录、home 目录、根目录直接子目录、Windows 盘符根目录等。
 */
export function isDangerousRemovalPath(targetPath: string): boolean {
  // 通配符 * 或以 /* 结尾
  const normalized = targetPath.replace(/\\/g, '/')
  if (normalized === '*' || normalized.endsWith('/*') || normalized.endsWith('\\*')) {
    return true
  }

  // 根目录
  if (normalized === '/') return true

  // Windows 盘符根目录（C:\ 或 C:/）
  if (/^[A-Za-z]:[/\\]?$/.test(targetPath)) return true

  // 用户主目录
  const home = homedir().replace(/\\/g, '/')
  const normalizedHome = home.endsWith('/') ? home.slice(0, -1) : home
  if (normalized === normalizedHome || normalized === normalizedHome + '/') return true

  // 根目录的直接子目录（/usr、/etc、/tmp 等）
  const parent = normalized.replace(/\/$/, '').split('/').slice(0, -1).join('/')
  if (parent === '') return true  // 直接子目录，parent 为空字符串

  // Windows 盘符直接子目录（C:/Windows、C:/Users 等）
  if (/^[A-Za-z]:\/[^/]+$/.test(normalized)) return true

  return false
}
