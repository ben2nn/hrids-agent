// FallbackProvider — 多 LLM 故障转移
// 当前模型重试 MAX_RETRIES 次，全部失败后切换下一个模型
// 记住当前位置，下次调用直接从上次成功的模型开始（进程内存级，不跨进程持久化）
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, StreamChunk } from './types.js'
import { logger } from '../logger.js'

const log = logger.child({ component: 'fallback-provider' })

const MAX_RETRIES = 3

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
  private currentGroupIdx: number
  private currentModelIdx: number

  constructor(providers: LLMProvider[], groups?: ProviderGroup[]) {
    if (providers.length === 0) throw new Error('FallbackProvider 至少需要一个提供商')
    this.providers = providers
    this.groups = groups ?? []
    this.currentGroupIdx = 0
    this.currentModelIdx = 0
  }

  private currentProvider(): LLMProvider {
    if (this.groups.length > 0) {
      return this.groups[this.currentGroupIdx].providers[this.currentModelIdx]
    }
    return this.providers[this.currentModelIdx]
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string[],
    maxTokens: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const totalProviders = this.groups.length > 0
      ? this.groups.reduce((sum, g) => sum + g.providers.length, 0)
      : this.providers.length

    // 并发安全：每次 stream() 使用独立的局部索引
    let localGroupIdx = this.currentGroupIdx
    let localModelIdx = this.currentModelIdx

    const getProvider = () => {
      if (this.groups.length > 0) return this.groups[localGroupIdx].providers[localModelIdx]
      return this.providers[localModelIdx]
    }

    const advance = () => {
      if (this.groups.length > 0) {
        const group = this.groups[localGroupIdx]
        if (localModelIdx < group.providers.length - 1) { localModelIdx++; return }
        if (localGroupIdx < this.groups.length - 1) { localGroupIdx++; localModelIdx = 0; return }
        localGroupIdx = 0; localModelIdx = 0; return
      }
      if (localModelIdx < this.providers.length - 1) { localModelIdx++; return }
      localModelIdx = 0
    }

    let failedSwitches = 0

    while (true) {
      if (signal?.aborted) return

      const provider = getProvider()
      const platformInfo = this.groups.length > 0
        ? `平台[${localGroupIdx + 1}/${this.groups.length}]:${this.groups[localGroupIdx].platformName} `
        : ''

      let lastErr: unknown

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        log.info(
          `${platformInfo}尝试模型: ${provider.name}/${provider.model}` +
          (attempt > 1 ? `（第 ${attempt}/${MAX_RETRIES} 次重试）` : ''),
        )

        try {
          let hasContent = false
          for await (const chunk of provider.stream(messages, tools, systemPrompt, maxTokens)) {
            if (!hasContent && (chunk.type === 'text_delta' || chunk.type === 'tool_call')) {
              hasContent = true
              // 成功后原子更新实例状态
              ;[this.currentGroupIdx, this.currentModelIdx] = [localGroupIdx, localModelIdx]
            }
            if (chunk.type === 'done') {
              if (!hasContent) {
                lastErr = new Error('模型返回空响应')
                break
              }
              yield chunk
              return
            }
            yield chunk
          }
          if (hasContent) return
          if (!lastErr) lastErr = new Error('模型返回空响应')
        } catch (err) {
          lastErr = err
          if (attempt < MAX_RETRIES) {
            log.warn(`模型 ${provider.name}/${provider.model} 第 ${attempt} 次失败，将重试`, { error: String(err) })
            await new Promise(r => setTimeout(r, 1000 * attempt))
          }
        }
      }

      advance()
      failedSwitches++

      if (failedSwitches >= totalProviders) {
        log.error('所有模型均失败', { error: String(lastErr) })
        throw new Error(`所有模型均失败（每个重试 ${MAX_RETRIES} 次）。最后错误：${String(lastErr)}`)
      }

      const next = getProvider()
      log.warn(
        `模型 ${provider.name}/${provider.model} ${MAX_RETRIES} 次均失败，切换到 ${next.model}`,
        { error: String(lastErr) },
      )
    }
  }
}
