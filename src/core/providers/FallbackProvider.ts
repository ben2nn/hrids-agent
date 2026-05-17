// FallbackProvider — 多 LLM 故障转移 + 指数退避重试
// 每个 provider 最多重试 MAX_RETRIES 次（仅对 retryable 错误），全部失败后切换下一个 provider
// 记住当前位置，下次调用直接从上次成功的模型开始（进程内存级，不跨进程持久化）
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, StreamChunk } from './types.js'
import { LlmError } from '../LlmError.js'
import { logger, modelLog } from '../logger.js'

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
  private currentModelIdx: number
  private onStatus?: (event: FallbackStatusEvent) => void

  constructor(providers: LLMProvider[], groups?: ProviderGroup[], onStatus?: (event: FallbackStatusEvent) => void) {
    if (providers.length === 0) throw new Error('FallbackProvider 至少需要一个提供商')
    this.providers = providers
    this.groups = groups ?? []
    this.currentModelIdx = 0
    this.onStatus = onStatus
  }

  /**
   * 手动选择指定模型（由 /model 命令调用）。
   * 在 providers 列表中查找匹配的 provider，找到后更新内部索引，
   * 使下次 stream() 直接从该模型开始。
   * 支持 "model" 或 "provider:model" 格式。
   */
  selectModel(model: string): boolean {
    const modelOnly = model.includes(':') ? model.split(':').slice(1).join(':') : model

    // 在展平的 allProviders 中查找，用全局索引
    const all = this.groups.length > 0
      ? this.groups.flatMap(g => g.providers)
      : this.providers
    for (let i = 0; i < all.length; i++) {
      if (all[i].model === modelOnly) {
        this.currentModelIdx = i
        return true
      }
    }
    return false
  }

  private currentProvider(): LLMProvider {
    const all = this.groups.length > 0
      ? this.groups.flatMap(g => g.providers)
      : this.providers
    return all[this.currentModelIdx % all.length]
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string[],
    maxTokens: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    // 展平所有 provider 为一维数组
    const allProviders: LLMProvider[] = this.groups.length > 0
      ? this.groups.flatMap(g => g.providers)
      : [...this.providers]
    const failed = new Set<number>()

    // 从上次成功的位置开始
    let cursor = this.currentModelIdx
    let lastErr: unknown
    let lastErrCode = ''
    let lastErrMsg = ''

    while (failed.size < allProviders.length) {
      if (signal?.aborted) return

      // 跳过已失败的模型
      let attempts = 0
      while (failed.has(cursor) && attempts < allProviders.length) {
        cursor = (cursor + 1) % allProviders.length
        attempts++
      }
      if (failed.has(cursor)) break

      const provider = allProviders[cursor]
      log.info(`尝试模型: ${provider.name}/${provider.model}（剩余 ${allProviders.length - failed.size}/${allProviders.length}）`)

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 1) log.info(`  重试 ${attempt}/${MAX_RETRIES}: ${provider.name}/${provider.model}`)

        let hasContent = false
        try {
          for await (const chunk of provider.stream(messages, tools, systemPrompt, maxTokens, signal)) {
            modelLog.write(`[chunk] ${provider.model}`, { type: chunk.type, delta: chunk.delta?.slice(0, 30), hasContent })
            if (!hasContent && (chunk.type === 'text_delta' || chunk.type === 'tool_call' || chunk.type === 'thinking_delta')) {
              hasContent = true
              this.currentModelIdx = cursor
            }
            if (chunk.type === 'done' && !hasContent) {
              lastErr = new LlmError('unknown', '模型返回空响应', true)
              break
            }
            yield chunk
            if (chunk.type === 'done') return
          }
          if (hasContent) return
          log.warn(`模型 ${provider.name}/${provider.model} 返回空响应`)
          lastErr = new LlmError('unknown', '模型返回空响应', true)
        } catch (err) {
          lastErr = err
          const llmErr = LlmError.fromUnknown(err)
          lastErrCode = llmErr.code
          lastErrMsg = llmErr.message
          if (hasContent) throw err
          if (!llmErr.retryable) {
            log.warn(`模型 ${provider.name}/${provider.model} 不可恢复错误: ${llmErr.message}`)
            break
          }
          if (attempt < MAX_RETRIES) {
            const delay = calcBackoff(attempt, llmErr.retryAfterMs)
            log.warn(`模型 ${provider.name}/${provider.model} 第 ${attempt} 次失败（${llmErr.code}: ${llmErr.message}），${Math.round(delay / 1000)}s 后重试`)
            try { await sleep(delay, signal) } catch { return }
          }
        }
      }

      // 失败 → 标记为不可用，切换下一个
      failed.add(cursor)
      if (failed.size < allProviders.length) {
        cursor = (cursor + 1) % allProviders.length
        while (failed.has(cursor)) cursor = (cursor + 1) % allProviders.length
        const next = allProviders[cursor]
        log.warn(`模型 ${provider.name}/${provider.model} 已排除（${lastErrCode}: ${lastErrMsg}），切换到 ${next.model}`)
        this.onStatus?.({ type: 'switching', provider: next.name, model: next.model, reason: `${provider.model} 失败` })
      }
    }

    const errMsg = lastErr instanceof LlmError ? lastErr.message : String(lastErr)
    const errCode = lastErr instanceof LlmError ? lastErr.code : lastErrCode || 'unknown'
    log.error('所有模型均失败', { code: errCode, error: errMsg })
    throw lastErr instanceof LlmError ? lastErr : new LlmError('unknown', `所有模型均失败: ${errMsg}`, false, undefined, lastErr)
  }
}
