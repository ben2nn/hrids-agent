// 结构化日志系统 —— 支持级别控制、JSON 格式、文件持久化
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_DIR = join(homedir(), '.hrids-agent', 'logs');
const LOG_FILE = join(LOG_DIR, 'agent.log');
// 单个日志文件上限 10MB，超出后轮转
const MAX_LOG_BYTES = 10 * 1024 * 1024;
function ensureLogDir() {
    if (!existsSync(LOG_DIR))
        mkdirSync(LOG_DIR, { recursive: true });
}
function rotateIfNeeded() {
    try {
        const { statSync } = require('fs');
        if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
            const { renameSync } = require('fs');
            renameSync(LOG_FILE, LOG_FILE + '.' + Date.now() + '.bak');
        }
    }
    catch { /* 轮转失败不影响主流程 */ }
}
class Logger {
    minLevel;
    // server 模式下 stdout 是 JSON 通信通道，日志只写文件
    get serverMode() { return !!process.env.AGENT_SERVER_MODE; }
    constructor() {
        const envLevel = process.env.LOG_LEVEL;
        this.minLevel = envLevel && LEVEL_RANK[envLevel] !== undefined ? envLevel : 'info';
    }
    write(level, msg, meta) {
        if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel])
            return;
        const entry = {
            ts: new Date().toISOString(),
            level,
            msg,
            ...meta,
        };
        const line = JSON.stringify(entry);
        // 控制台输出（非 server 模式）
        if (!this.serverMode) {
            const prefix = { debug: '\x1b[90m[DBG]\x1b[0m', info: '\x1b[36m[INF]\x1b[0m', warn: '\x1b[33m[WRN]\x1b[0m', error: '\x1b[31m[ERR]\x1b[0m' }[level];
            const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
            process.stderr.write(`${prefix} ${entry.ts.slice(11, 23)} ${msg}${metaStr}\n`);
        }
        // 文件持久化（始终写入）
        try {
            ensureLogDir();
            rotateIfNeeded();
            appendFileSync(LOG_FILE, line + '\n', 'utf-8');
        }
        catch { /* 文件写入失败不影响主流程 */ }
    }
    debug(msg, meta) { this.write('debug', msg, meta); }
    info(msg, meta) { this.write('info', msg, meta); }
    warn(msg, meta) { this.write('warn', msg, meta); }
    error(msg, meta) { this.write('error', msg, meta); }
    // 创建带固定 meta 前缀的子 logger（如 logger.child({ component: 'gateway' })）
    child(defaultMeta) {
        return new ChildLogger(this, defaultMeta);
    }
}
class ChildLogger {
    parent;
    meta;
    constructor(parent, meta) {
        this.parent = parent;
        this.meta = meta;
    }
    debug(msg, extra) { this.parent.debug(msg, { ...this.meta, ...extra }); }
    info(msg, extra) { this.parent.info(msg, { ...this.meta, ...extra }); }
    warn(msg, extra) { this.parent.warn(msg, { ...this.meta, ...extra }); }
    error(msg, extra) { this.parent.error(msg, { ...this.meta, ...extra }); }
}
export const logger = new Logger();
