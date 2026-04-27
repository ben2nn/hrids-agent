// 会话持久化 —— 将对话历史保存到本地磁盘
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const SESSIONS_DIR = join(homedir(), '.hrids-agent', 'sessions');
function ensureDir(dir) {
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
export function saveSession(sessionId, messages, model, workDir) {
    ensureDir(SESSIONS_DIR);
    const sessionDir = join(SESSIONS_DIR, sessionId);
    ensureDir(sessionDir);
    // 保存消息历史（JSONL 格式，每行一条消息）
    const lines = messages.map(m => JSON.stringify(m)).join('\n');
    writeFileSync(join(sessionDir, 'transcript.jsonl'), lines, 'utf-8');
    // 保存元数据
    const existing = loadSessionMeta(sessionId);
    const firstUserMsg = messages.find(m => m.role === 'user' && typeof m.content === 'string' &&
        !m.content.startsWith('[系统') && !m.content.startsWith('[上下文压缩]'));
    const title = typeof firstUserMsg?.content === 'string'
        ? firstUserMsg.content.slice(0, 60)
        : (existing?.title ?? '新对话');
    // 最近一条用户消息（跳过系统内部注入的消息）
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string' &&
        !m.content.startsWith('[系统') && !m.content.startsWith('[上下文压缩]'));
    const lastUserMessage = typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content.slice(0, 80)
        : undefined;
    const meta = {
        id: sessionId,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: messages.length,
        model,
        title,
        lastUserMessage,
        workDir: workDir ?? existing?.workDir,
    };
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}
export function loadSession(sessionId) {
    const transcriptPath = join(SESSIONS_DIR, sessionId, 'transcript.jsonl');
    if (!existsSync(transcriptPath))
        return null;
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l));
}
export function loadSessionMeta(sessionId) {
    const metaPath = join(SESSIONS_DIR, sessionId, 'meta.json');
    if (!existsSync(metaPath))
        return null;
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
}
export function listSessions() {
    ensureDir(SESSIONS_DIR);
    const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => loadSessionMeta(d.name))
        .filter((m) => m !== null);
    // 按更新时间倒序
    return dirs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function generateSessionId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
/** 获取最近一次会话的 ID，没有历史会话时返回 null */
export function getLastSessionId() {
    const sessions = listSessions();
    return sessions.length > 0 ? sessions[0].id : null;
}
/**
 * 归档当前会话历史（压缩前调用）
 * 将 transcript.jsonl 重命名为 transcript.{timestamp}.archive.jsonl
 * 同时保存归档元数据到 archives.json
 */
export function archiveSession(sessionId, summary) {
    const sessionDir = join(SESSIONS_DIR, sessionId);
    const transcriptPath = join(sessionDir, 'transcript.jsonl');
    if (!existsSync(transcriptPath)) {
        throw new Error(`会话 ${sessionId} 的 transcript.jsonl 不存在，无法归档`);
    }
    // 读取当前历史消息数量
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
    const messageCount = lines.length;
    // 生成归档文件名：transcript.{YYYYMMDD-HHmmss}.archive.jsonl
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const archiveFilename = `transcript.${timestamp}.archive.jsonl`;
    const archivePath = join(sessionDir, archiveFilename);
    // 复制（而非移动）transcript.jsonl 到归档文件，保留原文件供后续覆盖
    writeFileSync(archivePath, readFileSync(transcriptPath, 'utf-8'), 'utf-8');
    // 更新归档元数据列表
    const archivesPath = join(sessionDir, 'archives.json');
    let archives = [];
    if (existsSync(archivesPath)) {
        try {
            archives = JSON.parse(readFileSync(archivesPath, 'utf-8'));
        }
        catch { /* 解析失败时重置为空数组 */ }
    }
    archives.push({
        filename: archiveFilename,
        archivedAt: now.toISOString(),
        messageCount,
        summary,
    });
    writeFileSync(archivesPath, JSON.stringify(archives, null, 2), 'utf-8');
    return archiveFilename;
}
/**
 * 读取会话的所有归档段元数据
 */
export function listArchives(sessionId) {
    const archivesPath = join(SESSIONS_DIR, sessionId, 'archives.json');
    if (!existsSync(archivesPath))
        return [];
    try {
        const data = JSON.parse(readFileSync(archivesPath, 'utf-8'));
        return Array.isArray(data) ? data : [];
    }
    catch {
        return [];
    }
}
/**
 * 读取指定归档段的完整消息历史
 */
export function loadArchive(sessionId, filename) {
    const archivePath = join(SESSIONS_DIR, sessionId, filename);
    if (!existsSync(archivePath))
        return null;
    try {
        const lines = readFileSync(archivePath, 'utf-8').split('\n').filter(Boolean);
        return lines.map(l => JSON.parse(l));
    }
    catch {
        return null;
    }
}
/**
 * 从磁盘彻底删除会话目录（transcript、meta、归档文件等全部删除）。
 * 同时删除该会话的工作目录（~/.hrids-agent/work/<date>-<id>/）。
 * inMemoryCwd：活跃会话在内存中的 cwd，优先于 meta.json 里的 workDir（防止 meta 未写入的情况）。
 * 若目录不存在则静默忽略。
 */
export function deleteSessionFromDisk(sessionId, inMemoryCwd) {
    // 先读取 workDir（优先用内存传入的 cwd，其次读 meta.json）
    const meta = loadSessionMeta(sessionId);
    const workDir = inMemoryCwd ?? meta?.workDir;
    // 删除会话历史目录
    const sessionDir = join(SESSIONS_DIR, sessionId);
    if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
    }
    // 删除工作目录（仅删除 ~/.hrids-agent/work/ 下的子目录，防止误删用户自定义路径）
    if (workDir) {
        const workBase = join(homedir(), '.hrids-agent', 'work');
        // 安全检查：只删 work/ 下的目录，且不能是 work/ 本身
        if (workDir.startsWith(workBase + '/') || workDir.startsWith(workBase + '\\')) {
            if (existsSync(workDir)) {
                rmSync(workDir, { recursive: true, force: true });
            }
        }
    }
}
