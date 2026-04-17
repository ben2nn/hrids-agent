// Gateway HTTP + WebSocket 服务器
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { SessionManager } from './SessionManager.js';
import { listSessions as listDiskSessions, loadSession as loadDiskSession, loadSessionMeta } from '../core/SessionStore.js';
import { logger } from '../core/logger.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { resolve, join, basename, extname } from 'path';
import { homedir } from 'os';
import { loadConfig, saveConfig } from '../core/Config.js';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
const log = logger.child({ component: 'gateway-server' });
// 简单的内存速率限制（令牌桶，按 IP 计数）
class RateLimiter {
    limit;
    windowMs;
    counts = new Map();
    constructor(limit, windowMs = 60_000) {
        this.limit = limit;
        this.windowMs = windowMs;
    }
    check(ip) {
        const now = Date.now();
        const entry = this.counts.get(ip);
        if (!entry || now > entry.resetAt) {
            this.counts.set(ip, { count: 1, resetAt: now + this.windowMs });
            return true;
        }
        if (entry.count >= this.limit)
            return false;
        entry.count++;
        return true;
    }
}
export function createGateway(config = {}) {
    const port = config.port ?? 3282;
    const host = config.host ?? '127.0.0.1';
    const startTime = Date.now();
    const manager = new SessionManager({
        idleTimeoutMs: config.idleTimeoutMs,
        maxSessions: config.maxSessions,
        authToken: config.authToken,
    });
    const rateLimiter = new RateLimiter(config.rateLimitPerMinute ?? 10);
    const app = express();
    app.use(express.json());
    // ── CORS 中间件（在所有 API 路由之前）──────────────────────
    const corsOrigin = config.corsOrigin ?? '*';
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    });
    // ── 鉴权中间件 ──────────────────────────────────────────────
    app.use((req, res, next) => {
        if (!config.authToken)
            return next();
        const auth = req.headers.authorization ?? '';
        if (auth === `Bearer ${config.authToken}`)
            return next();
        log.warn('未授权请求', { path: req.path, ip: req.ip });
        res.status(401).json({ error: '未授权' });
    });
    // ── REST API ─────────────────────────────────────────────────
    // 列出所有会话
    app.get('/sessions', (_req, res) => {
        res.json(manager.listSessions());
    });
    // 列出历史会话（从磁盘读取，包含已停止的会话）
    app.get('/sessions/history', (_req, res) => {
        try {
            const diskSessions = listDiskSessions();
            const activeSessions = manager.listSessions();
            const activeIds = new Set(activeSessions.map(s => s.id));
            // 合并：活跃 session 用内存数据，历史 session 转为 stopped 状态
            const history = diskSessions
                .filter(s => !activeIds.has(s.id))
                .map(s => ({
                id: s.id,
                status: 'stopped',
                createdAt: new Date(s.createdAt).getTime(),
                lastActiveAt: new Date(s.updatedAt).getTime(),
                model: s.model ?? '',
                cwd: s.workDir ?? '',
                title: s.title ?? '',
            }));
            res.json([...activeSessions, ...history]);
        }
        catch (err) {
            log.warn('读取历史会话失败', { error: String(err) });
            res.json(manager.listSessions());
        }
    });
    // 创建新会话（带速率限制）
    app.post('/sessions', async (req, res) => {
        const ip = req.ip ?? 'unknown';
        if (!rateLimiter.check(ip)) {
            log.warn('速率限制触发', { ip });
            res.status(429).json({ error: '请求过于频繁，请稍后再试' });
            return;
        }
        try {
            const body = req.body;
            const session = await manager.createSession(body);
            // 返回完整的 SessionInfo，前端直接使用 session.id 等字段
            res.json(session.info);
        }
        catch (err) {
            log.error('创建会话失败', { error: String(err) });
            res.status(500).json({ error: String(err) });
        }
    });
    // 查询单个会话状态
    app.get('/sessions/:id', (req, res) => {
        const session = manager.getSession(req.params.id);
        if (!session)
            return res.status(404).json({ error: '会话不存在' });
        res.json(session.info);
    });
    // 销毁会话
    app.delete('/sessions/:id', async (req, res) => {
        await manager.destroySession(req.params.id);
        res.json({ ok: true });
    });
    // 健康检查（增强版：包含运行时指标）
    app.get('/health', (_req, res) => {
        const sessions = manager.listSessions();
        const busySessions = sessions.filter(s => s.status === 'busy').length;
        const memUsage = process.memoryUsage();
        res.json({
            status: 'ok',
            uptime: Math.floor((Date.now() - startTime) / 1000),
            sessions: {
                total: sessions.length,
                busy: busySessions,
                idle: sessions.length - busySessions,
            },
            memory: {
                heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotalMb: Math.round(memUsage.heapTotal / 1024 / 1024),
                rssMb: Math.round(memUsage.rss / 1024 / 1024),
            },
        });
    });
    // GET /config — 读取 agent 全局配置（模型、权限模式等）
    app.get('/config', (_req, res) => {
        try {
            const cfg = loadConfig();
            res.json({
                model: cfg.model,
                permissionMode: cfg.permissionMode,
                maxTokens: cfg.maxTokens,
                maxTurns: cfg.maxTurns,
            });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // PUT /config — 更新 agent 全局配置
    app.put('/config', (req, res) => {
        try {
            const body = req.body;
            const patch = {};
            if (body.model)
                patch.model = body.model;
            if (body.permissionMode && ['ask', 'auto', 'plan'].includes(body.permissionMode)) {
                patch.permissionMode = body.permissionMode;
            }
            saveConfig(patch);
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // GET /config/models — 从环境变量解析可用模型列表
    app.get('/config/models', (_req, res) => {
        try {
            const models = [];
            const defaultModel = process.env.DEFAULT_MODEL ?? loadConfig().model;
            // 解析 LLM_FALLBACK_N 环境变量
            let n = 1;
            while (true) {
                const val = process.env[`LLM_FALLBACK_${n}`];
                if (!val)
                    break;
                // 格式：provider:aliyun,models:m1,m2[,apiKey:xxx][,baseUrl:xxx]
                const parts = val.split(',');
                let provider = '';
                const modelNames = [];
                for (const part of parts) {
                    if (part.startsWith('provider:'))
                        provider = part.slice('provider:'.length);
                    else if (part.startsWith('models:'))
                        modelNames.push(...part.slice('models:'.length).split(',').filter(Boolean));
                    else if (!part.includes(':'))
                        modelNames.push(part); // 裸模型名兼容
                }
                for (const m of modelNames) {
                    if (m)
                        models.push({ provider, model: m, isDefault: m === defaultModel });
                }
                n++;
            }
            // 若没有 FALLBACK 配置，至少返回 DEFAULT_MODEL
            if (models.length === 0 && defaultModel) {
                models.push({ provider: 'default', model: defaultModel, isDefault: true });
            }
            // 确保 defaultModel 标记正确（可能不在 FALLBACK 列表里）
            const hasDefault = models.some(m => m.isDefault);
            if (!hasDefault && defaultModel) {
                models.unshift({ provider: 'default', model: defaultModel, isDefault: true });
            }
            res.json({ models, defaultModel });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // GET /todos — 读取全局任务列表
    app.get('/todos', (_req, res) => {
        const todoFile = join(homedir(), '.hrids-agent', 'todos.json');
        if (!existsSync(todoFile)) {
            res.json([]);
            return;
        }
        try {
            const raw = JSON.parse(readFileSync(todoFile, 'utf-8'));
            res.json(Array.isArray(raw) ? raw : []);
        }
        catch {
            res.json([]);
        }
    });
    // GET /sessions/:id/messages — 读取会话历史消息（转换为前端 DisplayMessage 格式）
    app.get('/sessions/:id/messages', (req, res) => {
        // 优先从内存中的活跃 session 读取（最新状态）
        const activeSession = manager.getSession(req.params.id);
        const rawMessages = activeSession
            ? activeSession.engine.getHistory()
            : loadDiskSession(req.params.id);
        if (!rawMessages) {
            res.json([]);
            return;
        }
        const toolResults = new Map();
        for (const msg of rawMessages) {
            if (msg.role !== 'user' || !Array.isArray(msg.content))
                continue;
            for (const block of msg.content) {
                if (block.type === 'tool_result' && block.tool_use_id) {
                    toolResults.set(block.tool_use_id, {
                        content: block.content,
                        isError: block.is_error === true,
                    });
                }
            }
        }
        // ── 第二遍：构建 DisplayMessage 列表，tool 消息附带 input/status/result ─
        const displayMessages = [];
        let idx = 0;
        for (const msg of rawMessages) {
            const timestamp = Date.now() - (rawMessages.length - idx) * 1000;
            idx++;
            if (msg.role === 'user') {
                if (typeof msg.content === 'string') {
                    // 跳过系统内部注入的消息
                    if (msg.content.startsWith('[系统') || msg.content.startsWith('[上下文压缩]'))
                        continue;
                    displayMessages.push({ id: `u-${idx}`, type: 'user', content: msg.content, timestamp });
                }
                // tool_result 不单独显示（结果附在 tool 消息上）
            }
            else if (msg.role === 'assistant') {
                if (typeof msg.content === 'string') {
                    if (msg.content.trim()) {
                        displayMessages.push({ id: `a-${idx}`, type: 'assistant', content: msg.content, timestamp });
                    }
                }
                else if (Array.isArray(msg.content)) {
                    // 提取 text 块
                    const textParts = msg.content
                        .filter(b => b.type === 'text')
                        .map(b => b.text ?? '')
                        .join('');
                    if (textParts.trim()) {
                        displayMessages.push({ id: `a-${idx}`, type: 'assistant', content: textParts, timestamp });
                    }
                    // 提取 tool_use 块，附带 input 和对应的 tool_result
                    for (const block of msg.content) {
                        if (block.type === 'tool_use' && block.id && block.name) {
                            const resultEntry = toolResults.get(block.id);
                            displayMessages.push({
                                id: `t-${block.id}`,
                                type: 'tool',
                                toolId: block.id,
                                toolName: block.name,
                                toolInput: block.input,
                                toolStatus: resultEntry ? (resultEntry.isError ? 'error' : 'success') : 'success',
                                toolResult: resultEntry?.content,
                                timestamp: timestamp + 1,
                            });
                        }
                    }
                }
            }
        }
        res.json(displayMessages);
    });
    // GET /sessions/:id/todos — 读取会话任务列表（活跃或历史会话均可）
    app.get('/sessions/:id/todos', (req, res) => {
        const todoFile = join(homedir(), '.hrids-agent', 'sessions', req.params.id, 'todos.json');
        if (!existsSync(todoFile)) {
            res.json([]);
            return;
        }
        try {
            const raw = JSON.parse(readFileSync(todoFile, 'utf-8'));
            res.json(Array.isArray(raw) ? raw : []);
        }
        catch {
            res.json([]);
        }
    });
    // GET /sessions/:id/files?path= — 读取会话工作目录文件列表（活跃或历史会话均可）
    app.get('/sessions/:id/files', (req, res) => {
        // 优先从内存中取 cwd，历史会话则从磁盘 meta 读取
        const activeSession = manager.getSession(req.params.id);
        const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null;
        if (!cwd) {
            res.status(404).json({ error: '会话不存在或无工作目录' });
            return;
        }
        const relPath = req.query.path || '.';
        // 安全检查：禁止 .. 跳出 cwd
        const absPath = resolve(cwd, relPath);
        if (!absPath.startsWith(resolve(cwd))) {
            res.status(403).json({ error: '禁止访问 cwd 之外的路径' });
            return;
        }
        try {
            const entries = readdirSync(absPath).map(name => {
                const entryPath = join(absPath, name);
                const stat = statSync(entryPath);
                return {
                    name,
                    type: stat.isDirectory() ? 'dir' : 'file',
                    size: stat.isFile() ? stat.size : undefined,
                    mtime: stat.mtimeMs,
                };
            });
            // 目录优先，同类型按名称字母序
            entries.sort((a, b) => {
                if (a.type !== b.type)
                    return a.type === 'dir' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            res.json({ cwd, path: relPath, entries });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // GET /sessions/:id/file-content?path= — 读取单个文件内容
    app.get('/sessions/:id/file-content', (req, res) => {
        const activeSession = manager.getSession(req.params.id);
        const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null;
        if (!cwd) {
            res.status(404).json({ error: '会话不存在或无工作目录' });
            return;
        }
        const relPath = req.query.path;
        if (!relPath) {
            res.status(400).json({ error: '缺少 path 参数' });
            return;
        }
        const absPath = resolve(cwd, relPath);
        if (!absPath.startsWith(resolve(cwd))) {
            res.status(403).json({ error: '禁止访问 cwd 之外的路径' });
            return;
        }
        try {
            const stat = statSync(absPath);
            if (!stat.isFile()) {
                res.status(400).json({ error: '路径不是文件' });
                return;
            }
            // 限制文件大小：2MB
            if (stat.size > 2 * 1024 * 1024) {
                res.status(413).json({ error: '文件超过 2MB，无法在线预览' });
                return;
            }
            const content = readFileSync(absPath, 'utf-8');
            res.json({ path: relPath, content, size: stat.size, mtime: stat.mtimeMs });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // GET /sessions/:id/file-preview?path= — 预览 Word/Excel 文件
    // docx → { type: 'html', html: string }
    // xlsx/xls/csv → { type: 'table', sheets: Array<{ name, headers, rows }> }
    app.get('/sessions/:id/file-preview', async (req, res) => {
        const activeSession = manager.getSession(req.params.id);
        const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null;
        if (!cwd) {
            res.status(404).json({ error: '会话不存在或无工作目录' });
            return;
        }
        const relPath = req.query.path;
        if (!relPath) {
            res.status(400).json({ error: '缺少 path 参数' });
            return;
        }
        const absPath = resolve(cwd, relPath);
        if (!absPath.startsWith(resolve(cwd))) {
            res.status(403).json({ error: '禁止访问 cwd 之外的路径' });
            return;
        }
        try {
            const stat = statSync(absPath);
            if (!stat.isFile()) {
                res.status(400).json({ error: '路径不是文件' });
                return;
            }
            if (stat.size > 20 * 1024 * 1024) {
                res.status(413).json({ error: '文件超过 20MB，无法预览' });
                return;
            }
            const ext = extname(absPath).toLowerCase();
            if (ext === '.docx') {
                const result = await mammoth.convertToHtml({ path: absPath });
                res.json({ type: 'html', html: result.value });
                return;
            }
            if (ext === '.doc') {
                // .doc 是旧版二进制格式，mammoth 支持有限，尝试提取纯文本
                const result = await mammoth.extractRawText({ path: absPath });
                // 将纯文本转为简单 HTML（保留换行）
                const html = result.value
                    .split('\n')
                    .map(line => line.trim() ? `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : '<br>')
                    .join('');
                res.json({ type: 'html', html });
                return;
            }
            if (['.xlsx', '.xls', '.csv'].includes(ext)) {
                const buf = readFileSync(absPath);
                const workbook = XLSX.read(buf, { type: 'buffer' });
                const sheets = workbook.SheetNames.map(name => {
                    const ws = workbook.Sheets[name];
                    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
                    if (json.length === 0)
                        return { name, headers: [], rows: [] };
                    const [headers, ...rows] = json;
                    return {
                        name,
                        headers: headers.map(h => String(h ?? '')),
                        rows: rows.map(r => headers.map((_, i) => String(r[i] ?? ''))),
                    };
                });
                res.json({ type: 'table', sheets });
                return;
            }
            res.status(400).json({ error: '不支持的文件格式，仅支持 docx/doc/xlsx/xls/csv' });
        }
        catch (err) {
            log.error('文件预览失败', { error: String(err) });
            res.status(500).json({ error: String(err) });
        }
    });
    // PUT /sessions/:id/file-content — 保存单个文件内容
    // 请求体：JSON { path: string; content: string }
    app.put('/sessions/:id/file-content', (req, res) => {
        const activeSession = manager.getSession(req.params.id);
        const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null;
        if (!cwd) {
            res.status(404).json({ error: '会话不存在或无工作目录' });
            return;
        }
        try {
            const body = req.body;
            if (!body.path || typeof body.content !== 'string') {
                res.status(400).json({ error: '请求体缺少 path 或 content 字段' });
                return;
            }
            const absPath = resolve(cwd, body.path);
            if (!absPath.startsWith(resolve(cwd))) {
                res.status(403).json({ error: '禁止写入 cwd 之外的路径' });
                return;
            }
            mkdirSync(resolve(absPath, '..'), { recursive: true });
            writeFileSync(absPath, body.content, 'utf-8');
            log.info('文件内容已保存', { sessionId: req.params.id, path: body.path });
            res.json({ ok: true });
        }
        catch (err) {
            log.error('文件保存失败', { error: String(err) });
            res.status(500).json({ error: String(err) });
        }
    });
    // POST /sessions/:id/upload — 上传文件到会话工作目录
    // 请求体：JSON { files: Array<{ name: string; data: string }> }
    // data 为 base64 编码的文件内容
    app.post('/sessions/:id/upload', (req, res) => {
        const activeSession = manager.getSession(req.params.id);
        const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null;
        if (!cwd) {
            res.status(404).json({ error: '会话不存在或无工作目录' });
            return;
        }
        try {
            const body = req.body;
            if (!Array.isArray(body.files) || body.files.length === 0) {
                res.status(400).json({ error: '请求体缺少 files 字段' });
                return;
            }
            // 限制单次上传数量
            if (body.files.length > 20) {
                res.status(400).json({ error: '单次最多上传 20 个文件' });
                return;
            }
            const uploaded = [];
            for (const file of body.files) {
                if (!file.name || typeof file.data !== 'string') {
                    res.status(400).json({ error: '文件格式错误：缺少 name 或 data' });
                    return;
                }
                // 安全处理文件名：去掉路径分隔符，防止路径穿越
                const safeName = basename(file.name).replace(/[/\\]/g, '_');
                if (!safeName) {
                    res.status(400).json({ error: `无效的文件名: ${file.name}` });
                    return;
                }
                const destPath = resolve(cwd, safeName);
                // 安全检查：确保目标路径在 cwd 内
                if (!destPath.startsWith(resolve(cwd))) {
                    res.status(403).json({ error: '禁止写入 cwd 之外的路径' });
                    return;
                }
                // 解码 base64 并写入文件
                const buffer = Buffer.from(file.data, 'base64');
                // 限制单文件大小：50MB
                if (buffer.length > 50 * 1024 * 1024) {
                    res.status(400).json({ error: `文件 ${safeName} 超过 50MB 限制` });
                    return;
                }
                mkdirSync(cwd, { recursive: true });
                writeFileSync(destPath, buffer);
                log.info('文件已上传', { sessionId: req.params.id, file: safeName, size: buffer.length });
                uploaded.push({ name: safeName, path: destPath, size: buffer.length });
            }
            res.json({ files: uploaded });
        }
        catch (err) {
            log.error('文件上传失败', { error: String(err) });
            res.status(500).json({ error: String(err) });
        }
    });
    // GET /crons — 读取定时任务列表
    app.get('/crons', (_req, res) => {
        const cronFile = join(homedir(), '.hrids-agent', 'crons.json');
        if (!existsSync(cronFile)) {
            res.json([]);
            return;
        }
        try {
            const raw = JSON.parse(readFileSync(cronFile, 'utf-8'));
            res.json(Array.isArray(raw) ? raw : []);
        }
        catch {
            res.json([]);
        }
    });
    // PUT /crons/:id/toggle — 启用/禁用定时任务
    app.put('/crons/:id/toggle', (req, res) => {
        const cronFile = join(homedir(), '.hrids-agent', 'crons.json');
        if (!existsSync(cronFile)) {
            res.status(404).json({ error: '定时任务文件不存在' });
            return;
        }
        try {
            const crons = JSON.parse(readFileSync(cronFile, 'utf-8'));
            const idx = crons.findIndex(c => c.id === req.params.id);
            if (idx === -1) {
                res.status(404).json({ error: '定时任务不存在' });
                return;
            }
            const { enabled } = req.body;
            crons[idx].enabled = enabled;
            writeFileSync(cronFile, JSON.stringify(crons, null, 2), 'utf-8');
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // DELETE /crons/:id — 删除定时任务
    app.delete('/crons/:id', (req, res) => {
        const cronFile = join(homedir(), '.hrids-agent', 'crons.json');
        if (!existsSync(cronFile)) {
            res.status(404).json({ error: '定时任务文件不存在' });
            return;
        }
        try {
            const crons = JSON.parse(readFileSync(cronFile, 'utf-8'));
            const filtered = crons.filter(c => c.id !== req.params.id);
            if (filtered.length === crons.length) {
                res.status(404).json({ error: '定时任务不存在' });
                return;
            }
            writeFileSync(cronFile, JSON.stringify(filtered, null, 2), 'utf-8');
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // GET /skills — 读取已安装技能列表
    app.get('/skills', async (_req, res) => {
        try {
            const { loadSkillsFromDir, getBundledSkills, getUserSkillsDir, getDisabledUserSkills } = await import('../skills/registry.js');
            const { registerAllBundledSkills } = await import('../skills/bundled/index.js');
            const { existsSync, readFileSync } = await import('fs');
            const { join } = await import('path');
            const { homedir } = await import('os');
            // 确保内置 skills 已注册
            if (getBundledSkills().length === 0) {
                registerAllBundledSkills();
            }
            // 读取 user lockfile，获取已安装的 slug 集合
            const userSkillsDir = getUserSkillsDir();
            const lockPath = join(userSkillsDir, '.skills_store_lock.json');
            let installedSlugs = new Set();
            if (existsSync(lockPath)) {
                try {
                    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
                    installedSlugs = new Set(Object.keys(lock.skills ?? {}));
                }
                catch { /* 解析失败忽略 */ }
            }
            // 读取禁用列表
            const disabledSet = getDisabledUserSkills();
            // 内置技能（从全局注册表取）
            const builtinSkills = getBundledSkills()
                .filter(s => s.userInvocable)
                .map(s => ({
                name: s.name,
                description: s.description,
                source: 'builtin',
                installed: undefined,
                enabled: undefined,
            }));
            // 用户技能：直接从文件系统加载，不经过禁用过滤，确保禁用的技能也能显示
            // 异步读取 SKILL.md 内容作为 prompt（用于前端详情展示）
            const userSkillsRaw = loadSkillsFromDir(userSkillsDir, 'user');
            const userSkills = await Promise.all(userSkillsRaw.map(async (s) => ({
                name: s.name,
                description: s.description,
                source: 'user',
                installed: installedSlugs.has(s.name),
                enabled: !disabledSet.has(s.name),
                prompt: s.getPrompt ? await s.getPrompt('') : undefined,
            })));
            res.json([...builtinSkills, ...userSkills]);
        }
        catch (err) {
            log.warn('获取技能列表失败', { error: String(err) });
            res.json([]);
        }
    });
    // PUT /skills/:name/toggle — 切换用户技能启用/禁用状态
    app.put('/skills/:name/toggle', async (req, res) => {
        try {
            const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import('fs');
            const { join } = await import('path');
            const { homedir } = await import('os');
            const skillName = decodeURIComponent(req.params.name);
            const { enabled } = req.body;
            const agentDir = join(homedir(), '.hrids-agent');
            const disabledPath = join(agentDir, 'skills-disabled.json');
            let disabled = [];
            if (existsSync(disabledPath)) {
                try {
                    const arr = JSON.parse(readFileSync(disabledPath, 'utf-8'));
                    disabled = Array.isArray(arr) ? arr : [];
                }
                catch { /* 忽略 */ }
            }
            if (enabled) {
                disabled = disabled.filter(n => n !== skillName);
            }
            else {
                if (!disabled.includes(skillName))
                    disabled.push(skillName);
            }
            mkdirSync(agentDir, { recursive: true });
            writeFileSync(disabledPath, JSON.stringify(disabled, null, 2), 'utf-8');
            res.json({ ok: true, enabled });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // POST /skills/market/install — 从技能市场安装技能
    app.post('/skills/market/install', async (req, res) => {
        try {
            const { slug, force = false } = req.body;
            if (!slug || typeof slug !== 'string') {
                res.status(400).json({ error: '缺少 slug 参数' });
                return;
            }
            // 直接复用 SkillHubInstallTool 的 execute 逻辑
            const { SkillHubInstallTool } = await import('../tools/SkillHubTool.js');
            const result = await SkillHubInstallTool.execute({ skill_id: slug, scope: 'user', force });
            if (result.type === 'success') {
                res.json({ ok: true, message: result.output });
            }
            else {
                res.status(500).json({ error: result.message });
            }
        }
        catch (err) {
            log.warn('技能安装失败', { error: String(err) });
            res.status(500).json({ error: String(err) });
        }
    });
    // DELETE /skills/market/uninstall/:slug — 卸载技能
    app.delete('/skills/market/uninstall/:slug', async (req, res) => {
        try {
            const slug = decodeURIComponent(req.params.slug);
            if (!slug) {
                res.status(400).json({ error: '缺少 slug 参数' });
                return;
            }
            const { SkillHubUninstallTool } = await import('../tools/SkillHubTool.js');
            const result = await SkillHubUninstallTool.execute({ skill_id: slug, scope: 'user' });
            if (result.type === 'success') {
                res.json({ ok: true, message: result.output });
            }
            else {
                res.status(500).json({ error: result.message });
            }
        }
        catch (err) {
            log.warn('技能卸载失败', { error: String(err) });
            res.status(500).json({ error: String(err) });
        }
    });
    // GET /skills/market/search — 技能市场搜索（代理 SkillHub API，避免前端跨域）
    app.get('/skills/market/search', async (req, res) => {
        try {
            const q = String(req.query.q ?? '').trim();
            const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 500);
            const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
            const searchApiBase = (process.env.SKILLHUB_SEARCH_URL ?? 'https://lightmake.site/api/v1/search').replace(/\/$/, '');
            const offset = (page - 1) * limit;
            const url = `${searchApiBase}?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&page=${page}`;
            const upstream = await fetch(url, {
                headers: { 'User-Agent': 'hrids-agent/skillhub', 'Accept': 'application/json' },
                signal: AbortSignal.timeout(10000),
            });
            if (!upstream.ok) {
                res.status(upstream.status).json({ error: `SkillHub API 返回 ${upstream.status}` });
                return;
            }
            const data = await upstream.json();
            // 标准化返回格式
            const results = (data.results ?? []).map(item => ({
                slug: String(item.slug ?? ''),
                name: String(item.displayName ?? item.name ?? item.slug ?? '').trim(),
                description: String(item.summary ?? item.description ?? '').trim(),
                version: String(item.version ?? '').trim(),
                category: String(item.category ?? '').trim(),
                tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
                author: String(item.author ?? '').trim(),
                downloads: typeof item.downloads === 'number' ? item.downloads : 0,
                icon: String(item.icon ?? '').trim(),
            }));
            res.json({ results, total: data.total ?? results.length });
        }
        catch (err) {
            log.warn('技能市场搜索失败', { error: String(err) });
            res.status(500).json({ error: String(err) });
        }
    });
    // ── WebSocket 服务器 ─────────────────────────────────────────
    const server = http.createServer(app);
    // 不设置 path，由 connection 回调自行匹配 /sessions/:id/stream
    const wss = new WebSocketServer({ server });
    // ── 静态文件托管（SPA fallback）──────────────────────────────
    const webDistPath = join(resolve('.'), 'web', 'dist');
    if (existsSync(webDistPath)) {
        log.info('托管前端静态文件', { path: webDistPath });
        app.use(express.static(webDistPath));
        // SPA fallback：所有未匹配的 GET 请求返回 index.html
        app.get('/{*splat}', (_req, res) => {
            res.sendFile(join(webDistPath, 'index.html'));
        });
    }
    wss.on('connection', (ws, req) => {
        // req.url 包含路径和查询参数，先解析出纯路径部分再匹配
        // 格式：/sessions/:id/stream 或 /sessions/:id/stream?token=xxx
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const match = parsedUrl.pathname.match(/^\/sessions\/([^/]+)\/stream$/);
        if (!match) {
            ws.close(1008, '无效的路径');
            return;
        }
        const sessionId = match[1];
        // WebSocket 鉴权（通过 URL query 参数 token 或 Sec-WebSocket-Protocol）
        if (config.authToken) {
            const token = parsedUrl.searchParams.get('token')
                ?? req.headers['sec-websocket-protocol'];
            if (token !== config.authToken) {
                log.warn('WebSocket 未授权', { sessionId });
                ws.close(1008, '未授权');
                return;
            }
        }
        const session = manager.getSession(sessionId);
        if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: `会话不存在: ${sessionId}` }));
            ws.close(1008, '会话不存在');
            return;
        }
        log.debug('WebSocket 连接', { sessionId });
        manager.subscribe(sessionId, ws);
        // 使用 sessionId（驼峰）与前端类型定义保持一致
        ws.send(JSON.stringify({ type: 'ready', sessionId }));
        ws.on('message', (data) => {
            manager.handleClientMessage(sessionId, data.toString());
        });
        ws.on('close', () => {
            log.debug('WebSocket 断开', { sessionId });
            manager.unsubscribe(sessionId, ws);
        });
        ws.on('error', (err) => {
            log.error('WebSocket 错误', { sessionId, error: err.message });
            manager.unsubscribe(sessionId, ws);
        });
    });
    return {
        start() {
            return new Promise(resolve => {
                server.listen(port, host, () => {
                    log.info('Gateway 已启动', { host, port });
                    resolve();
                });
            });
        },
        // 优雅关闭：等待进行中任务完成，再关闭 HTTP/WS 服务
        async stop(gracefulTimeoutMs = 10000) {
            log.info('开始关闭 Gateway');
            await manager.gracefulShutdown(gracefulTimeoutMs);
            return new Promise((resolve, reject) => {
                wss.close();
                server.close(err => {
                    if (err) {
                        log.error('关闭 HTTP 服务失败', { error: String(err) });
                        reject(err);
                    }
                    else {
                        log.info('Gateway 已关闭');
                        resolve();
                    }
                });
            });
        },
        manager,
        server,
    };
}
