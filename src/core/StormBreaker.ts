/**
 * Storm Breaker — 防重复调用风暴
 *
 * 检测 LLM 陷入死循环时连续以相同参数调用同一工具的情况，
 * 达到阈值后返回错误提示，强制 LLM 换一种方式解决问题。
 *
 * 参考: DeepSeek-Reasonix src/repair/ storm breaker 机制
 */

interface CallFingerprint {
  name: string
  argsHash: string
  callIndex: number
}

export interface StormBreakerOptions {
  /** 滑动窗口大小（保留最近 N 次调用记录） */
  windowSize?: number
  /** 连续相同调用次数阈值（达到此数即触发） */
  repeatThreshold?: number
  /** 豁免风暴检测的工具名称集合（轻量级只读工具） */
  exemptTools?: Set<string>
}

export class StormBreaker {
  private recentCalls: CallFingerprint[] = []
  private readonly windowSize: number
  private readonly repeatThreshold: number
  private readonly exemptTools: Set<string>

  /**
   * @param options 配置选项
   */
  constructor(options: StormBreakerOptions = {}) {
    this.windowSize = options.windowSize ?? 10
    this.repeatThreshold = options.repeatThreshold ?? 3
    this.exemptTools = options.exemptTools ?? new Set()
  }

  /**
   * 注册豁免工具
   * @param toolNames 要豁免的工具名称列表
   */
  addExemptTools(toolNames: string[]): void {
    for (const name of toolNames) {
      this.exemptTools.add(name)
    }
  }

  /**
   * 检查是否陷入重复调用风暴
   * @param name 工具名称
   * @param input 工具输入参数
   * @param callIndex 当前工具调用序号（用于滑动窗口过期）
   * @param stormExempt 工具是否豁免风暴检测（来自 ToolDef.stormExempt）
   * @returns null（正常）| 错误提示字符串（触发风暴防护）
   */
  check(name: string, input: unknown, callIndex: number, stormExempt?: boolean): string | null {
    // 豁免检查：工具标记为豁免或在豁免集合中
    if (stormExempt || this.exemptTools.has(name)) {
      return null
    }

    const argsHash = this.hashArgs(input)

    // 统计窗口内相同调用次数
    const sameCount = this.recentCalls.filter(
      r => r.name === name && r.argsHash === argsHash,
    ).length

    // 记录本次调用
    this.recentCalls.push({ name, argsHash, callIndex })

    // 滑动窗口过期清理：只保留最近 windowSize 条
    if (this.recentCalls.length > this.windowSize * 2) {
      this.recentCalls = this.recentCalls.slice(-this.windowSize)
    }

    if (sameCount >= this.repeatThreshold) {
      return [
        `[Storm Breaker] 工具 "${name}" 已被连续调用 ${sameCount + 1} 次且参数完全相同。`,
        `请停止重试，换一种方式解决问题。`,
        `如果确实需要重复调用，请先调用其他工具（如读取相关文件）获取新信息后再试。`,
      ].join('\n')
    }

    return null
  }

  /** 写操作成功时清空窗口 — 允许 read→edit→verify 正常序列 */
  clearOnMutation(): void {
    this.recentCalls = []
  }

  /** 重置（新会话或 abort 时调用） */
  reset(): void {
    this.recentCalls = []
  }

  private hashArgs(input: unknown): string {
    try {
      const sorted = this.sortKeys(input)
      return JSON.stringify(sorted)
    } catch {
      return String(input)
    }
  }

  private sortKeys(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj
    if (Array.isArray(obj)) return obj.map(item => this.sortKeys(item))
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = this.sortKeys((obj as Record<string, unknown>)[key])
    }
    return sorted
  }
}
