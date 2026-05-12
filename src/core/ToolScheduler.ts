/**
 * 工具调度器 — 按 parallelSafe 自动分区
 *
 * 将 LLM 一次返回的多个 tool_use 按并发安全性分为：
 * - 并行批次：连续的 parallelSafe 工具合并，可并发执行
 * - 串行批次：非 safe 工具各自独立，必须顺序执行
 * 这样可以最大化并行执行的工具调用，同时保证非 safe 工具的正确性。
 */
import type { ToolDef } from './Tool.js'

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolBatch {
  parallel: boolean
  calls: ToolCall[]
}

/**
 * 将工具调用列表按 parallelSafe 属性分区。
 * 连续的 safe 工具合并为一个并行批次，非 safe 工具各自成批。
 */
export function partitionToolCalls(
  toolCalls: ToolCall[],
  tools: ToolDef[],
): ToolBatch[] {
  return toolCalls.reduce<ToolBatch[]>((batches, tc) => {
    const tool = tools.find(t => t.name === tc.name)
    const isSafe = tool?.capabilities?.parallelSafe === true

    if (isSafe && batches.length > 0 && batches[batches.length - 1].parallel) {
      // 合并到当前并行批次
      batches[batches.length - 1].calls.push(tc)
    } else {
      // 新建批次（并行 or 串行）
      batches.push({ parallel: isSafe, calls: [tc] })
    }
    return batches
  }, [])
}
