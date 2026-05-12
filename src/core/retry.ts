// 指数退避重试工具 —— 用于 LLM API 调用和网络请求
import { logger } from './logger.js'
import { LlmError } from './LlmError.js'

export interface RetryOptions {
  maxAttempts?: number      // 最大尝试次数（含首次），默认 3
  baseDelayMs?: number      // 初始等待时间（ms），默认 1000
  maxDelayMs?: number       // 最大等待时间（ms），默认 30000
  jitter?: boolean          // 是否加随机抖动，默认 true
  retryIf?: (err: unknown) => boolean  // 自定义判断是否可重试，默认使用 LlmError.retryable
}

/** 将任意错误转为 LlmError，统一判断可重试性 */
function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err
  return LlmError.fromUnknown(err)
}

/** 默认重试判断：统一走 LlmError 结构化判断，不再维护重复的字符串匹配 */
function defaultRetryIf(err: unknown): boolean {
  return toLlmError(err).retryable
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function calcDelay(attempt: number, baseMs: number, maxMs: number, jitter: boolean): number {
  // 指数退避：1s, 2s, 4s, 8s...
  const exp = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs)
  if (!jitter) return exp
  // 加 ±25% 随机抖动，避免多个请求同时重试
  return exp * (0.75 + Math.random() * 0.5)
}

/** 解析重试选项，填充默认值 */
function resolveOpts(opts: RetryOptions) {
  return {
    maxAttempts: opts.maxAttempts ?? 3,
    baseDelayMs: opts.baseDelayMs ?? 1000,
    maxDelayMs: opts.maxDelayMs ?? 30000,
    jitter: opts.jitter ?? true,
    retryIf: opts.retryIf ?? defaultRetryIf,
  }
}

/** 计算重试延迟并记录日志 */
function calcRetryDelay(err: unknown, attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: boolean, context: string, maxAttempts: number): number {
  const llmErr = toLlmError(err)
  const delay = llmErr.retryAfterMs ?? calcDelay(attempt, baseDelayMs, maxDelayMs, jitter)
  logger.warn(`${context} 失败，${Math.round(delay / 1000)}s 后重试（${attempt}/${maxAttempts - 1}）`, {
    error: llmErr.message,
    code: llmErr.code,
  })
  return delay
}

// 对普通 async 函数的重试包装
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
  context = '操作',
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitter, retryIf } = resolveOpts(opts)

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === maxAttempts || !retryIf(err)) {
        throw err
      }
      const delay = calcRetryDelay(err, attempt, baseDelayMs, maxDelayMs, jitter, context, maxAttempts)
      await sleep(delay)
    }
  }
  throw lastErr
}


