// FallbackProvider —— 多 LLM 故障转移
// 当前模型重试 MAX_RETRIES_PER_MODEL 次，全部失败后切换下一个模型
// 记住当前位置，下次调用直接从上次成功的模型开始
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, StreamChunk } from './types.js'
import { logger } from '../logger.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const log = logger.child({ component: 'fallback-provider' })

// 每个模型在切换前的最大重试次数
const MAX_RETRIES_PER_MODEL = 3

const STATE_PATH = join(homedir(), '.hrids-agent', 'fallback-state.json')

function loadState(): { groupIdx: number; modelIdx: number } {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed.groupIdx === 'number' && typeof parsed.modelIdx === 'number') {
        return parsed
      }
    }
  } catch { /* 读取失败静默忽略，从头开始 */ }
  return { groupIdx: 0, modelIdx: 0 }
}

function saveState(groupIdx: number, modelIdx: number): void {
  try {
    mkdirSync(join(homedir(), '.hrids-agent'), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify({ groupIdx, modelIdx }), 'utf-8')
  } catch { /* 写入失败静默忽略 */ }
}

// 平台分组：同一平台的多个模型归为一组，组内按顺序切换，组间跨平台切换
export interface ProviderGroup {
  platformName: string
  providers: LLMProvider[]
}

export class FallbackProvider implements LLMProvider {
  get name(): string {
    return `fallback(${this.currentProvider().name})`
  }
  get model(): string {
    return this.currentProvider().model
  }
  get modelType(): ModelType {
    return this.currentProvider().modelType
  }

  private providers: LLMProvider[]
  private groups: ProviderGroup[]

  // 当前活跃的平台索引和模型索引（跨重启持久化）
  private currentGroupIdx: number
  private currentModelIdx: number

  constructor(providers: LLMProvider[], groups?: ProviderGroup[]) {
    if (providers.length === 0) throw new Error('FallbackProvider 至少需要一个提供商')
    this.providers = providers
    this.groups = groups ?? []

    // 从磁盘恢复上次成功的位置
    const saved = loadState()
    const maxGroupIdx = Math.max(0, (this.groups.length || 1) - 1)
    this.currentGroupIdx = Math.min(saved.groupIdx, maxGroupIdx)
    const maxModelIdx = this.groups.length > 0
      ? Math.max(0, this.groups[this.currentGroupIdx].providers.length - 1)
      : Math.max(0, this.providers.length - 1)
    this.currentModelIdx = Math.min(saved.modelIdx, maxModelIdx)

    if (saved.groupIdx > 0 || saved.modelIdx > 0) {
      const p = this.currentProvider()
      log.info(`从上次记忆位置恢复: ${p.name}/${p.model}`, { groupIdx: this.currentGroupIdx, modelIdx: this.currentModelIdx })
    }
  }

  private currentProvider(): LLMProvider {
    if (this.groups.length > 0) {
      return this.groups[this.currentGroupIdx].providers[this.currentModelIdx]
    }
    return this.providers[this.currentModelIdx]
  }

  // 推进到下一个可用模型，到末尾后循环回第一个，返回是否发生了循环（绕回头）
  private advance(): { hasNext: boolean; wrapped: boolean } {
    if (this.groups.length > 0) {
      const group = this.groups[this.currentGroupIdx]
      if (this.currentModelIdx < group.providers.length - 1) {
        // 同平台下一个模型
        this.currentModelIdx++
        return { hasNext: true, wrapped: false }
      }
      if (this.currentGroupIdx < this.groups.length - 1) {
        // 跨平台
        this.currentGroupIdx++
        this.currentModelIdx = 0
        return { hasNext: true, wrapped: false }
      }
      // 已是最后一个，循环回第一个
      this.currentGroupIdx = 0
      this.currentModelIdx = 0
      return { hasNext: true, wrapped: true }
    }
    // 无分组，打平列表
    if (this.currentModelIdx < this.providers.length - 1) {
      this.currentModelIdx++
      return { hasNext: true, wrapped: false }
    }
    // 已是最后一个，循环回第一个
    this.currentModelIdx = 0
    return { hasNext: true, wrapped: true }
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string,
    maxTokens: number,
  ): AsyncGenerator<StreamChunk> {
    // 从当前记住的位置开始尝试
    // 每个模型最多重试 MAX_RETRIES_PER_MODEL 次，全部失败后切换下一个模型
    let modelSwitches = 0

    while (true) {
      const provider = this.currentProvider()
      const platformInfo = this.groups.length > 0
        ? `平台[${this.currentGroupIdx + 1}/${this.groups.length}]:${this.groups[this.currentGroupIdx].platformName} `
        : ''

      // 对当前模型最多尝试 MAX_RETRIES_PER_MODEL 次
      let lastErr: unknown
      let succeeded = false

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
        log.info(
          `${platformInfo}尝试模型: ${provider.name}/${provider.model}` +
          (attempt > 1 ? `（第 ${attempt}/${MAX_RETRIES_PER_MODEL} 次重试）` : ''),
        )

        try {
          const gen = provider.stream(messages, tools, systemPrompt, maxTokens)
          const buffer: StreamChunk[] = []

          for await (const chunk of gen) {
            buffer.push(chunk)

            // 已有实质性输出，直接透传剩余流（此时不再 fallback）
            if (chunk.type === 'text_delta' || chunk.type === 'tool_call') {
              saveState(this.currentGroupIdx, this.currentModelIdx)
              yield chunk
              for await (const rest of gen) {
                yield rest
              }
              return
            }

            if (chunk.type === 'done') {
              saveState(this.currentGroupIdx, this.currentModelIdx)
              yield chunk
              return
            }
          }

          // 流正常结束
          saveState(this.currentGroupIdx, this.currentModelIdx)
          for (const chunk of buffer) yield chunk
          succeeded = true
          return

        } catch (err) {
          lastErr = err
          if (attempt < MAX_RETRIES_PER_MODEL) {
            log.warn(
              `模型 ${provider.name}/${provider.model} 第 ${attempt} 次失败，将重试（${attempt}/${MAX_RETRIES_PER_MODEL}）`,
              { error: String(err) },
            )
            // 简单等待后重试（指数退避：1s, 2s）
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
          }
        }
      }

      if (succeeded) return

      // 当前模型三次全部失败，尝试切换下一个模型
      const { wrapped } = this.advance()
      modelSwitches++

      const next = this.currentProvider()
      const nextPlatform = this.groups.length > 0
        ? `平台[${this.currentGroupIdx + 1}]:${this.groups[this.currentGroupIdx].platformName}/`
        : ''

      if (wrapped) {
        // 已循环回第一个模型，说明所有模型都试过了
        log.error('所有模型均失败，无法继续', { error: String(lastErr), modelSwitches })
        throw new Error(
          `所有模型均失败（每个模型重试 ${MAX_RETRIES_PER_MODEL} 次，共切换 ${modelSwitches} 次）。` +
          `最后错误: ${String(lastErr)}`,
        )
      }

      log.warn(
        `模型 ${provider.name}/${provider.model} 重试 ${MAX_RETRIES_PER_MODEL} 次均失败，` +
        `切换到 ${nextPlatform}${next.model}`,
        { error: String(lastErr) },
      )
    }
  }
}
