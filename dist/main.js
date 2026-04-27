import 'dotenv/config';
import { setupSystemProxy } from './core/proxySetup.js';
setupSystemProxy();
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { loadConfig, saveConfig } from './core/Config.js';
import { QueryEngine } from './core/QueryEngine.js';
import { PermissionManager } from './core/PermissionManager.js';
import { CommandRegistry, createBuiltinCommands } from './core/CommandRegistry.js';
import { generateSessionId, loadSession, loadSessionMeta, listSessions, saveSession, getLastSessionId, archiveSession, listArchives } from './core/SessionStore.js';
import { buildSystemContext, getDynamicContext, getSessionWorkDir } from './core/ContextBuilder.js';
import { createProvider, createProviderFromEnv } from './core/providers/index.js';
import { TeamManager } from './core/coordinator/TeamManager.js';
import { getCoordinatorSystemPrompt } from './core/coordinator/coordinatorPrompt.js';
import { ALL_TOOLS } from './tools/index.js';
import { setGlobalCwd, getGlobalCwd } from './tools/BashTool.js';
import { resolveAskUser } from './tools/AskUserTool.js';
import { resolveDecision } from './tools/DecisionTool.js';
import { restoreScheduledJobs, setCronTriggerCallback } from './tools/ScheduleCronTool.js';
import { createAgentTool } from './tools/AgentTool.js';
import { loadMcpTools, disconnectAllMcp } from './tools/McpTool.js';
import { App } from './ui/App.js';
import { createGateway } from './gateway/server.js';
import { resetEmbeddingProvider } from './memory/index.js';
import { autoExtractMemories, autoDistillSkill } from './core/postRunHooks.js';
import { registerAllBundledSkills, buildSkillRegistry } from './skills/index.js';
import { logger } from './core/logger.js';
// ── 启动配置校验 ──────────────────────────────────────────────
// 在实际调用 API 前提前检测缺失的必要配置，给出明确提示
function validateStartupConfig(opts, model) {
    const warnings = [];
    // 检查是否有任何 API Key（Ollama 除外）
    const isOllama = opts.provider === 'ollama'
        || opts.baseUrl?.includes('localhost')
        || opts.baseUrl?.includes('127.0.0.1');
    if (!isOllama) {
        const hasAnyKey = !!(opts.apiKey
            || process.env.ANTHROPIC_API_KEY
            || process.env.OPENAI_API_KEY
            || process.env.DEEPSEEK_API_KEY
            || process.env.GROQ_API_KEY
            || process.env.DASHSCOPE_API_KEY
            || process.env.ZHIPU_API_KEY
            || process.env.NVIDIA_API_KEY
            || process.env.CUSTOM_API_KEY);
        if (!hasAnyKey) {
            warnings.push('未检测到任何 API Key，请设置对应的环境变量（如 ANTHROPIC_API_KEY）或使用 --api-key 参数');
        }
    }
    if (warnings.length > 0) {
        for (const w of warnings) {
            process.stderr.write(`\x1b[33m[警告]\x1b[0m ${w}\n`);
        }
    }
}
// 启动时用基础层（不含扩展）构建初始 systemPrompt
// 每次用户发消息时，根据消息内容动态注入对应扩展块
const BASE_SYSTEM_PROMPT = getCoordinatorSystemPrompt();
async function main() {
    const program = new Command();
    program
        .name('hrids-agent')
        .description('原创智能体 CLI，支持 Anthropic / OpenAI / DeepSeek / Groq / Ollama')
        .version('0.1.0')
        .option('-m, --model <model>', '模型名称（自动识别提供商）', process.env.DEFAULT_MODEL ?? 'claude-sonnet-4-5')
        .option('--provider <provider>', '显式指定提供商: anthropic | openai | deepseek | groq | ollama | aliyun | custom')
        .option('--api-key <key>', 'API Key（也可通过环境变量设置）')
        .option('--base-url <url>', '自定义 API 端点（Ollama / 本地代理）')
        .option('--craft', '自主执行模式（无需确认写操作，agent 独立完成任务）')
        .option('--plan', '计划模式（只读，写操作需手动确认后执行）')
        .option('--resume <sessionId>', '恢复之前的会话')
        .option('--list-sessions', '列出最近的会话')
        .option('--new-session', '强制创建新会话（默认自动恢复上次会话）')
        .option('-p, --print <message>', '非交互模式：执行一条消息后退出')
        .option('--server', 'Server 模式：持续从 stdin 读取消息（NDJSON），保持会话历史')
        .option('--gateway', 'Gateway 模式：启动 HTTP + WebSocket 服务，供前端或远程客户端连接')
        .option('--gateway-port <port>', 'Gateway 监听端口（默认 3282）', '3282')
        .option('--gateway-host <host>', 'Gateway 监听地址（默认 127.0.0.1）', '127.0.0.1')
        .option('--gateway-token <token>', 'Gateway 鉴权 Token（可选）')
        .option('--embedding-provider <provider>', 'Embedding 提供商: openai | ollama | tfidf（默认 tfidf）')
        .option('--embedding-model <model>', 'Embedding 模型名称')
        .option('--embedding-base-url <url>', 'Embedding API 端点（Ollama 用）')
        .option('--cwd <dir>', '设置工作目录（覆盖配置文件中的 agentCwd）')
        .option('--max-chars <n>', '非交互模式（-p）输出字符上限，超出后截断（默认不限制）')
        .addHelpText('after', `
示例:
  # Anthropic（自动识别）
  ANTHROPIC_API_KEY=sk-ant-... npx tsx src/main.ts

  # OpenAI
  OPENAI_API_KEY=sk-... npx tsx src/main.ts -m gpt-4o

  # DeepSeek
  DEEPSEEK_API_KEY=sk-... npx tsx src/main.ts -m deepseek-chat

  # Groq（免费）
  GROQ_API_KEY=gsk_... npx tsx src/main.ts -m llama-3.3-70b-versatile

  # 阿里云百炼（DashScope）
  DASHSCOPE_API_KEY=sk-... npx tsx src/main.ts -m qwen-max
  DASHSCOPE_API_KEY=sk-... npx tsx src/main.ts -m qwen-plus --provider aliyun

  # Ollama 本地模型（无需 API Key）
  npx tsx src/main.ts -m qwen2.5-coder:7b --provider ollama

  # 自定义端点
  npx tsx src/main.ts -m my-model --provider custom --base-url http://localhost:8080/v1 --api-key token
    `)
        .action(async (opts) => {
        // 启动配置校验
        validateStartupConfig(opts, opts.model);
        // 初始化 Embedding 提供商（影响记忆系统的 L3 搜索质量）
        if (opts.embeddingProvider && opts.embeddingProvider !== 'tfidf') {
            resetEmbeddingProvider({
                provider: opts.embeddingProvider,
                model: opts.embeddingModel,
                baseUrl: opts.embeddingBaseUrl,
                apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
            });
        }
        // Gateway 模式：独立启动，不需要 provider/engine，由 SessionManager 按需创建
        if (opts.gateway) {
            // ⚠️ 必须在 gateway.start() 之前覆盖全局异常处理器
            // 避免启动过程中或运行期间的异常触发底部的 process.exit(1)
            process.removeAllListeners('uncaughtException');
            process.removeAllListeners('unhandledRejection');
            process.on('uncaughtException', (err) => {
                logger.error('未捕获异常（Gateway 继续运行）', { error: err.message, stack: err.stack });
            });
            process.on('unhandledRejection', (reason) => {
                logger.error('未处理的 Promise 拒绝（Gateway 继续运行）', { reason: String(reason) });
            });
            const gateway = createGateway({
                port: parseInt(opts.gatewayPort, 10),
                host: opts.gatewayHost,
                authToken: opts.gatewayToken,
            });
            await gateway.start();
            const webUrl = `http://${opts.gatewayHost}:${opts.gatewayPort}`;
            // Gateway 模式：注册 cron 触发回调，将任务发送到知了专属会话
            {
                setCronTriggerCallback((job) => {
                    void (async () => {
                        try {
                            const zhileFile = join(homedir(), '.hrids-agent', 'zhile-session.json');
                            if (!existsSync(zhileFile)) {
                                logger.warn('[cron] 知了会话文件不存在，跳过触发', { jobId: job.id });
                                return;
                            }
                            const { sessionId } = JSON.parse(readFileSync(zhileFile, 'utf-8'));
                            if (!sessionId) {
                                logger.warn('[cron] 知了会话 ID 为空，跳过触发', { jobId: job.id });
                                return;
                            }
                            let session = gateway.manager.getSession(sessionId);
                            if (!session) {
                                logger.warn('[cron] 知了会话不在内存中，尝试恢复', { jobId: job.id, sessionId });
                                try {
                                    await gateway.manager.createSession({ resume: sessionId });
                                    session = gateway.manager.getSession(sessionId);
                                }
                                catch (err) {
                                    logger.error('[cron] 恢复知了会话失败', { error: String(err) });
                                    return;
                                }
                            }
                            if (!session) {
                                logger.error('[cron] 知了会话恢复后仍不存在', { jobId: job.id, sessionId });
                                return;
                            }
                            logger.info('[cron] 触发定时任务，发送提醒到知了会话', { jobId: job.id, sessionId, task: job.task.slice(0, 80) });
                            // 直接发送提醒消息，不经过 LLM
                            await gateway.manager.sendCronReminder(sessionId, { id: job.id, description: job.description, task: job.task });
                        }
                        catch (err) {
                            logger.error('[cron] 触发定时任务失败', { jobId: job.id, error: String(err) });
                        }
                    })();
                });
                restoreScheduledJobs();
            }
            console.log(``);
            console.log(`  ╔══════════════════════════════════════════════╗`);
            console.log(`  ║          hrids-agent Gateway 已就绪          ║`);
            console.log(`  ╚══════════════════════════════════════════════╝`);
            console.log(``);
            console.log(`  🌐 Web UI     ${webUrl}`);
            console.log(`  📡 REST API   ${webUrl}/sessions`);
            console.log(`  🔌 WebSocket  ws://${opts.gatewayHost}:${opts.gatewayPort}/sessions/:id/stream`);
            if (opts.gatewayToken) {
                console.log(`  🔑 Token      ${opts.gatewayToken}`);
            }
            console.log(``);
            console.log(`  提示：在浏览器中打开 ${webUrl} 开始使用`);
            console.log(`  按 Ctrl+C 停止服务`);
            console.log(``);
            // 保持进程运行，监听退出信号
            const shutdown = async (signal) => {
                logger.info(`收到 ${signal}，开始优雅关闭...`);
                process.stdout.write(`\n[gateway] 正在关闭（${signal}）...\n`);
                try {
                    await gateway.stop(15000);
                }
                catch (err) {
                    logger.error('关闭失败', { error: String(err) });
                }
                process.exit(0);
            };
            process.on('SIGINT', () => void shutdown('SIGINT'));
            process.on('SIGTERM', () => void shutdown('SIGTERM'));
            return;
        }
        // 列出会话
        if (opts.listSessions) {
            const sessions = listSessions();
            if (sessions.length === 0) {
                console.log('没有保存的会话。');
            }
            else {
                console.log('最近的会话:');
                sessions.slice(0, 10).forEach(s => {
                    console.log(`  ${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.title}`);
                });
            }
            return;
        }
        const config = loadConfig();
        const model = opts.model ?? config.model;
        // 记忆提炼开关：环境变量优先，其次 config.json
        const memoryCondense = process.env.MEMORY_CONDENSE === 'true' || (config.memoryCondense ?? false);
        // 会话管理：优先 --resume，其次询问用户是否恢复上次会话，--new-session 强制新建
        // 注意：需要在初始化工作目录之前确定 sessionId，以便创建对应的工作目录
        let sessionId;
        let initialMessages;
        if (opts.resume) {
            // 明确指定 --resume，直接恢复
            sessionId = opts.resume;
            initialMessages = loadSession(sessionId) ?? [];
        }
        else if (opts.newSession) {
            // 明确指定 --new-session，强制新建
            sessionId = generateSessionId();
            initialMessages = [];
        }
        else {
            // 默认行为：检测是否有上次会话，有则询问用户
            const lastSessionId = getLastSessionId();
            if (lastSessionId) {
                const lastMeta = loadSessionMeta(lastSessionId);
                const lastTitle = lastMeta?.title ?? '未知';
                const lastTime = lastMeta?.updatedAt
                    ? new Date(lastMeta.updatedAt).toLocaleString('zh-CN')
                    : '未知时间';
                const msgCount = lastMeta?.messageCount ?? 0;
                process.stdout.write(`\n上次会话：「${lastTitle}」\n`);
                process.stdout.write(`  时间：${lastTime}，共 ${msgCount} 条消息\n`);
                process.stdout.write(`恢复上次会话？[Y/n] `);
                const answer = await new Promise(resolve => {
                    // 确保 stdin 处于可读状态
                    if (process.stdin.isPaused())
                        process.stdin.resume();
                    process.stdin.setEncoding('utf-8');
                    const handler = (data) => {
                        process.stdin.removeListener('data', handler);
                        process.stdin.pause();
                        resolve(data.toString().trim().toLowerCase());
                    };
                    process.stdin.once('data', handler);
                });
                if (answer === '' || answer === 'y') {
                    // 恢复上次会话
                    sessionId = lastSessionId;
                    initialMessages = loadSession(sessionId) ?? [];
                    console.log(`✓ 已恢复会话（${initialMessages.length} 条消息）\n`);
                }
                else {
                    // 新建会话
                    sessionId = generateSessionId();
                    initialMessages = [];
                    console.log('✓ 已创建新会话\n');
                }
            }
            else {
                // 没有历史会话，直接新建
                sessionId = generateSessionId();
                initialMessages = [];
            }
        }
        // 初始化工作目录（优先级：--cwd > config.agentCwd > 旧会话目录 > 新建会话独立目录）
        // 约定：每个新会话必须在 work 目录下创建对应的独立文件夹
        const existingWorkDir = loadSessionMeta(sessionId)?.workDir;
        const initialCwd = opts.cwd
            ?? config.agentCwd
            ?? existingWorkDir
            ?? getSessionWorkDir(sessionId);
        // 确保会话工作目录存在（恢复旧会话时目录可能已被删除）
        if (!existsSync(initialCwd)) {
            mkdirSync(initialCwd, { recursive: true });
        }
        setGlobalCwd(initialCwd);
        try {
            process.chdir(initialCwd);
        }
        catch { /* 目录不存在时忽略 */ }
        // 创建 LLM 提供商：优先读取 LLM_FALLBACK_* 多模型配置，否则用单一 model
        let provider;
        try {
            // 有 LLM_FALLBACK_* 配置时用 FallbackProvider，否则退回单一 provider
            const hasFallback = !!process.env.LLM_FALLBACK_1;
            provider = hasFallback
                ? createProviderFromEnv()
                : createProvider({
                    model,
                    apiKey: opts.apiKey ?? config.apiKey,
                    baseUrl: opts.baseUrl || config.baseUrl || undefined,
                    provider: opts.provider ?? config.provider,
                });
        }
        catch (err) {
            console.error(`\n错误: ${String(err)}\n`);
            console.error('支持的提供商及对应环境变量:');
            console.error('  Anthropic  →  ANTHROPIC_API_KEY');
            console.error('  OpenAI     →  OPENAI_API_KEY');
            console.error('  DeepSeek   →  DEEPSEEK_API_KEY');
            console.error('  Groq       →  GROQ_API_KEY');
            console.error('  阿里云     →  DASHSCOPE_API_KEY（模型如 qwen-max、qwen-plus）');
            console.error('  Ollama     →  无需 Key，使用 --provider ollama');
            console.error('  自定义     →  --provider custom --base-url <url> --api-key <key>');
            process.exit(1);
        }
        // 权限模式
        const permMode = opts.plan ? 'plan'
            : opts.craft ? 'craft'
                : config.permissionMode;
        const permissions = new PermissionManager(permMode, async (req) => {
            process.stdout.write(`\n允许执行 "${req.description}"? [y/N/always] `);
            return new Promise(resolve => {
                const handler = (data) => {
                    process.stdin.removeListener('data', handler);
                    const ans = data.toString().trim().toLowerCase();
                    if (ans === 'always') {
                        permissions.approvePermanent(req.toolName);
                        resolve(true);
                    }
                    else {
                        resolve(ans === 'y');
                    }
                };
                process.stdin.once('data', handler);
            });
        });
        // 加载 MCP 工具
        const mcpTools = config.mcpServers.length > 0
            ? await loadMcpTools(config.mcpServers)
            : [];
        const tools = [
            ...ALL_TOOLS,
            createAgentTool(opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '', model),
            ...mcpTools,
        ];
        // 初始化全局 TeamManager（多智能体协调）
        TeamManager.init(provider, tools);
        const systemPrompt = await buildSystemContext(BASE_SYSTEM_PROMPT);
        const engine = new QueryEngine({
            provider,
            systemPrompt,
            tools,
            permissions,
            maxTokens: config.maxTokens,
            maxTurns: config.maxTurns,
            maxBudgetUsd: config.maxBudgetUsd,
            autoCompactThreshold: config.autoCompactThreshold,
            initialMessages,
        });
        // 根据用户消息动态更新 systemPrompt（按任务类型注入扩展块）
        async function buildPromptForMessage(msg) {
            const taskPrompt = getCoordinatorSystemPrompt(msg);
            const fullPrompt = await buildSystemContext(taskPrompt, getGlobalCwd());
            engine.setSystemPrompt(fullPrompt);
        }
        // 恢复持久化的定时任务（回调由 App 组件内注册，避免绕过 Ink 渲染层）
        restoreScheduledJobs();
        // 非交互模式
        if (opts.print) {
            const maxChars = opts.maxChars ? parseInt(opts.maxChars, 10) : Infinity;
            let totalChars = 0;
            let truncated = false;
            await buildPromptForMessage(opts.print);
            for await (const ev of engine.send(opts.print)) {
                if (ev.type === 'text_delta') {
                    if (truncated)
                        continue;
                    const remaining = maxChars - totalChars;
                    if (ev.delta.length > remaining) {
                        process.stdout.write(ev.delta.slice(0, remaining));
                        process.stdout.write(`\n...[输出已截断，共超过 ${maxChars} 字符，使用 --max-chars 调整上限]`);
                        truncated = true;
                    }
                    else {
                        process.stdout.write(ev.delta);
                        totalChars += ev.delta.length;
                    }
                }
                else if (ev.type === 'error') {
                    process.stderr.write(`\n错误: ${ev.message}\n`);
                }
            }
            process.stdout.write('\n');
            saveSession(sessionId, engine.getHistory(), model, initialCwd);
            void autoExtractMemories(engine, sessionId, provider, memoryCondense);
            void autoDistillSkill(engine, provider);
            await disconnectAllMcp();
            return;
        }
        // Server 模式：持续从 stdin 读取消息，保持会话历史
        if (opts.server) {
            process.env.AGENT_SERVER_MODE = '1';
            // 注册压缩前归档回调（server 模式同样需要）
            engine.onBeforeCompact = async (summary) => {
                saveSession(sessionId, engine.getHistory(), model, initialCwd);
                archiveSession(sessionId, summary);
            };
            const { createInterface } = await import('readline');
            const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
            const emit = (obj) => {
                try {
                    process.stdout.write(JSON.stringify(obj) + '\n');
                }
                catch (e) {
                    process.stderr.write(`[emit error] ${String(e)}\n`);
                }
            };
            // 捕获未处理的异常，确保进程不会静默崩溃
            process.on('uncaughtException', (err) => {
                process.stderr.write(`[uncaughtException] ${String(err)}\n`);
                emit({ type: 'error', message: `进程内部错误: ${String(err)}` });
            });
            process.on('unhandledRejection', (reason) => {
                process.stderr.write(`[unhandledRejection] ${String(reason)}\n`);
                emit({ type: 'error', message: `未处理的异步错误: ${String(reason)}` });
            });
            emit({ type: 'ready' });
            // 初始化斜杠命令和 skills（server 模式同样支持）
            registerAllBundledSkills();
            const serverRegistry = new CommandRegistry();
            createBuiltinCommands('', model).forEach(c => serverRegistry.register(c));
            serverRegistry.registerSkills(buildSkillRegistry(getGlobalCwd()));
            // 用 Promise 链实现严格串行执行，彻底避免锁竞态
            // 每条消息都挂在上一条的 Promise 尾部，保证顺序且不并发
            let taskChain = Promise.resolve();
            const enqueueMessage = (msg) => {
                taskChain = taskChain.then(async () => {
                    // 处理斜杠命令（skill 注入等）
                    const parsed = serverRegistry.parse(msg);
                    if (parsed) {
                        const cmd = serverRegistry.find(parsed.name);
                        if (!cmd) {
                            emit({ type: 'error', message: `未知命令: /${parsed.name}` });
                            emit({ type: 'done' });
                            return;
                        }
                        // 构建最小 CommandContext（server 模式下部分功能不可用）
                        const serverCtx = {
                            clearHistory: () => engine.clearHistory(),
                            compactHistory: async (s) => { engine.compactHistory(s); },
                            generateCompactSummary: async () => engine.generateCompactSummary(),
                            getHistoryLength: () => engine.getHistory().length,
                            getEstimatedTokens: () => engine.getEstimatedTokens(),
                            getCostSummary: () => engine.costs.getSummary(),
                            getBudgetInfo: () => ({ spent: engine.costs.getCostUsd(), limit: undefined }),
                            setModel: (m) => { },
                            getModel: () => model,
                            setMode: (_m) => { },
                            getMode: () => permMode,
                            sessionId,
                            listSessions: () => listSessions(),
                            listArchives: () => listArchives(sessionId),
                            newSession: () => {
                                const newId = generateSessionId();
                                engine.clearHistory();
                                // 重置工作目录，防止旧任务文件污染新任务
                                const newWorkDir = getSessionWorkDir(newId);
                                setGlobalCwd(newWorkDir);
                                try {
                                    process.chdir(newWorkDir);
                                }
                                catch { /* 忽略 */ }
                            },
                            switchSession: (id) => {
                                const messages = loadSession(id);
                                if (!messages)
                                    return false;
                                engine.setHistory(messages);
                                return true;
                            },
                        };
                        const result = await cmd.execute(parsed.args, serverCtx);
                        if (result.type === 'exit') {
                            process.exit(0);
                        }
                        if (result.type === 'message') {
                            emit({ type: 'text_delta', delta: result.text });
                            emit({ type: 'done' });
                            return;
                        }
                        if (result.type === 'noop') {
                            emit({ type: 'done' });
                            return;
                        }
                        if (result.type === 'inject') {
                            // skill inject：将 skill prompt 发给 LLM
                            try {
                                await buildPromptForMessage(result.prompt);
                                for await (const ev of engine.send(result.prompt)) {
                                    emit(ev);
                                }
                                saveSession(sessionId, engine.getHistory(), model, initialCwd);
                                void autoExtractMemories(engine, sessionId, provider, memoryCondense);
                                void autoDistillSkill(engine, provider);
                            }
                            catch (err) {
                                emit({ type: 'error', message: `skill 执行失败: ${String(err)}` });
                                emit({ type: 'done' });
                            }
                            return;
                        }
                        return;
                    }
                    const msgWithCtx = msg + getDynamicContext(getGlobalCwd());
                    try {
                        await buildPromptForMessage(msg);
                        for await (const ev of engine.send(msgWithCtx)) {
                            emit(ev);
                        }
                        saveSession(sessionId, engine.getHistory(), model, initialCwd);
                        void autoExtractMemories(engine, sessionId, provider, memoryCondense);
                        void autoDistillSkill(engine, provider);
                    }
                    catch (err) {
                        process.stderr.write(`[server] 消息处理异常: ${String(err)}\n`);
                        emit({ type: 'error', message: `消息处理失败: ${String(err)}` });
                        emit({ type: 'done' });
                    }
                });
            };
            for await (const line of rl) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                let msg;
                try {
                    const parsed = JSON.parse(trimmed);
                    // 处理用户对 ask_user 的回复（可在任务执行期间到达）
                    if (parsed.type === 'user_reply') {
                        resolveAskUser(parsed.answer ?? '');
                        continue;
                    }
                    // 处理用户对 request_decision 的回复
                    if (parsed.type === 'decision_reply') {
                        resolveDecision(parsed.answer ?? '');
                        continue;
                    }
                    // 处理中止指令（立即中止当前任务，不排队）
                    if (parsed.type === 'abort') {
                        engine.abort();
                        continue;
                    }
                    // 处理切换工作目录指令
                    if (parsed.type === 'set_cwd' && parsed.cwd) {
                        try {
                            process.chdir(parsed.cwd);
                            setGlobalCwd(parsed.cwd);
                            emit({ type: 'cwd_changed', cwd: parsed.cwd });
                        }
                        catch (e) {
                            emit({ type: 'error', message: `切换目录失败: ${String(e)}` });
                        }
                        continue;
                    }
                    msg = parsed.message ?? trimmed;
                }
                catch {
                    msg = trimmed;
                }
                // 加入 Promise 链，严格串行执行
                enqueueMessage(msg);
            }
            await disconnectAllMcp();
            return;
        }
        // 注册斜杠命令
        const registry = new CommandRegistry();
        createBuiltinCommands('', model).forEach(c => registry.register(c));
        // 初始化 skills 系统，注册内置 skills 并加载用户/项目级 skills
        registerAllBundledSkills();
        const skillRegistry = buildSkillRegistry(getGlobalCwd());
        registry.registerSkills(skillRegistry);
        let currentModel = model;
        // 注册压缩前归档回调：保留完整历史，workDir 不变
        engine.onBeforeCompact = async (summary) => {
            saveSession(sessionId, engine.getHistory(), currentModel, initialCwd);
            archiveSession(sessionId, summary);
        };
        // 自动保存会话 + 自动沉淀 skill + 动态注入扩展 prompt
        const originalSend = engine.send.bind(engine);
        engine.send = async function* (msg) {
            await buildPromptForMessage(msg);
            yield* originalSend(msg);
            saveSession(sessionId, engine.getHistory(), currentModel, initialCwd);
            void autoExtractMemories(engine, sessionId, provider, memoryCondense);
            void autoDistillSkill(engine, provider);
        };
        const { waitUntilExit } = render(React.createElement(App, {
            engine,
            commands: registry,
            sessionId,
            currentModel,
            providerName: provider.name,
            getProviderName: () => ({ name: provider.name, model: provider.model }),
            onModelChange: (m) => {
                currentModel = m;
                saveConfig({ model: m });
            },
        }));
        await waitUntilExit();
        await disconnectAllMcp();
    });
    await program.parseAsync();
}
main().catch(err => {
    logger.error('启动失败', { error: String(err) });
    console.error('启动失败:', err);
    process.exit(1);
});
// 全局未捕获异常保护（非 gateway/server 模式）
// Gateway 模式会在启动后覆盖这两个处理器（不退出进程）
process.on('uncaughtException', (err) => {
    logger.error('未捕获异常', { error: err.message, stack: err.stack });
    // 仅在非 gateway 模式下退出（gateway 模式会 removeAllListeners 后重新注册）
    if (!process.argv.includes('--gateway')) {
        process.exit(1);
    }
});
process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { reason: String(reason) });
    if (!process.argv.includes('--gateway')) {
        // 非 gateway 模式下记录但不强制退出，避免误杀
    }
});
