// FallbackProvider — 多 LLM 故障转移 + 指数退避重试
// 每个 provider 最多重试 MAX_RETRIES 次（仅对 retryable 错误），全部失败后切换下一个 provider
// 记住当前位置，下次调用直接从上次成功的模型开始（进程内存级，不跨进程持久化）
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, StreamChunk } from './types.js'
import { LlmError } from '../LlmError.js'
import { logger } from '../logger.js'

export interface FallbackStatusEvent {
  type: 'retrying' | 'switching' | 'rate_limited'
  provider: string
  model: string
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  reason?: string
}

const log = logger.child({ component: 'fallback-provider' })

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 16000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
}

function calcBackoff(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs) return retryAfterMs
  const exp = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
  return exp * (0.75 + Math.random() * 0.5) // ±25% 抖动
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
  private currentGroupIdx: number
  private currentModelIdx: number
  private onStatus?: (event: FallbackStatusEvent) => void

  constructor(providers: LLMProvider[], groups?: ProviderGroup[], onStatus?: (event: FallbackStatusEvent) => void) {
    if (providers.length === 0) throw new Error('FallbackProvider 至少需要一个提供商')
    this.providers = providers
    this.groups = groups ?? []
    this.currentGroupIdx = 0
    this.currentModelIdx = 0
    this.onStatus = onStatus
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
      let retryable = false

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        log.info(
          `${platformInfo}尝试模型: ${provider.name}/${provider.model}` +
          (attempt > 1 ? `（第 ${attempt}/${MAX_RETRIES} 次重试）` : ''),
        )

        let hasContent = false
        try {
          let thinkingCount = 0
          let textCount = 0
          let toolCallCount = 0

          for await (const chunk of provider.stream(messages, tools, systemPrompt, maxTokens, signal)) {
            if (chunk.type === 'thinking_delta') thinkingCount++
            if (chunk.type === 'text_delta') textCount++
            if (chunk.type === 'tool_call') toolCallCount++

            if (!hasContent && (chunk.type === 'text_delta' || chunk.type === 'tool_call' || chunk.type === 'thinking_delta')) {
              hasContent = true
              ;[this.currentGroupIdx, this.currentModelIdx] = [localGroupIdx, localModelIdx]
            }
            if (chunk.type === 'done') {
              if (!hasContent) {
                log.warn('模型返回空响应', { provider: provider.name, model: provider.model, thinkingCount, textCount, toolCallCount })
                lastErr = new LlmError('unknown', '模型返回空响应', true)
                break
              }
              yield chunk
              return
            }
            yield chunk
          }
          if (hasContent) return
          log.warn('模型返回空响应（流结束）', { provider: provider.name, model: provider.model, thinkingCount, textCount, toolCallCount })
          if (!lastErr) lastErr = new LlmError('unknown', '模型返回空响应', true)
        } catch (err) {
          lastErr = err
          const llmErr = LlmError.fromUnknown(err)
          retryable = llmErr.retryable
          // 已经 yield 过内容给调用方，不能重试（否则调用方会收到重复内容）
          if (hasContent) {
            log.warn('流式输出中途出错，已有内容不可重试', { provider: provider.name, error: llmErr.message })
            throw err
          }
          if (!retryable) {
            log.warn(`模型 ${provider.name}/${provider.model} 不可恢复错误，跳过重试`, { code: llmErr.code, error: llmErr.message })
            break
          }
          if (attempt < MAX_RETRIES) {
            const delay = calcBackoff(attempt, llmErr.retryAfterMs)
            log.warn(`模型 ${provider.name}/${provider.model} 第 ${attempt} 次失败，${Math.round(delay / 1000)}s 后重试`, { code: llmErr.code, error: llmErr.message })
            // 发射状态事件：限流时提示用户等待时间
            if (llmErr.code === 'rate_limited') {
              this.onStatus?.({ type: 'rate_limited', provider: provider.name, model: provider.model, delayMs: delay, attempt, maxAttempts: MAX_RETRIES, reason: llmErr.message })
            } else {
              this.onStatus?.({ type: 'retrying', provider: provider.name, model: provider.model, attempt, maxAttempts: MAX_RETRIES, delayMs: delay, reason: llmErr.message })
            }
            try { await sleep(delay, signal) } catch { return }
          }
        }
      }

      advance()
      failedSwitches++

      if (failedSwitches >= totalProviders) {
        log.error('所有模型均失败', { error: String(lastErr) })
        throw lastErr instanceof LlmError ? lastErr : new LlmError('unknown', `所有模型均失败。最后错误：${String(lastErr)}`, false, undefined, lastErr)
      }

      const next = getProvider()
      log.warn(
        `模型 ${provider.name}/${provider.model} ${MAX_RETRIES} 次均失败，切换到 ${next.model}`,
        { error: String(lastErr) },
      )
      this.onStatus?.({ type: 'switching', provider: next.name, model: next.model, reason: `${provider.model} 失败` })
    }
  }
}
