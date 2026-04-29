// FallbackProvider — 多 LLM 故障转移
// 当前模型重试 MAX_RETRIES_PER_MODEL 次，全部失败后切换下一个模型
// 记住当前位置，下次调用直接从上次成功的模型开始（进程内存级，不跨进程持久化）
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, StreamChunk } from './types.js'
import { logger } from '../logger.js'

const log = logger.child({ component: 'fallback-provider' })

// 每个模型在切换前的最大重试次数
const MAX_RETRIES_PER_MODEL = 3

// Circuit Breaker：对连续失败的 provider 临时熔断，避免立即重试已知故障的模型
// 连续失败 3 次后熔断 60 秒，期间跳过该 provider
class CircuitBreaker {
  private failures = 0
  private openUntil = 0
  private readonly threshold: number
  private readonly cooldownMs: number

  constructor(threshold = 3, cooldownMs = 60_000) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
  }

  isOpen(): boolean {
    return Date.now() < this.openUntil
  }

  getTimeUntilOpen(): number {
    return Math.max(0, this.openUntil - Date.now())
  }

  recordFailure(): void {
    this.failures++
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.cooldownMs
      log.warn(`Circuit breaker 触发，熔断 ${this.cooldownMs / 1000}s`, { failures: this.failures })
    }
  }

  recordSuccess(): void {
    this.failures = 0
    this.openUntil = 0
  }
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
  private breakers: CircuitBreaker[]
  private currentGroupIdx: number
  private currentModelIdx: number
  // 互斥锁：防止并发子智能体同时修改 currentGroupIdx/currentModelIdx
  private _advanceLock = false

  constructor(providers: LLMProvider[], groups?: ProviderGroup[]) {
    if (providers.length === 0) throw new Error('FallbackProvider 至少需要一个提供商')
    this.providers = providers
    this.groups = groups ?? []
    this.currentGroupIdx = 0
    this.currentModelIdx = 0
    const total = this.groups.length > 0
      ? this.groups.reduce((sum, g) => sum + g.providers.length, 0)
      : providers.length
    this.breakers = Array.from({ length: total }, () => new CircuitBreaker())
  }

  // 获取当前 provider（供 name/model/modelType getter 使用）
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
    // 可被 abort 打断的 sleep 工具函数
    const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    })

    const totalProviders = this.groups.length > 0
      ? this.groups.reduce((sum, g) => sum + g.providers.length, 0)
      : this.providers.length

    // 并发安全：每次 stream() 调用使用独立的局部索引，不修改实例状态
    // 这样多个并发子智能体各自独立推进，不会互相干扰
    let localGroupIdx = this.currentGroupIdx
    let localModelIdx = this.currentModelIdx

    const localCurrentProvider = () => {
      if (this.groups.length > 0) {
        return this.groups[localGroupIdx].providers[localModelIdx]
      }
      return this.providers[localModelIdx]
    }

    const localCurrentBreakerIdx = () => {
      if (this.groups.length === 0) return localModelIdx
      let idx = 0
      for (let g = 0; g < localGroupIdx; g++) idx += this.groups[g].providers.length
      return idx + localModelIdx
    }

    const localAdvance = () => {
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
    let skippedSwitches = 0

    while (true) {
      if (signal?.aborted) return

      const provider = localCurrentProvider()
      const breakerIdx = localCurrentBreakerIdx()
      const breaker = this.breakers[breakerIdx]
      const platformInfo = this.groups.length > 0
        ? `平台[${localGroupIdx + 1}/${this.groups.length}]:${this.groups[localGroupIdx].platformName} `
        : ''

      if (breaker.isOpen()) {
        log.warn(`${platformInfo}模型 ${provider.model} 处于熔断状态，跳过`, { breakerIdx })
        localAdvance()
        skippedSwitches++

        if (skippedSwitches >= totalProviders) {
          const minWait = Math.min(...this.breakers.map(b => b.getTimeUntilOpen()))
          const waitMs = Math.max(minWait, 1000)
          log.warn(`所有模型均处于熔断状态，等待 ${waitMs}ms 后重试`)
          try { await sleep(waitMs) } catch { return }
          skippedSwitches = 0
        }
        continue
      }
      skippedSwitches = 0

      let lastErr: unknown

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
        log.info(
          `${platformInfo}尝试模型: ${provider.name}/${provider.model}` +
          (attempt > 1 ? `（第 ${attempt}/${MAX_RETRIES_PER_MODEL} 次重试）` : ''),
        )
        log.debug('LLM 请求参数', { model: provider.model, messagesCount: messages.length, toolsCount: tools.length, maxTokens })

        try {
          const gen = provider.stream(messages, tools, systemPrompt, maxTokens)
          const preContentBuffer: StreamChunk[] = []
          let hasContent = false

          for await (const chunk of gen) {
            if (chunk.type === 'text_delta' || chunk.type === 'tool_call') {
              if (!hasContent) {
                hasContent = true
                log.debug('LLM 开始输出，锁定当前模型', { model: provider.model, chunkType: chunk.type })
                breaker.recordSuccess()
                // 成功后同步实例状态，下次调用从此模型开始
                this.currentGroupIdx = localGroupIdx
                this.currentModelIdx = localModelIdx
                for (const buffered of preContentBuffer) yield buffered
              }
              yield chunk
              continue
            }

            if (hasContent) {
              yield chunk
              if (chunk.type === 'done') return
              continue
            }

            if (chunk.type === 'done') {
              log.warn(`模型 ${provider.model} 返回空响应，触发 fallback`, { attempt })
              lastErr = new Error('模型返回空响应（无文本也无工具调用）')
              break
            }
            preContentBuffer.push(chunk)
          }

          if (hasContent) return

          if (!lastErr) lastErr = new Error('模型返回空响应（generator 未发送任何 chunk）')
        } catch (err) {
          lastErr = err
          if (attempt < MAX_RETRIES_PER_MODEL) {
            log.warn(
              `模型 ${provider.name}/${provider.model} 第 ${attempt} 次失败，将重试（${attempt}/${MAX_RETRIES_PER_MODEL}）`,
              { error: String(err) },
            )
            try { await sleep(1000 * attempt) } catch { return }
          }
        }
      }

      breaker.recordFailure()
      localAdvance()
      failedSwitches++

      const next = localCurrentProvider()
      const nextPlatform = this.groups.length > 0
        ? `平台[${localGroupIdx + 1}]:${this.groups[localGroupIdx].platformName}/`
        : ''

      if (failedSwitches >= totalProviders) {
        log.error('所有模型均失败，无法继续', { error: String(lastErr), failedSwitches })
        throw new Error(
          `所有模型均失败（每个模型重试 ${MAX_RETRIES_PER_MODEL} 次，共切换 ${failedSwitches} 次）。` +
          `最后错误：${String(lastErr)}`,
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
