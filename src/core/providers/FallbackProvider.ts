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
  // 每个 provider 对应一个 circuit breaker（按扁平索引）
  private breakers: CircuitBreaker[]

  // 当前活跃的平台索引和模型索引（跨重启持久化）
  private currentGroupIdx: number
  private currentModelIdx: number

  constructor(providers: LLMProvider[], groups?: ProviderGroup[]) {
    if (providers.length === 0) throw new Error('FallbackProvider 至少需要一个提供商')
    this.providers = providers
    this.groups = groups ?? []
    this.currentGroupIdx = 0
    this.currentModelIdx = 0
    // 为每个 provider 创建独立的 circuit breaker
    const total = this.groups.length > 0
      ? this.groups.reduce((sum, g) => sum + g.providers.length, 0)
      : providers.length
    this.breakers = Array.from({ length: total }, () => new CircuitBreaker())
  }

  // 获取当前 provider 对应的 circuit breaker 扁平索引
  private currentBreakerIdx(): number {
    if (this.groups.length === 0) return this.currentModelIdx
    let idx = 0
    for (let g = 0; g < this.currentGroupIdx; g++) {
      idx += this.groups[g].providers.length
    }
    return idx + this.currentModelIdx
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

    // 从当前记住的位置开始尝试
    // 每个模型最多重试 MAX_RETRIES_PER_MODEL 次，全部失败后切换下一个模型
    const totalProviders = this.groups.length > 0
      ? this.groups.reduce((sum, g) => sum + g.providers.length, 0)
      : this.providers.length
    // failedSwitches：真实失败后切换的次数，用于判断是否所有模型都试过了
    let failedSwitches = 0
    // skippedSwitches：熔断跳过的次数，用于判断是否所有模型都在熔断中
    let skippedSwitches = 0

    while (true) {
      // 每次循环开头检查是否已中止
      if (signal?.aborted) return

      const provider = this.currentProvider()
      const breakerIdx = this.currentBreakerIdx()
      const breaker = this.breakers[breakerIdx]
      const platformInfo = this.groups.length > 0
        ? `平台[${this.currentGroupIdx + 1}/${this.groups.length}]:${this.groups[this.currentGroupIdx].platformName} `
        : ''

      // Circuit breaker 熔断检查：跳过当前已熔断的 provider
      if (breaker.isOpen()) {
        log.warn(`${platformInfo}模型 ${provider.model} 处于熔断状态，跳过`, { breakerIdx })
        this.advance()
        skippedSwitches++

        if (skippedSwitches >= totalProviders) {
          // 所有模型都熔断了，等待最短冷却时间后重试，避免 CPU 空转死循环
          const minWait = Math.min(...this.breakers.map(b => b.getTimeUntilOpen()))
          const waitMs = Math.max(minWait, 1000) // 至少等 1s
          log.warn(`所有模型均处于熔断状态，等待 ${waitMs}ms 后重试`)
          try { await sleep(waitMs) } catch { return } // abort 时直接退出
          skippedSwitches = 0 // 重置计数，重新开始一轮
        }
        continue
      }
      // 进入真实尝试，重置熔断跳过计数
      skippedSwitches = 0

      // 对当前模型最多尝试 MAX_RETRIES_PER_MODEL 次
      let lastErr: unknown

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
        log.info(
          `${platformInfo}尝试模型: ${provider.name}/${provider.model}` +
          (attempt > 1 ? `（第 ${attempt}/${MAX_RETRIES_PER_MODEL} 次重试）` : ''),
        )
        log.debug('LLM 请求参数', { model: provider.model, messagesCount: messages.length, toolsCount: tools.length, maxTokens })

        try {
          const gen = provider.stream(messages, tools, systemPrompt, maxTokens)
          // 缓存实质性内容前的 usage/stop_reason 等元数据 chunk
          const preContentBuffer: StreamChunk[] = []
          let hasContent = false

          for await (const chunk of gen) {
            // 已有实质性输出，锁定当前模型，直接透传剩余流（此时不再 fallback）
            if (chunk.type === 'text_delta' || chunk.type === 'tool_call') {
              if (!hasContent) {
                hasContent = true
                log.debug('LLM 开始输出，锁定当前模型', { model: provider.model, chunkType: chunk.type })
                breaker.recordSuccess()
                // 先把缓冲的元数据 chunk 补发出去
                for (const buffered of preContentBuffer) yield buffered
              }
              yield chunk
              continue
            }

            if (hasContent) {
              // 已锁定模型，直接透传所有后续 chunk（包括 done）
              yield chunk
              if (chunk.type === 'done') return
              continue
            }

            // 尚未出现实质性内容，先缓冲元数据 chunk
            if (chunk.type === 'done') {
              // 流结束但没有任何实质性内容，视为空响应，触发 fallback
              log.warn(`模型 ${provider.model} 返回空响应，触发 fallback`, { attempt })
              lastErr = new Error('模型返回空响应（无文本也无工具调用）')
              break
            }
            preContentBuffer.push(chunk)
          }

          if (hasContent) return // 流正常结束（done chunk 已 yield）

          // 空响应（包括 generator 未发任何 chunk 就结束的情况）：继续下一次 attempt
          if (!lastErr) lastErr = new Error('模型返回空响应（generator 未发送任何 chunk）')
        } catch (err) {
          lastErr = err
          if (attempt < MAX_RETRIES_PER_MODEL) {
            log.warn(
              `模型 ${provider.name}/${provider.model} 第 ${attempt} 次失败，将重试（${attempt}/${MAX_RETRIES_PER_MODEL}）`,
              { error: String(err) },
            )
            // 指数退避：1s, 2s
            try { await sleep(1000 * attempt) } catch { return } // abort 时直接退出
          }
        }
      }

      // 当前模型 MAX_RETRIES_PER_MODEL 次全部失败，记录到 circuit breaker 并切换下一个模型
      breaker.recordFailure()
      this.advance()
      failedSwitches++

      const next = this.currentProvider()
      const nextPlatform = this.groups.length > 0
        ? `平台[${this.currentGroupIdx + 1}]:${this.groups[this.currentGroupIdx].platformName}/`
        : ''

      if (failedSwitches >= totalProviders) {
        // 所有模型都真实失败过一次，无法继续
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
