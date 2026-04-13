// FallbackProvider —— 多 LLM 故障转移
// 任何错误都触发切换，并记住当前位置，下次调用直接从上次成功的模型开始
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, StreamChunk } from './types.js'
import { logger } from '../logger.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const log = logger.child({ component: 'fallback-provider' })

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

  // 推进到下一个可用模型，返回是否还有下一个
  private advance(): boolean {
    if (this.groups.length > 0) {
      const group = this.groups[this.currentGroupIdx]
      if (this.currentModelIdx < group.providers.length - 1) {
        // 同平台下一个模型
        this.currentModelIdx++
        return true
      }
      if (this.currentGroupIdx < this.groups.length - 1) {
        // 跨平台
        this.currentGroupIdx++
        this.currentModelIdx = 0
        return true
      }
      return false
    }
    // 无分组，打平列表
    if (this.currentModelIdx < this.providers.length - 1) {
      this.currentModelIdx++
      return true
    }
    return false
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string,
    maxTokens: number,
  ): AsyncGenerator<StreamChunk> {
    // 从当前记住的位置开始尝试，失败则依次推进
    const startGroupIdx = this.currentGroupIdx
    const startModelIdx = this.currentModelIdx
    let attempts = 0
    const totalProviders = this.groups.length > 0
      ? this.groups.reduce((s, g) => s + g.providers.length, 0)
      : this.providers.length

    while (true) {
      const provider = this.currentProvider()
      const platformInfo = this.groups.length > 0
        ? `平台[${this.currentGroupIdx + 1}/${this.groups.length}]:${this.groups[this.currentGroupIdx].platformName} `
        : ''
      log.info(`${platformInfo}尝试模型: ${provider.name}/${provider.model}`)

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
        return

      } catch (err) {
        attempts++
        const hasNext = this.advance()

        if (hasNext) {
          const next = this.currentProvider()
          const nextPlatform = this.groups.length > 0
            ? `平台[${this.currentGroupIdx + 1}]:${this.groups[this.currentGroupIdx].platformName}/`
            : ''
          log.warn(
            `模型 ${provider.name}/${provider.model} 失败，切换到 ${nextPlatform}${next.model}`,
            { error: String(err) }
          )
          continue
        }

        // 所有模型都试过了
        log.error('所有模型均失败，无法继续', { error: String(err), attempts })
        throw new Error(`所有模型均失败（共尝试 ${attempts} 个）。最后错误: ${String(err)}`)
      }
    }
  }
}
