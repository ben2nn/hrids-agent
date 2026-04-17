// 指数退避重试工具 —— 用于 LLM API 调用和网络请求
import { logger } from './logger.js';
// 判断错误是否可重试（网络错误、429 限流、4xx/5xx 服务端错误）
function defaultRetryIf(err) {
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        // 网络错误
        if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('econnrefused'))
            return true;
        if (msg.includes('network') || msg.includes('timeout') || msg.includes('超时'))
            return true;
        // HTTP 429 限流
        if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests'))
            return true;
        // HTTP 4xx 客户端错误（模型不存在、额度耗尽等，fallback 后换模型可能成功）
        if (msg.includes('403') || msg.includes('404') || msg.includes('400'))
            return true;
        // HTTP 5xx 服务端错误
        if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504'))
            return true;
        // 流式读取超时
        if (msg.includes('流式读取超时'))
            return true;
    }
    return false;
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function calcDelay(attempt, baseMs, maxMs, jitter) {
    // 指数退避：1s, 2s, 4s, 8s...
    const exp = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
    if (!jitter)
        return exp;
    // 加 ±25% 随机抖动，避免多个请求同时重试
    return exp * (0.75 + Math.random() * 0.5);
}
// 对普通 async 函数的重试包装
export async function withRetry(fn, opts = {}, context = '操作') {
    const maxAttempts = opts.maxAttempts ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 1000;
    const maxDelayMs = opts.maxDelayMs ?? 30000;
    const jitter = opts.jitter ?? true;
    const retryIf = opts.retryIf ?? defaultRetryIf;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            if (attempt === maxAttempts || !retryIf(err)) {
                throw err;
            }
            const delay = calcDelay(attempt, baseDelayMs, maxDelayMs, jitter);
            logger.warn(`${context} 失败，${Math.round(delay / 1000)}s 后重试（${attempt}/${maxAttempts - 1}）`, {
                error: err instanceof Error ? err.message : String(err),
            });
            await sleep(delay);
        }
    }
    throw lastErr;
}
// 对 AsyncGenerator 的重试包装（用于流式 API）
// 注意：流式重试会从头重新发起请求，已 yield 的内容不会重复
export async function* withRetryStream(fn, opts = {}, context = '流式请求') {
    const maxAttempts = opts.maxAttempts ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 1000;
    const maxDelayMs = opts.maxDelayMs ?? 30000;
    const jitter = opts.jitter ?? true;
    const retryIf = opts.retryIf ?? defaultRetryIf;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            yield* fn();
            return;
        }
        catch (err) {
            if (attempt === maxAttempts || !retryIf(err)) {
                throw err;
            }
            const delay = calcDelay(attempt, baseDelayMs, maxDelayMs, jitter);
            logger.warn(`${context} 流式请求失败，${Math.round(delay / 1000)}s 后重试（${attempt}/${maxAttempts - 1}）`, {
                error: err instanceof Error ? err.message : String(err),
            });
            await sleep(delay);
        }
    }
}
