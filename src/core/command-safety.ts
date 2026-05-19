// 命令安全分析 —— 在工具执行前检测危险模式
//
// 定位：辅助检查层，不是安全边界。真正的安全依赖 PermissionManager 的审批流程。
// 设计：规则表 + 风险等级，供 UI 展示警告和 PermissionManager 做决策参考。

import { loadConfig } from './config.js'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface SafetyAnalysis {
  safe: boolean
  riskLevel: RiskLevel
  warnings: SafetyWarning[]
}

export interface SafetyWarning {
  pattern: string
  message: string
  riskLevel: RiskLevel
}

interface SafetyRule {
  pattern: RegExp
  message: string
  riskLevel: RiskLevel
  platform?: 'win32' | 'posix'  // 仅在指定平台生效
}

const SAFETY_RULES: SafetyRule[] = [
  // ── critical ──────────────────────────────────────────
  {
    pattern: /\bcurl\b[^|]*\|\s*(ba)?sh/i,
    message: '远程脚本直接执行（curl 管道到 shell）',
    riskLevel: 'critical',
  },
  {
    pattern: /\bwget\b[^|]*\|\s*(ba)?sh/i,
    message: '远程脚本直接执行（wget 管道到 shell）',
    riskLevel: 'critical',
  },
  {
    pattern: /\bformat\b.*\/[qsy]/i,
    message: '快速格式化磁盘（可能丢失全部数据）',
    riskLevel: 'critical',
    platform: 'win32',
  },
  {
    pattern: /\brm\s+(-[rRf]{2,}|--recursive\s+--force)\s+[/~]/,
    message: '递归强制删除根目录或主目录',
    riskLevel: 'critical',
  },
  {
    pattern: /\brm\s+(-[rRf]{2,}|--recursive\s+--force)\s+\*/,
    message: '递归强制删除通配符（可能误删大范围文件）',
    riskLevel: 'critical',
  },
  {
    pattern: /\b(d?:del|erase)\s+\/[sfq]\s+[a-z]:\\/i,
    message: '递归删除磁盘根目录（Windows）',
    riskLevel: 'critical',
    platform: 'win32',
  },

  // ── high ──────────────────────────────────────────────
  {
    pattern: /\b(sudo|su)\b/,
    message: '提权操作',
    riskLevel: 'high',
  },
  {
    pattern: /\brm\s+(-[rR]|--recursive)\b/,
    message: '递归删除操作',
    riskLevel: 'high',
  },
  {
    pattern: /\bchmod\s+777\b/,
    message: '过于宽松的文件权限（777）',
    riskLevel: 'high',
  },
  {
    pattern: /\bchown\s+.*root/,
    message: '将文件所有权改为 root',
    riskLevel: 'high',
  },
  {
    pattern: /\bmkfs\b/,
    message: '创建文件系统（会格式化分区）',
    riskLevel: 'high',
  },
  {
    pattern: /\bdd\s+.*of=\/dev\//,
    message: '直接写入设备文件',
    riskLevel: 'high',
  },
  {
    pattern: /\b(nc|netcat)\b.*-[elp]/i,
    message: '反向 shell / 监听端口',
    riskLevel: 'high',
  },
  {
    pattern: /\b(shutdown|reboot|halt|poweroff)\b/i,
    message: '关机/重启操作',
    riskLevel: 'high',
  },
  {
    pattern: /\bdel\s+\/[sfq]\s+\*/i,
    message: '递归删除当前目录所有文件（Windows）',
    riskLevel: 'high',
    platform: 'win32',
  },
  {
    pattern: /\bRemove-Item\b.*-Recurse.*-Force/i,
    message: 'PowerShell 递归强制删除',
    riskLevel: 'high',
    platform: 'win32',
  },

  // ── medium ────────────────────────────────────────────
  {
    pattern: /\bgit\s+push\b.*--force/,
    message: 'Git 强制推送（可能覆盖远程历史）',
    riskLevel: 'medium',
  },
  {
    pattern: /\bgit\s+reset\b.*--hard/,
    message: 'Git 硬重置（丢失未提交更改）',
    riskLevel: 'medium',
  },
  {
    pattern: /\bgit\s+clean\b.*-[fF]/,
    message: 'Git 清理未跟踪文件',
    riskLevel: 'medium',
  },
  {
    pattern: /\bkill\s+-9\b/,
    message: '强制终止进程（SIGKILL）',
    riskLevel: 'medium',
  },
  {
    pattern: /\b(iptables|netsh\s+advfirewall)\b/i,
    message: '修改防火墙规则',
    riskLevel: 'medium',
  },
  {
    pattern: /\b(pip|npm|yarn)\s+(install|add)\b.*--global/,
    message: '全局安装包',
    riskLevel: 'medium',
  },
  {
    pattern: /\beval\s*\(/,
    message: '动态执行代码（eval）',
    riskLevel: 'medium',
  },
  {
    pattern: /\bSet-ExecutionPolicy\b.*[Bb]ypass/i,
    message: '绕过 PowerShell 执行策略',
    riskLevel: 'medium',
    platform: 'win32',
  },

  // ── low ───────────────────────────────────────────────
  {
    pattern: /\bgit\s+checkout\b/,
    message: 'Git 切换分支（可能丢失工作区更改）',
    riskLevel: 'low',
  },
  {
    pattern: /\bgit\s+stash\b/,
    message: 'Git 暂存更改',
    riskLevel: 'low',
  },
]

/** 分析命令安全性，返回风险等级和警告列表 */
export function analyzeCommandSafety(command: string): SafetyAnalysis {
  const warnings: SafetyWarning[] = []
  let maxRisk: RiskLevel = 'low'

  for (const rule of SAFETY_RULES) {
    // 平台过滤
    if (rule.platform && rule.platform !== process.platform) continue

    if (rule.pattern.test(command)) {
      warnings.push({
        pattern: rule.pattern.source,
        message: rule.message,
        riskLevel: rule.riskLevel,
      })
      if (riskPriority(rule.riskLevel) > riskPriority(maxRisk)) {
        maxRisk = rule.riskLevel
      }
    }
  }

  return {
    safe: maxRisk === 'low',
    riskLevel: maxRisk,
    warnings,
  }
}

/** 风险等级数值化，用于比较（公开，供工具层使用） */
export function riskPriority(level: RiskLevel): number {
  switch (level) {
    case 'low': return 0
    case 'medium': return 1
    case 'high': return 2
    case 'critical': return 3
  }
}

/** 格式化安全分析结果为人类可读文本 */
export function formatSafetyAnalysis(analysis: SafetyAnalysis): string {
  if (analysis.safe) return ''
  const lines = analysis.warnings.map(w => `  ⚠ [${w.riskLevel}] ${w.message}`)
  return `安全分析（风险等级: ${analysis.riskLevel}）:\n${lines.join('\n')}`
}

/**
 * 综合命令安全权限检查（供 BashTool 共享）。
 * 检查顺序：命令安全分析 → 自定义正则 → 风险等级阈值。
 * @returns { granted: true } 或 { granted: false, reason }
 */
export function checkCommandSafetyPermission(command: string): { granted: true } | { granted: false; reason: string } {
  const config = loadConfig()
  const safetyConfig = config.commandSafety

  if (safetyConfig?.enabled === false) {
    process.stderr.write('[CommandSafety] 警告：命令安全检查已被配置禁用\n')
    return { granted: true }
  }

  const analysis = analyzeCommandSafety(command)
  const blockLevel = safetyConfig?.blockLevel ?? 'high'
  const blockPriority = riskPriority(blockLevel)

  // 自定义正则检查（带超时保护，防止 ReDoS）
  if (safetyConfig?.extraPatterns) {
    for (const pattern of safetyConfig.extraPatterns) {
      try {
        const regex = new RegExp(pattern)
        // 对超长命令截断后再匹配，防止 ReDoS 导致长时间阻塞
        const testStr = command.length > 10000 ? command.slice(0, 10000) : command
        if (regex.test(testStr)) {
          return { granted: false, reason: `命令匹配自定义危险规则: ${pattern}` }
        }
      } catch { /* 无效正则跳过 */ }
    }
  }

  if (!analysis.safe && riskPriority(analysis.riskLevel) >= blockPriority) {
    const detail = formatSafetyAnalysis(analysis)
    return { granted: false, reason: detail || `命令安全分析拒绝（风险等级: ${analysis.riskLevel}）` }
  }

  return { granted: true }
}
