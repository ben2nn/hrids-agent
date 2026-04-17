// OpenAI 兼容提供商 —— 支持 OpenAI、DeepSeek、Groq、Ollama、本地模型等
// 任何实现了 OpenAI Chat Completions API 的服务都可以使用
import { z } from 'zod';
import { withRetry } from '../retry.js';
import { logger } from '../logger.js';
const log = logger.child({ component: 'openai-provider' });
// 将通用 ToolDef 转换为 OpenAI function calling 格式
function toOAITool(tool) {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: zodToJsonSchema(tool.inputSchema),
        },
    };
}
// 完整的 Zod → JSON Schema 转换，支持所有常用类型
function zodToJsonSchema(schema) {
    if (schema instanceof z.ZodObject) {
        const shape = schema.shape;
        const properties = {};
        const required = [];
        for (const [key, val] of Object.entries(shape)) {
            properties[key] = zodFieldToSchema(val);
            if (!(val instanceof z.ZodOptional))
                required.push(key);
        }
        return { type: 'object', properties, required };
    }
    // 顶层 discriminatedUnion（如 ScheduleCronTool）
    if (schema instanceof z.ZodDiscriminatedUnion) {
        const types = schema.options.map(opt => zodToJsonSchema(opt));
        return { anyOf: types };
    }
    return { type: 'object', properties: {}, required: [] };
}
function zodFieldToSchema(field) {
    // 剥离 Optional 包装，保留 description
    if (field instanceof z.ZodOptional) {
        const inner = zodFieldToSchema(field.unwrap());
        const desc = field.description ?? field.unwrap().description;
        return desc ? { ...inner, description: desc } : inner;
    }
    // 剥离 Default 包装
    if (field instanceof z.ZodDefault) {
        return zodFieldToSchema(field._def.innerType);
    }
    // 剥离 Nullable 包装
    if (field instanceof z.ZodNullable) {
        const inner = zodFieldToSchema(field.unwrap());
        return { ...inner, nullable: true };
    }
    const base = {};
    if (field.description)
        base.description = field.description;
    if (field instanceof z.ZodString)
        return { type: 'string', ...base };
    if (field instanceof z.ZodNumber)
        return { type: 'number', ...base };
    if (field instanceof z.ZodBoolean)
        return { type: 'boolean', ...base };
    if (field instanceof z.ZodEnum) {
        return { type: 'string', enum: field.options, ...base };
    }
    if (field instanceof z.ZodNativeEnum) {
        const values = Object.values(field.enum);
        return { type: typeof values[0] === 'number' ? 'number' : 'string', enum: values, ...base };
    }
    if (field instanceof z.ZodArray) {
        return { type: 'array', items: zodFieldToSchema(field.element), ...base };
    }
    if (field instanceof z.ZodObject) {
        return { ...zodToJsonSchema(field), ...base };
    }
    if (field instanceof z.ZodUnion) {
        const types = field.options.map(zodFieldToSchema);
        return { anyOf: types, ...base };
    }
    // discriminatedUnion（如 ScheduleCronTool 的 action 字段）
    if (field instanceof z.ZodDiscriminatedUnion) {
        const types = field.options.map(zodFieldToSchema);
        return { anyOf: types, ...base };
    }
    if (field instanceof z.ZodLiteral) {
        const val = field.value;
        return { type: typeof val, const: val, ...base };
    }
    if (field instanceof z.ZodRecord) {
        return { type: 'object', additionalProperties: zodFieldToSchema(field.valueType), ...base };
    }
    // 兜底：unknown / any
    return { type: 'string', ...base };
}
// 将通用消息转换为 OpenAI 格式
function toOAIMessages(messages, systemPrompt) {
    const result = [{ role: 'system', content: systemPrompt }];
    for (const msg of messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            if (typeof msg.content === 'string') {
                result.push({ role: msg.role, content: msg.content });
            }
            else {
                // 处理包含工具调用的 assistant 消息
                const textParts = msg.content
                    .filter(b => b.type === 'text')
                    .map(b => b.text ?? '')
                    .join('');
                const toolCalls = msg.content
                    .filter(b => b.type === 'tool_use')
                    .map(b => ({
                    id: b.id ?? '',
                    type: 'function',
                    function: { name: b.name ?? '', arguments: JSON.stringify(b.input) },
                }));
                if (msg.role === 'assistant') {
                    result.push({
                        role: 'assistant',
                        content: textParts || null,
                        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                    });
                }
                else {
                    // user 消息中的 tool_result
                    const toolResults = msg.content
                        .filter(b => b.type === 'tool_result');
                    for (const tr of toolResults) {
                        result.push({
                            role: 'tool',
                            content: tr.content ?? '',
                            tool_call_id: tr.tool_use_id ?? '',
                        });
                    }
                }
            }
        }
    }
    return result;
}
export class OpenAIProvider {
    name;
    model;
    modelType;
    config;
    constructor(config, providerName = 'openai') {
        this.config = config;
        this.model = config.model;
        this.modelType = config.modelType ?? 'llm';
        this.name = providerName;
    }
    async *stream(messages, tools, systemPrompt, maxTokens) {
        const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
        const oaiMessages = toOAIMessages(messages, systemPrompt);
        const oaiTools = tools.length > 0 ? tools.map(toOAITool) : undefined;
        const body = {
            model: this.model,
            messages: oaiMessages,
            max_tokens: maxTokens,
            stream: true,
            stream_options: { include_usage: true },
        };
        if (oaiTools)
            body.tools = oaiTools;
        const keyPreview = this.config.apiKey
            ? `${this.config.apiKey.slice(0, 8)}...（共${this.config.apiKey.length}位）`
            : '（空）';
        // 仅在非 server 模式下输出调试信息，避免污染 JSON 通信通道
        if (!process.env.AGENT_SERVER_MODE) {
            //process.stderr.write(`[DEBUG] provider=${this.name} model=${this.model}\n`)
            //process.stderr.write(`[DEBUG] baseUrl=${baseUrl}\n`)
            //process.stderr.write(`[DEBUG] apiKey=${keyPreview}\n`)
        }
        // 带重试的 fetch（网络错误/429/5xx 自动退避重试）
        const res = await withRetry(() => fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(600000),
        }), { maxAttempts: 3 }, `${this.name} API [${this.model}]`);
        if (!res.ok) {
            const err = await res.text();
            log.error('API 请求失败', { provider: this.name, model: this.model, status: res.status });
            throw new Error(`${this.name} API 错误 ${res.status}: ${err}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        // 累积工具调用（流式工具调用是分片的）
        const pendingToolCalls = {};
        // 单次 read() 超时保护：防止服务端保持连接但不发数据导致永久阻塞
        const readWithTimeout = (ms) => Promise.race([
            reader.read(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`流式读取超时（${ms / 1000}s 无数据）`)), ms)),
        ]);
        while (true) {
            const { done, value } = await readWithTimeout(120_000); // 2 分钟无数据则超时
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    // 输出所有累积的工具调用
                    for (const tc of Object.values(pendingToolCalls)) {
                        try {
                            yield {
                                type: 'tool_call',
                                toolCall: { id: tc.id, name: tc.name, input: JSON.parse(tc.args || '{}') },
                            };
                        }
                        catch { /* JSON 解析失败忽略 */ }
                    }
                    yield { type: 'done' };
                    return;
                }
                try {
                    const chunk = JSON.parse(data);
                    const delta = chunk.choices?.[0]?.delta;
                    if (delta?.content) {
                        yield { type: 'text_delta', delta: delta.content };
                    }
                    // 累积工具调用片段
                    if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            if (!pendingToolCalls[tc.index]) {
                                pendingToolCalls[tc.index] = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
                            }
                            if (tc.id)
                                pendingToolCalls[tc.index].id = tc.id;
                            if (tc.function?.name)
                                pendingToolCalls[tc.index].name = tc.function.name;
                            if (tc.function?.arguments)
                                pendingToolCalls[tc.index].args += tc.function.arguments;
                        }
                    }
                    // 用量统计（通常在最后一个 chunk）
                    if (chunk.usage) {
                        yield {
                            type: 'usage',
                            usage: {
                                inputTokens: chunk.usage.prompt_tokens,
                                outputTokens: chunk.usage.completion_tokens,
                            },
                        };
                    }
                }
                catch { /* 忽略解析错误 */ }
            }
        }
        yield { type: 'done' };
    }
}
