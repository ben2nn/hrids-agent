// Anthropic 提供商 —— 支持 claude-* 系列模型
import Anthropic from '@anthropic-ai/sdk';
import { toAnthropicTool } from '../Tool.js';
import { withRetry } from '../retry.js';
import { logger } from '../logger.js';
const log = logger.child({ component: 'anthropic-provider' });
export class AnthropicProvider {
    name = 'anthropic';
    model;
    modelType;
    client;
    constructor(config) {
        this.model = config.model;
        this.modelType = config.modelType ?? 'llm';
        this.client = new Anthropic({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
        });
    }
    async *stream(messages, tools, systemPrompt, maxTokens) {
        const anthropicMessages = messages.map(m => ({
            role: m.role,
            content: m.content,
        }));
        // 用 withRetry 包装 stream 创建（网络错误/限流时自动退避重试）
        const stream = await withRetry(() => Promise.resolve(this.client.messages.stream({
            model: this.model,
            max_tokens: maxTokens,
            system: systemPrompt,
            tools: tools.map(toAnthropicTool),
            messages: anthropicMessages,
        })), { maxAttempts: 3 }, `Anthropic stream [${this.model}]`);
        try {
            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    yield { type: 'text_delta', delta: event.delta.text };
                }
                else if (event.type === 'message_stop') {
                    const final = await stream.finalMessage();
                    for (const block of final.content) {
                        if (block.type === 'tool_use') {
                            yield { type: 'tool_call', toolCall: { id: block.id, name: block.name, input: block.input } };
                        }
                    }
                    const u = final.usage;
                    const usageAny = u;
                    yield {
                        type: 'usage',
                        usage: {
                            inputTokens: u.input_tokens + (usageAny['cache_read_input_tokens'] ?? 0),
                            outputTokens: u.output_tokens,
                        },
                    };
                }
            }
        }
        catch (err) {
            log.error('流式请求失败', { model: this.model, error: String(err) });
            throw err;
        }
        yield { type: 'done' };
    }
}
