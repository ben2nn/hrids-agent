// 权限管理器 —— 控制工具调用是否需要用户确认
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
const RULES_FILE = join(homedir(), '.hrids-agent', 'permission-rules.json');
function loadRules() {
    if (!existsSync(RULES_FILE))
        return { alwaysAllow: [], alwaysDeny: [], alwaysAsk: [], allowedPaths: [], deniedPaths: [] };
    try {
        const raw = JSON.parse(readFileSync(RULES_FILE, 'utf-8'));
        return {
            alwaysAllow: raw.alwaysAllow ?? [],
            alwaysDeny: raw.alwaysDeny ?? [],
            alwaysAsk: raw.alwaysAsk ?? [],
            allowedPaths: raw.allowedPaths ?? [],
            deniedPaths: raw.deniedPaths ?? [],
        };
    }
    catch {
        return { alwaysAllow: [], alwaysDeny: [], alwaysAsk: [], allowedPaths: [], deniedPaths: [] };
    }
}
function saveRules(rules) {
    const dir = join(homedir(), '.hrids-agent');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8');
}
// 检查路径是否匹配某个前缀规则（支持 glob 风格的 * 通配）
function matchesPathRule(filePath, rule) {
    const absFile = resolve(filePath);
    const absRule = resolve(rule);
    // 精确匹配或前缀匹配（目录）
    if (absFile === absRule)
        return true;
    if (absFile.startsWith(absRule + '/') || absFile.startsWith(absRule + '\\'))
        return true;
    // 文件名匹配（如规则 ".env" 匹配任意目录下的 .env）
    const basename = absFile.split(/[/\\]/).pop() ?? '';
    if (basename === rule || basename.startsWith(rule))
        return true;
    return false;
}
export class PermissionManager {
    mode;
    // 会话内临时批准（不持久化）
    sessionApproved = new Set();
    // 持久化规则
    rules;
    onAsk;
    constructor(mode, onAsk) {
        this.mode = mode;
        this.onAsk = onAsk;
        this.rules = loadRules();
    }
    async check(req) {
        // 只读操作始终允许
        if (req.isReadonly)
            return true;
        // 永久拒绝规则（优先级最高）
        if (this.rules.alwaysDeny.includes(req.toolName))
            return false;
        // 路径级拒绝规则（次高优先级）
        if (req.filePath && this.rules.deniedPaths.length > 0) {
            for (const rule of this.rules.deniedPaths) {
                if (matchesPathRule(req.filePath, rule)) {
                    return false;
                }
            }
        }
        // 路径级允许规则（仅在设置了 allowedPaths 时生效，相当于白名单）
        if (req.filePath && this.rules.allowedPaths.length > 0) {
            const allowed = this.rules.allowedPaths.some(rule => matchesPathRule(req.filePath, rule));
            if (!allowed) {
                // 路径不在白名单内，降级为询问
                return this.onAsk(req);
            }
        }
        // 永久允许规则（在非 alwaysAsk 覆盖时生效）
        if (this.rules.alwaysAllow.includes(req.toolName) && !this.rules.alwaysAsk.includes(req.toolName))
            return true;
        // alwaysAsk：无论模式如何，都强制询问
        if (this.rules.alwaysAsk.includes(req.toolName)) {
            return this.onAsk(req);
        }
        switch (this.mode) {
            case 'auto':
                return true;
            case 'plan':
                return false;
            case 'ask': {
                // 会话内已批准
                if (this.sessionApproved.has(req.toolName))
                    return true;
                return this.onAsk(req);
            }
        }
    }
    // 会话内临时批准
    approveSession(toolName) {
        this.sessionApproved.add(toolName);
    }
    // 永久批准（持久化到磁盘）
    approvePermanent(toolName) {
        if (!this.rules.alwaysAllow.includes(toolName)) {
            this.rules.alwaysAllow.push(toolName);
            saveRules(this.rules);
        }
    }
    // 永久拒绝
    denyPermanent(toolName) {
        if (!this.rules.alwaysDeny.includes(toolName)) {
            this.rules.alwaysDeny.push(toolName);
            saveRules(this.rules);
        }
    }
    // 永久强制询问（即使在 auto 模式下）
    askPermanent(toolName) {
        if (!this.rules.alwaysAsk.includes(toolName)) {
            this.rules.alwaysAsk.push(toolName);
            saveRules(this.rules);
        }
    }
    // 添加路径白名单（只允许写这些路径）
    allowPath(pathPrefix) {
        const p = resolve(pathPrefix);
        if (!this.rules.allowedPaths.includes(p)) {
            this.rules.allowedPaths.push(p);
            saveRules(this.rules);
        }
    }
    // 添加路径黑名单（禁止写这些路径）
    denyPath(pathPrefix) {
        const p = resolve(pathPrefix);
        if (!this.rules.deniedPaths.includes(p)) {
            this.rules.deniedPaths.push(p);
            saveRules(this.rules);
        }
    }
    // 移除路径规则
    clearPathRule(pathPrefix) {
        const p = resolve(pathPrefix);
        this.rules.allowedPaths = this.rules.allowedPaths.filter(r => r !== p);
        this.rules.deniedPaths = this.rules.deniedPaths.filter(r => r !== p);
        saveRules(this.rules);
    }
    // 移除某工具的所有持久化规则
    clearRules(toolName) {
        this.rules.alwaysAllow = this.rules.alwaysAllow.filter(t => t !== toolName);
        this.rules.alwaysDeny = this.rules.alwaysDeny.filter(t => t !== toolName);
        this.rules.alwaysAsk = this.rules.alwaysAsk.filter(t => t !== toolName);
        saveRules(this.rules);
    }
    getRules() {
        return { ...this.rules };
    }
    setMode(mode) {
        this.mode = mode;
    }
    getMode() {
        return this.mode;
    }
    isPlanMode() {
        return this.mode === 'plan';
    }
}
