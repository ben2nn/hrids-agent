// 会话结束后的后台钩子：记忆提炼 + Skill 自动沉淀
// 供 CLI 模式（main.ts）和 Gateway 模式（SessionManager.ts）共用

import { mkdirSync, writeFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { runMemoryPipeline } from '../memory/index.js'
import { logger } from '../shared/logger.js'
import { getConfigDir } from './config.js'
import type { QueryEngine } from './query-engine.js'
import { projectForDisplay } from './projections.js'
import { createMemoryWrittenEvent } from './kernel-event.js'
import type { LLMProvider } from '../providers/types.js'

const log = logger.child({ component: 'post-run-hooks' })

// ── 并发控制 ──────────────────────────────────────────────────

// per-session 的并发锁，防止同一会话同时触发多次记忆总结
const memoryRunningSessions = new Set<string>()

// ── 记忆自动提炼 ──────────────────────────────────────────────

/**
 * 会话结束后自动提炼记忆（后台静默执行，不阻塞主流程）
 * @param condense 是否启用 LLM 压缩（需要额外 API 调用，默认 false）
 */
export async function autoExtractMemories(
  engine: QueryEngine,
  sessionId: string,
  provider: LLMProvider,
  condense = false,
): Promise<void> {
  // 并发控制：同一会话只允许一个记忆总结在执行
  if (memoryRunningSessions.has(sessionId)) {
    log.debug('记忆总结已在执行中，跳过', { sessionId })
    return
  }
  memoryRunningSessions.add(sessionId)
  try {
    const displayMsgs = projectForDisplay(engine.store.getMessages())
    const messages = displayMsgs.map(dm => ({ role: dm.role, content: dm.content }))
    if (condense) log.info('记忆总结：开始 LLM 提炼', { sessionId, caller: 'memory-pipeline' })
    // Gateway 模式下 runWithSession 上下文已存在，pipeline 内部通过 getCurrentSessionId 获取会话级 store
    await runMemoryPipeline(messages, {
      condense,
      provider: condense ? provider : undefined,
      sessionId,
    })
    engine.store.appendEvents(createMemoryWrittenEvent('project', `session:${sessionId}`))
    if (condense) log.info('记忆总结：LLM 提炼完成', { sessionId, caller: 'memory-pipeline' })
  } catch {
    // 静默失败，不影响主流程
  } finally {
    memoryRunningSessions.delete(sessionId)
  }
}

// ── Skill 自动沉淀 ────────────────────────────────────────────

/**
 * 会话结束后自动提炼 skill（后台静默执行，不阻塞主流程）
 * 启发式判断：工具调用次数 >= 5 且会话有实质内容，才尝试提炼
 * 需要显式传入 enabled=true 才会执行（避免隐性 LLM 费用）
 */
export async function autoDistillSkill(
  engine: QueryEngine,
  provider: LLMProvider,
  enabled = false,
): Promise<void> {
  if (!enabled) return
  try {
    const messages = engine.store.getMessages()

    // 从消息直接统计工具调用次数
    let toolCallCount = 0
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) toolCallCount += msg.tool_calls.length
    }

    // 门槛：工具调用 < 5 次，不值得沉淀
    if (toolCallCount < 5) return

    // 序列化对话历史（从消息投影，只保留文本和工具调用摘要，控制 token）
    const displayMsgs = projectForDisplay(messages)
    const lines: string[] = []
    for (const dm of displayMsgs) {
      const prefix = dm.role === 'user' ? '用户' : '助手'
      const text = dm.content.slice(0, 500)
      if (text) lines.push(`[${prefix}]: ${text}`)
      if (dm.toolCards) {
        for (const tc of dm.toolCards) {
          lines.push(`[${prefix}]: [调用工具: ${tc.name}]`)
        }
      }
    }
    const condensed = lines.join('\n').slice(0, 6000)

    log.info('Skill 总结：开始 LLM 提炼', { toolCallCount, caller: 'skill-distill' })

    const distillPrompt = `以下是一段 agent 完成任务的对话历史（共 ${toolCallCount} 次工具调用）。

请判断这个工作流是否值得沉淀为可复用的 skill。

**值得沉淀的条件（满足任一即可）：**
- 包含 3 个以上不同工具的协作使用
- 克服了错误或障碍后找到了可行方案
- 包含可重复的、有价值的操作模式

**不值得沉淀：**
- 简单的问答或单一工具操作
- 高度特定于当前项目、无法复用的内容

如果不值得沉淀，只输出：null

如果值得沉淀，输出以下 JSON（不要包含任何其他内容）：
{
  "name": "英文小写连字符名称，描述任务类型",
  "description": "一句话描述这个 skill 的用途（中文）",
  "when_to_use": "什么情况下应该使用这个 skill（中文）",
  "prompt": "完整的 Markdown 格式执行步骤，用占位符替换具体路径/项目名，如 <目标文件>、<项目名>"
}

对话历史：
${condensed}`

    let raw = ''
    for await (const chunk of provider.stream(
      [{ role: 'user', content: distillPrompt }],
      [],
      ['你是一个 skill 提炼助手，只输出 null 或 JSON，不输出任何其他内容。'],
      2000,
    )) {
      if (chunk.type === 'text_delta' && chunk.delta) raw += chunk.delta
    }

    const trimmed = raw.trim()
    if (!trimmed || trimmed === 'null') return

    // 解析 JSON（容忍 markdown 代码块包裹）
    const jsonStr = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    let parsed: { name: string; description: string; when_to_use?: string; prompt: string }
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      return // 解析失败静默跳过
    }

    if (!parsed.name || !parsed.prompt) return

    log.info('Skill 总结：LLM 提炼完成', { skillName: parsed.name, caller: 'skill-distill' })

    const skillDir = join(getConfigDir(), 'skills', parsed.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    const isUpdate = existsSync(skillMdPath)

    const frontmatter = [
      '---',
      `description: "${parsed.description}"`,
      parsed.when_to_use ? `when-to-use: "${parsed.when_to_use}"` : null,
      '---',
    ].filter(Boolean).join('\n')

    const content = frontmatter + '\n\n' + parsed.prompt.trim() + '\n'

    mkdirSync(skillDir, { recursive: true })
    // 原子写入：先写 .tmp 再 rename，防止并发会话同时提炼同名 skill 时文件损坏
    const tmpPath = skillMdPath + '.tmp'
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, skillMdPath)

    log.info(`自动沉淀 skill: ${parsed.name}（${isUpdate ? '更新' : '新建'}）`, { path: skillMdPath })
  } catch {
    // 静默失败，不影响主流程
  }
}
