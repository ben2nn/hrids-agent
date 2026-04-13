// Token 用量和成本追踪

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

// 各模型每百万 token 的价格（USD）
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // Anthropic
  'claude-opus-4-5':            { input: 15,    output: 75,    cacheRead: 1.5,   cacheWrite: 18.75 },
  'claude-sonnet-4-5':          { input: 3,     output: 15,    cacheRead: 0.3,   cacheWrite: 3.75  },
  'claude-haiku-4-5':           { input: 0.8,   output: 4,     cacheRead: 0.08,  cacheWrite: 1     },
  'claude-opus-4':              { input: 15,    output: 75,    cacheRead: 1.5,   cacheWrite: 18.75 },
  'claude-sonnet-4':            { input: 3,     output: 15,    cacheRead: 0.3,   cacheWrite: 3.75  },
  'claude-3-5-sonnet-20241022': { input: 3,     output: 15,    cacheRead: 0.3,   cacheWrite: 3.75  },
  'claude-3-haiku-20240307':    { input: 0.25,  output: 1.25,  cacheRead: 0.03,  cacheWrite: 0.3   },
  // OpenAI
  'gpt-4o':                     { input: 2.5,   output: 10,    cacheRead: 1.25,  cacheWrite: 0     },
  'gpt-4o-mini':                { input: 0.15,  output: 0.6,   cacheRead: 0.075, cacheWrite: 0     },
  'gpt-4-turbo':                { input: 10,    output: 30,    cacheRead: 0,     cacheWrite: 0     },
  'o1':                         { input: 15,    output: 60,    cacheRead: 7.5,   cacheWrite: 0     },
  'o1-mini':                    { input: 1.1,   output: 4.4,   cacheRead: 0.55,  cacheWrite: 0     },
  'o3-mini':                    { input: 1.1,   output: 4.4,   cacheRead: 0.55,  cacheWrite: 0     },
  // DeepSeek
  'deepseek-chat':              { input: 0.07,  output: 1.1,   cacheRead: 0.014, cacheWrite: 0     },
  'deepseek-reasoner':          { input: 0.55,  output: 2.19,  cacheRead: 0.14,  cacheWrite: 0     },
  // Groq（免费层，计费为 0）
  'llama-3.3-70b-versatile':    { input: 0.059, output: 0.079, cacheRead: 0,     cacheWrite: 0     },
  'llama-3.1-8b-instant':       { input: 0.005, output: 0.008, cacheRead: 0,     cacheWrite: 0     },
  // Ollama 本地模型（免费）
  'ollama':                     { input: 0,     output: 0,     cacheRead: 0,     cacheWrite: 0     },
}

export class CostTracker {
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  private model: string

  constructor(model: string) {
    this.model = model
  }

  add(delta: Partial<TokenUsage>) {
    this.usage.inputTokens += delta.inputTokens ?? 0
    this.usage.outputTokens += delta.outputTokens ?? 0
    this.usage.cacheReadTokens += delta.cacheReadTokens ?? 0
    this.usage.cacheWriteTokens += delta.cacheWriteTokens ?? 0
  }

  getUsage(): TokenUsage {
    return { ...this.usage }
  }

  getCostUsd(): number {
    // 前缀匹配（处理带日期后缀的模型名，如 claude-3-5-sonnet-20241022）
    const pricing = MODEL_PRICING[this.model]
      ?? Object.entries(MODEL_PRICING).find(([k]) => this.model.startsWith(k))?.[1]
      ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const M = 1_000_000
    return (
      (this.usage.inputTokens * pricing.input) / M +
      (this.usage.outputTokens * pricing.output) / M +
      (this.usage.cacheReadTokens * pricing.cacheRead) / M +
      (this.usage.cacheWriteTokens * pricing.cacheWrite) / M
    )
  }

  getSummary(): string {
    const cost = this.getCostUsd()
    const { inputTokens, outputTokens } = this.usage
    return `输入 ${inputTokens.toLocaleString()} tokens，输出 ${outputTokens.toLocaleString()} tokens，费用 $${cost.toFixed(4)}`
  }

  reset() {
    this.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }
}
