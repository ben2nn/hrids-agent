// 提供商工厂 —— 根据配置自动选择正确的提供商
import { AnthropicProvider } from './AnthropicProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { FallbackProvider } from './FallbackProvider.js';
export { AnthropicProvider } from './AnthropicProvider.js';
export { OpenAIProvider } from './OpenAIProvider.js';
export { FallbackProvider } from './FallbackProvider.js';
// ── 模型前缀 → 提供商映射 ─────────────────────────────────────
const ANTHROPIC_PREFIXES = ['claude-'];
const OPENAI_PREFIXES = ['gpt-', 'o1', 'o3', 'o4'];
const DEEPSEEK_PREFIXES = ['deepseek-'];
const GROQ_PREFIXES = ['llama', 'mixtral', 'gemma', 'whisper'];
// 阿里云百炼（DashScope）模型前缀
const ALIYUN_PREFIXES = ['qwen', 'qwq-', 'qvq-', 'tongyi-', 'MiniMax-'];
// 智谱 AI 模型前缀
const ZHIPU_PREFIXES = ['glm-', 'cogview-', 'cogvideo-', 'embedding-'];
// ── 各模型类型的默认环境变量前缀 ─────────────────────────────
// 格式：LLM_FALLBACK_N / VISION_FALLBACK_N / MULTIMODAL_FALLBACK_N /
//       SPEECH_FALLBACK_N / EMBEDDING_FALLBACK_N
const MODEL_TYPE_ENV_PREFIX = {
    llm: 'LLM_FALLBACK',
    vision: 'VISION_FALLBACK',
    multimodal: 'MULTIMODAL_FALLBACK',
    speech: 'SPEECH_FALLBACK',
    embedding: 'EMBEDDING_FALLBACK',
};
// ── 单一提供商创建 ────────────────────────────────────────────
export function createProvider(opts) {
    const { model, baseUrl } = opts;
    // 显式指定提供商
    if (opts.provider) {
        return buildProvider(opts.provider, opts);
    }
    // 根据 baseUrl 自动判断（Ollama 通常是 localhost）
    if (baseUrl?.includes('localhost') || baseUrl?.includes('127.0.0.1')) {
        return new OpenAIProvider({ apiKey: opts.apiKey ?? 'ollama', baseUrl, model, modelType: opts.modelType }, 'ollama');
    }
    // 根据模型名前缀自动判断
    if (ANTHROPIC_PREFIXES.some(p => model.startsWith(p))) {
        return new AnthropicProvider({ apiKey: requireKey(opts, 'ANTHROPIC_API_KEY'), baseUrl, model, modelType: opts.modelType });
    }
    if (OPENAI_PREFIXES.some(p => model.startsWith(p))) {
        return new OpenAIProvider({ apiKey: requireKey(opts, 'OPENAI_API_KEY'), baseUrl, model, modelType: opts.modelType }, 'openai');
    }
    if (DEEPSEEK_PREFIXES.some(p => model.startsWith(p))) {
        return new OpenAIProvider({
            apiKey: requireKey(opts, 'DEEPSEEK_API_KEY'),
            baseUrl: baseUrl ?? 'https://api.deepseek.com/v1',
            model, modelType: opts.modelType,
        }, 'deepseek');
    }
    if (GROQ_PREFIXES.some(p => model.toLowerCase().startsWith(p))) {
        return new OpenAIProvider({
            apiKey: requireKey(opts, 'GROQ_API_KEY'),
            baseUrl: baseUrl ?? 'https://api.groq.com/openai/v1',
            model, modelType: opts.modelType,
        }, 'groq');
    }
    if (ALIYUN_PREFIXES.some(p => model.startsWith(p))) {
        return new OpenAIProvider({
            apiKey: requireKey(opts, 'DASHSCOPE_API_KEY'),
            baseUrl: baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            model, modelType: opts.modelType,
        }, 'aliyun');
    }
    if (ZHIPU_PREFIXES.some(p => model.startsWith(p))) {
        return new OpenAIProvider({
            apiKey: requireKey(opts, 'ZHIPU_API_KEY'),
            baseUrl: baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
            model, modelType: opts.modelType,
        }, 'zhipu');
    }
    // 默认尝试 Anthropic
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (key)
        return new AnthropicProvider({ apiKey: key, baseUrl, model, modelType: opts.modelType });
    throw new Error(`无法自动识别模型 "${model}" 的提供商。\n` +
        `请通过 --provider 指定，或设置对应的环境变量。\n` +
        `支持的提供商: anthropic, openai, deepseek, groq, ollama, aliyun, zhipu, nvidia, custom`);
}
function buildProvider(provider, opts) {
    const { model, baseUrl, modelType } = opts;
    switch (provider) {
        case 'anthropic':
            return new AnthropicProvider({ apiKey: requireKey(opts, 'ANTHROPIC_API_KEY'), baseUrl, model, modelType });
        case 'openai':
            return new OpenAIProvider({ apiKey: requireKey(opts, 'OPENAI_API_KEY'), baseUrl, model, modelType }, 'openai');
        case 'deepseek':
            return new OpenAIProvider({
                apiKey: requireKey(opts, 'DEEPSEEK_API_KEY'),
                baseUrl: baseUrl ?? 'https://api.deepseek.com/v1',
                model, modelType,
            }, 'deepseek');
        case 'groq':
            return new OpenAIProvider({
                apiKey: requireKey(opts, 'GROQ_API_KEY'),
                baseUrl: baseUrl ?? 'https://api.groq.com/openai/v1',
                model, modelType,
            }, 'groq');
        case 'aliyun':
            return new OpenAIProvider({
                apiKey: requireKey(opts, 'DASHSCOPE_API_KEY'),
                baseUrl: baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                model, modelType,
            }, 'aliyun');
        case 'zhipu':
            return new OpenAIProvider({
                apiKey: requireKey(opts, 'ZHIPU_API_KEY'),
                baseUrl: baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
                model, modelType,
            }, 'zhipu');
        case 'nvidia':
            return new OpenAIProvider({
                apiKey: requireKey(opts, 'NVIDIA_API_KEY'),
                baseUrl: baseUrl ?? 'https://integrate.api.nvidia.com/v1',
                model, modelType,
            }, 'nvidia');
        case 'ollama':
            return new OpenAIProvider({
                apiKey: 'ollama',
                baseUrl: baseUrl ?? 'http://localhost:11434/v1',
                model, modelType,
            }, 'ollama');
        case 'custom':
            return new OpenAIProvider({
                apiKey: requireKey(opts, 'CUSTOM_API_KEY'),
                baseUrl: baseUrl ?? (() => { throw new Error('custom 提供商需要 --base-url'); })(),
                model, modelType,
            }, 'custom');
        default:
            throw new Error(`未知提供商: ${provider}，支持的提供商: anthropic, openai, deepseek, groq, ollama, aliyun, zhipu, nvidia, custom`);
    }
}
function requireKey(opts, envVar) {
    const key = opts.apiKey ?? process.env[envVar];
    if (!key)
        throw new Error(`缺少 API Key，请设置环境变量 ${envVar} 或使用 --api-key 参数`);
    return key;
}
// ── 多模型 Fallback 工厂 ──────────────────────────────────────
/**
 * 创建多 LLM 故障转移提供商（带平台分组）
 */
export function createFallbackProvider(configs) {
    if (configs.length === 0)
        throw new Error('至少需要一个提供商配置');
    if (configs.length === 1)
        return createProvider(configs[0]);
    return new FallbackProvider(configs.map(c => createProvider(c)));
}
/**
 * 创建带平台分组的故障转移提供商
 * groups 内同平台模型先切换，平台全挂再跨平台
 */
export function createGroupedFallbackProvider(groups) {
    if (groups.length === 0)
        throw new Error('至少需要一个平台配置');
    const allProviders = [];
    const providerGroups = [];
    for (const g of groups) {
        const providers = g.configs.map(c => createProvider(c));
        allProviders.push(...providers);
        providerGroups.push({ platformName: g.platformName, providers });
    }
    if (allProviders.length === 1)
        return allProviders[0];
    return new FallbackProvider(allProviders, providerGroups);
}
// ── 从环境变量创建指定类型的 Provider ────────────────────────
/**
 * 从环境变量读取指定模型类型的多模型配置并创建 FallbackProvider
 *
 * 环境变量格式（以 LLM 类型为例）：
 *   LLM_FALLBACK_1=provider:aliyun,models:qwen3.5-flash,qwen3.5-plus
 *   LLM_FALLBACK_2=provider:deepseek,models:deepseek-chat
 *
 * 其他类型对应的前缀：
 *   VISION_FALLBACK_N      视觉模型
 *   MULTIMODAL_FALLBACK_N  全模态大模型
 *   SPEECH_FALLBACK_N      语音模型
 *   EMBEDDING_FALLBACK_N   向量模型
 *
 * 同一行内的模型属于同一平台，优先在平台内切换，平台全挂后跨到下一行。
 */
export function createTypedProviderFromEnv(modelType) {
    const envPrefix = MODEL_TYPE_ENV_PREFIX[modelType];
    const groups = [];
    for (let i = 1; i <= 20; i++) {
        const raw = process.env[`${envPrefix}_${i}`];
        if (!raw)
            break;
        const entries = parseProviderLine(raw, modelType);
        if (entries.length === 0) {
            throw new Error(`${envPrefix}_${i} 解析失败，请检查格式`);
        }
        const platformName = entries[0].provider ?? entries[0].model;
        groups.push({ platformName, configs: entries });
    }
    if (groups.length === 0)
        return null;
    if (!process.env.AGENT_SERVER_MODE) {
        const chain = groups.map((g, gi) => `[平台${gi + 1}:${g.platformName}] ${g.configs.map(c => c.model).join(' → ')}`).join(' || ');
        process.stderr.write(`[providers] ${modelType} fallback 链: ${chain}\n`);
    }
    return createGroupedFallbackProvider(groups);
}
/**
 * 从环境变量读取大语言模型配置（LLM_FALLBACK_N 或 DEFAULT_MODEL）
 * 这是主对话引擎使用的入口，保持向后兼容。
 */
export function createProviderFromEnv() {
    const provider = createTypedProviderFromEnv('llm');
    if (provider)
        return provider;
    // 没有 LLM_FALLBACK_* 配置，使用单一 DEFAULT_MODEL
    const model = process.env.DEFAULT_MODEL;
    if (!model)
        throw new Error('请设置 DEFAULT_MODEL 或 LLM_FALLBACK_1 环境变量');
    return createProvider({ model, modelType: 'llm' });
}
/**
 * 从环境变量读取视觉模型配置（VISION_FALLBACK_N 或 VISION_MODEL）
 * 返回 null 表示未配置，调用方可降级到 LLM 模型。
 */
export function createVisionProviderFromEnv() {
    const provider = createTypedProviderFromEnv('vision');
    if (provider)
        return provider;
    const model = process.env.VISION_MODEL;
    if (!model)
        return null;
    return createProvider({ model, modelType: 'vision' });
}
/**
 * 从环境变量读取全模态模型配置（MULTIMODAL_FALLBACK_N 或 MULTIMODAL_MODEL）
 * 全模态模型同时支持文本、图像、音频输入/输出。
 */
export function createMultimodalProviderFromEnv() {
    const provider = createTypedProviderFromEnv('multimodal');
    if (provider)
        return provider;
    const model = process.env.MULTIMODAL_MODEL;
    if (!model)
        return null;
    return createProvider({ model, modelType: 'multimodal' });
}
/**
 * 从环境变量读取语音模型配置（SPEECH_FALLBACK_N 或 SPEECH_MODEL）
 * 语音模型用于 TTS（文字转语音）和 STT（语音转文字）。
 */
export function createSpeechProviderFromEnv() {
    const provider = createTypedProviderFromEnv('speech');
    if (provider)
        return provider;
    const model = process.env.SPEECH_MODEL;
    if (!model)
        return null;
    return createProvider({ model, modelType: 'speech' });
}
// ── 解析工具函数 ──────────────────────────────────────────────
/**
 * 解析一行 FALLBACK_N 配置，返回一组 ProviderOptions
 *
 * 支持两种格式：
 * - 新格式: provider:aliyun,models:qwen3-235b,qwen3-8b[,apiKey:xxx][,baseUrl:xxx]
 * - 旧格式: model:qwen3-235b,provider:aliyun[,apiKey:xxx]
 */
function parseProviderLine(raw, modelType = 'llm') {
    const modelsMatch = raw.match(/(?:^|,)models:(.+)$/);
    if (modelsMatch) {
        const beforeModels = raw.slice(0, raw.indexOf('models:'));
        const kvPairs = parseKV(beforeModels);
        const afterModels = modelsMatch[1];
        const modelTokens = [];
        const extraKV = {};
        for (const token of afterModels.split(',')) {
            const t = token.trim();
            if (!t)
                continue;
            if (t.includes(':')) {
                const idx = t.indexOf(':');
                extraKV[t.slice(0, idx)] = t.slice(idx + 1);
            }
            else {
                modelTokens.push(t);
            }
        }
        const merged = { ...kvPairs, ...extraKV };
        const provider = merged.provider;
        const apiKey = merged.apiKey;
        const baseUrl = merged.baseUrl;
        return modelTokens.map(model => ({ model, provider, apiKey, baseUrl, modelType }));
    }
    // 旧格式：model:xxx,provider:yyy,...
    const kv = parseKV(raw);
    if (!kv.model)
        throw new Error(`配置行缺少 model 字段: ${raw}`);
    return [{
            model: kv.model,
            provider: kv.provider,
            apiKey: kv.apiKey,
            baseUrl: kv.baseUrl,
            modelType,
        }];
}
/** 解析 "key:val,key2:val2" 形式的字符串为对象 */
function parseKV(str) {
    const result = {};
    for (const token of str.split(',')) {
        const t = token.trim();
        if (!t || !t.includes(':'))
            continue;
        const idx = t.indexOf(':');
        result[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return result;
}
