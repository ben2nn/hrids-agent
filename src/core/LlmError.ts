// 统一 LLM 错误分类 —— 替代字符串匹配的错误判断
//
// 设计依据：DeepSeek-TUI 的 LlmError 分类 + hrids-agent 现有 retry.ts 的 defaultRetryIf

export type LlmErrorCode =
  | 'rate_limited'      // HTTP 429
  | 'server_error'      // HTTP 5xx
  | 'network_error'     // 连接失败、DNS 解析失败
  | 'timeout'           // 请求/流式读取超时
  | 'auth_error'        // HTTP 401/403
  | 'invalid_request'   // HTTP 400
  | 'model_error'       // 模型不存在、额度耗尽
  | 'content_policy'    // 内容过滤/安全策略拒绝
  | 'unknown'           // 未分类错误

export class LlmError extends Error {
  override readonly name = 'LlmError'

  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly retryable: boolean,
    /** 服务端建议的重试等待时间（ms），来自 Retry-After 头 */
    public readonly retryAfterMs?: number,
    /** 原始错误对象，用于日志和调试 */
    public readonly cause?: unknown,
  ) {
    super(message)
  }

  /** 从任意异常推断 LlmError */
  static fromUnknown(err: unknown): LlmError {
    if (err instanceof LlmError) return err

    const msg = err instanceof Error ? err.message : String(err)
    const lower = msg.toLowerCase()

    // 网络错误
    if (lower.includes('fetch failed') || lower.includes('econnreset') || lower.includes('econnrefused')
      || lower.includes('network') || lower.includes('socket hang up')
      || lower.includes('etimedout') || lower.includes('enotfound')) {
      return new LlmError('network_error', msg, true, undefined, err)
    }

    // 超时
    if (lower.includes('timeout') || lower.includes('超时') || lower.includes('流式读取超时')) {
      return new LlmError('timeout', msg, true, undefined, err)
    }

    // HTTP 429 限流
    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
      const retryAfter = extractRetryAfter(msg)
      return new LlmError('rate_limited', msg, true, retryAfter, err)
    }

    // HTTP 401/403 认证
    if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized')
      || lower.includes('forbidden') || lower.includes('authentication')) {
      return new LlmError('auth_error', msg, false, undefined, err)
    }

    // HTTP 400 请求参数错误
    if (lower.includes('400') || lower.includes('bad request') || lower.includes('invalid request')) {
      return new LlmError('invalid_request', msg, false, undefined, err)
    }

    // HTTP 5xx 服务端错误
    if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('504')) {
      return new LlmError('server_error', msg, true, undefined, err)
    }

    // 内容策略
    if (lower.includes('content_policy') || lower.includes('safety') || lower.includes('blocked')) {
      return new LlmError('content_policy', msg, false, undefined, err)
    }

    // 未分类：默认不可重试（安全策略：宁可中断也不盲目重试）
    return new LlmError('unknown', msg, false, undefined, err)
  }
}

/** 从错误消息中提取 Retry-After 值（秒 → 毫秒） */
function extractRetryAfter(msg: string): number | undefined {
  const match = msg.match(/retry[- ]?after[:\s]+(\d+)/i)
  if (match) return parseInt(match[1], 10) * 1000
  return undefined
}
