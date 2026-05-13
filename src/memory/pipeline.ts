// 记忆提炼管道：提取 → LLM 提炼 → 向量去重 → 动态评分 → 写入
// 流程：extractFromConversation → [condense via LLM] → dedup → addMemory
import { extractFromConversation } from './extractor.js'
import { getMemoryStore } from './store.js'
import type { Memory } from './types.js'
import type { LLMProvider } from '../core/providers/types.js'

export interface PipelineOptions {
  /** 是否启用 LLM 提炼（压缩原文为精炼一句话），默认 false */
  condense?: boolean
  /** LLM 提炼时使用的 provider（condense=true 时必须传入） */
  provider?: LLMProvider
  /** 向量去重相似度阈值，默认 0.85 */
  dedupThreshold?: number
  /** 最低置信度，低于此值的提取结果直接丢弃，默认 0.4 */
  minConfidence?: number
  /** 会话 ID，写入记忆时作为来源标记 */
  sessionId?: string
  /** 记忆归属的 agent 名称，默认 'main' */
  agent?: string
}

export interface PipelineResult {
  saved: number      // 成功写入条数
  skipped: number    // 去重跳过条数
  condensed: number  // LLM 提炼条数
}

/**
 * 完整记忆提炼管道
 * 从对话历史中提取、提炼、去重后写入长期记忆
 */
export async function runMemoryPipeline(
  messages: Array<{ role: string; content: string | unknown[] }>,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const {
    condense = false,
    provider,
    dedupThreshold = 0.85,
    minConfidence = 0.4,
    sessionId,
    agent = 'main',
  } = opts

  const result: PipelineResult = { saved: 0, skipped: 0, condensed: 0 }

  // ① 提取：正则初筛，过滤低置信度
  const extracted = extractFromConversation(messages).filter(
    m => m.confidence >= minConfidence
  )
  if (extracted.length === 0) return result

  // 记忆写入全局 store（跨会话积累知识）
  // 会话 ID 仅作为来源标记（sourceSession），不影响写入目标
  // 这样用户在任意会话里积累的记忆，在所有会话中都可见
  const store = getMemoryStore()

  // ② LLM 批量提炼：一次调用压缩所有需要提炼的条目
  const condensedContents: (string | null)[] = extracted.map(() => null)
  if (condense && provider) {
    const needCondense = extracted
      .map((mem, i) => ({ i, content: mem.content }))
      .filter(({ content }) => content.length >= 80)

    if (needCondense.length > 0) {
      const batchResults = await condenseBatchWithLLM(
        needCondense.map(({ content }) => content),
        provider,
      )
      for (let j = 0; j < needCondense.length; j++) {
        condensedContents[needCondense[j].i] = batchResults[j]
      }
      result.condensed = batchResults.filter(Boolean).length
    }
  }

  for (let i = 0; i < extracted.length; i++) {
    const mem = extracted[i]
    const content = condensedContents[i] ?? mem.content

    // ③ 向量去重：相似度 > threshold 则跳过
    const similar = await store.findSimilar(content, dedupThreshold)
    if (similar.length > 0) {
      result.skipped++
      continue
    }

    // ④ 写入（importance 已由 extractor 动态计算）
    store.addMemory({
      content,
      type: mem.type,
      agent,
      importance: mem.importance,
      sourceSession: sessionId,
    } as Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>)

    result.saved++
  }

  return result
}

// LLM 批量提炼：一次调用压缩多条记忆，返回与输入等长的数组
// 输入 N 条，输出 N 条（压缩失败或不需要压缩的位置返回 null）
async function condenseBatchWithLLM(
  contents: string[],
  provider: LLMProvider,
): Promise<(string | null)[]> {
  if (contents.length === 0) return []

  // 构建批量 prompt：每条用编号分隔，要求按编号输出
  const numbered = contents
    .map((c, i) => `[${i + 1}]\n${c.slice(0, 1500)}`)
    .join('\n\n---\n\n')

  const prompt = `将以下 ${contents.length} 条内容分别压缩为 1-2 句精炼的记忆条目，保留关键决策/事实/偏好，去掉冗余解释。

严格按以下格式输出，每条用编号开头，不要任何额外说明：
[1] 压缩后的文本
[2] 压缩后的文本
...

原文：

${numbered}`

  try {
    let raw = ''
    for await (const chunk of provider.stream(
      [{ role: 'user', content: prompt }],
      [],
      ['你是记忆提炼助手，严格按编号格式输出压缩结果，不输出任何其他内容。'],
      Math.min(200 * contents.length, 2000),
    )) {
      if (chunk.type === 'text_delta' && chunk.delta) raw += chunk.delta
    }

    // 解析输出：按 [N] 分割
    const results: (string | null)[] = contents.map(() => null)
    const lines = raw.trim().split('\n')
    let currentIdx: number | null = null
    const buffer: string[] = []

    const flush = () => {
      if (currentIdx === null) return
      const text = buffer.join(' ').trim()
      const original = contents[currentIdx]
      // 压缩结果比原文短才采用
      if (text && text.length < original.length) {
        results[currentIdx] = text
      }
      buffer.length = 0
    }

    for (const line of lines) {
      const match = line.match(/^\[(\d+)\]\s*(.*)/)
      if (match) {
        flush()
        const idx = parseInt(match[1], 10) - 1
        if (idx >= 0 && idx < contents.length) {
          currentIdx = idx
          if (match[2].trim()) buffer.push(match[2].trim())
        } else {
          currentIdx = null
        }
      } else if (currentIdx !== null && line.trim()) {
        buffer.push(line.trim())
      }
    }
    flush()

    return results
  } catch {
    return contents.map(() => null)
  }
}
