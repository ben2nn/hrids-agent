// 配置系统 —— 读写 ~/.hrids-agent/config.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const CONFIG_DIR = join(homedir(), '.hrids-agent');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
// 硬编码的兜底默认值（不依赖任何环境变量）
const HARDCODED_DEFAULTS = {
    model: 'qwen3.5-122b-a10b',
    permissionMode: 'ask',
    maxTokens: 8096,
    maxTurns: 50,
    mcpServers: [],
    theme: 'default',
};
function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR))
        mkdirSync(CONFIG_DIR, { recursive: true });
}
/**
 * 从当前环境变量推导出配置对象。
 * 仅在 config.json 不存在时调用，用于首次生成配置文件。
 */
function buildConfigFromEnv() {
    // 模型：优先 DEFAULT_MODEL，否则用硬编码兜底
    const model = process.env.DEFAULT_MODEL ?? HARDCODED_DEFAULTS.model;
    // 记忆提炼开关
    const memoryCondense = process.env.MEMORY_CONDENSE === 'true' ? true : undefined;
    // 向量存储后端（仅记录，不影响 AgentConfig 结构，但可扩展）
    // process.env.VECTOR_STORE 已在 memory 模块中直接读取，此处不需要映射
    return {
        ...HARDCODED_DEFAULTS,
        model,
        ...(memoryCondense !== undefined ? { memoryCondense } : {}),
    };
}
export function loadConfig() {
    ensureConfigDir();
    if (!existsSync(CONFIG_FILE)) {
        // 首次启动：根据 .env 生成配置并持久化
        const generated = buildConfigFromEnv();
        try {
            writeFileSync(CONFIG_FILE, JSON.stringify(generated, null, 2), 'utf-8');
            process.stderr.write(`[config] 首次启动，已根据 .env 生成配置文件: ${CONFIG_FILE}\n`);
        }
        catch (err) {
            process.stderr.write(`[config] 写入配置文件失败（将使用内存配置）: ${String(err)}\n`);
        }
        return generated;
    }
    try {
        const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        // 已有配置文件：用硬编码默认值补全缺失字段，不覆盖用户已设置的值
        return { ...HARDCODED_DEFAULTS, ...raw };
    }
    catch {
        process.stderr.write(`[config] 配置文件解析失败，使用默认配置\n`);
        return { ...HARDCODED_DEFAULTS };
    }
}
export function saveConfig(config) {
    ensureConfigDir();
    const current = loadConfig();
    const updated = { ...current, ...config };
    writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8');
}
export function getConfigDir() {
    return CONFIG_DIR;
}
