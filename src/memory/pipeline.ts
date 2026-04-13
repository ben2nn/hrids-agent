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
  } = opts

  const result: PipelineResult = { saved: 0, skipped: 0, condensed: 0 }

  // ① 提取：正则初筛，过滤低置信度
  const extracted = extractFromConversation(messages).filter(
    m => m.confidence >= minConfidence
  )
  if (extracted.length === 0) return result

  const store = getMemoryStore()

  for (const mem of extracted) {
    let content = mem.content

    // ② LLM 提炼：把长段原文压缩为精炼一句话
    if (condense && provider) {
      const condensed = await condenseWithLLM(content, provider)
      if (condensed) {
        content = condensed
        result.condensed++
      }
    }

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
      wing: 'session',
      room: inferRoom(mem.type),
      importance: mem.importance,
      tags: ['auto-extracted'],
      sourceSession: sessionId,
    } as Omit<Memory, 'id' | 'createdAt' | 'embedding'>)

    result.saved++
  }

  return result
}

// 根据记忆类型推断 room 分类
function inferRoom(type: string): string {
  const map: Record<string, string> = {
    decision: 'architecture',
    preference: 'style',
    milestone: 'progress',
    problem: 'debugging',
    fact: 'knowledge',
    emotional: 'personal',
  }
  return map[type] ?? 'general'
}

// LLM 提炼：把原始文本压缩为 1-2 句精炼记忆
async function condenseWithLLM(
  content: string,
  provider: LLMProvider,
): Promise<string | null> {
  // 内容已经很短，不需要提炼
  if (content.length < 80) return null

  const prompt = `将以下内容压缩为 1-2 句精炼的记忆条目，保留关键决策/事实/偏好，去掉冗余解释。只输出压缩后的文本，不要任何前缀或解释。

原文：
${content.slice(0, 1500)}`

  try {
    let raw = ''
    for await (const chunk of provider.stream(
      [{ role: 'user', content: prompt }],
      [],
      '你是记忆提炼助手，只输出压缩后的文本。',
      200,
    )) {
      if (chunk.type === 'text_delta' && chunk.delta) raw += chunk.delta
    }
    const trimmed = raw.trim()
    // 提炼结果比原文长或为空，说明 LLM 没有压缩，放弃
    return trimmed && trimmed.length < content.length ? trimmed : null
  } catch {
    return null
  }
}
