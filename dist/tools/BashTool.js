import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';
import { AsyncLocalStorage } from 'async_hooks';
import { z } from 'zod';
import { auditLog } from '../core/audit.js';
import { logger } from '../core/logger.js';
const log = logger.child({ component: 'bash-tool' });
// ── 会话级 cwd 隔离（AsyncLocalStorage） ─────────────────────────────────
// 每个 runMessage 调用链在自己的 AsyncLocalStorage 上下文中运行，
// cwd 变更只影响当前会话，多会话并发不会互相污染。
function initDefaultCwd() {
    const dir = path.join(homedir(), '.hrids-agent', 'work');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
const DEFAULT_CWD = initDefaultCwd();
// 每个异步上下文存储 { cwd: string }
const cwdStorage = new AsyncLocalStorage();
/**
 * 在指定 cwd 上下文中运行 fn。
 * SessionManager.runMessage 在调用前用此函数包裹，确保整个调用链使用会话自己的 cwd。
 */
export function runWithCwd(cwd, fn) {
    return cwdStorage.run({ cwd }, fn);
}
/**
 * 获取当前异步上下文的 cwd。
 * 若不在任何上下文中（CLI 单会话模式），返回全局 fallback。
 */
export function getGlobalCwd() {
    return cwdStorage.getStore()?.cwd ?? _fallbackCwd;
}
/**
 * 更新当前异步上下文的 cwd（等价于原来的 setGlobalCwd）。
 * 只影响当前会话的调用链，不影响其他会话。
 */
export function setGlobalCwd(dir) {
    const store = cwdStorage.getStore();
    if (store) {
        store.cwd = dir;
    }
    else {
        // 不在任何上下文中（CLI 模式）：回退到修改 DEFAULT_CWD 的行为
        // 用一个模块级变量兜底，保持 CLI 模式兼容
        _fallbackCwd = dir;
    }
}
// CLI 模式（无 AsyncLocalStorage 上下文）的 fallback
let _fallbackCwd = DEFAULT_CWD;
import { isDangerousRemovalPath } from '../core/pathSafety.js';
const inputSchema = z.object({
    command: z.string().describe('要执行的 shell 命令（bash/sh 语法）'),
    timeout: z.number().optional().describe('超时时间（毫秒），默认 60000。长时间任务（如爬虫、编译）可设置更大的值，例如 1800000（30分钟）'),
});
// 危险命令黑名单（Linux/macOS）
const BLOCKED_PATTERNS = [
    /rm\s+-rf\s+\/(?!\w)/, // rm -rf /
    /rm\s+-rf\s+~\s*$/, // rm -rf ~
    /:\(\)\{.*\}/, // fork bomb
    /dd\s+if=.*of=\/dev\//, // 覆写磁盘
    /mkfs\./, // 格式化磁盘
    />\s*\/dev\/(s|h|v|xv)d[a-z]/, // 覆写块设备
    /chmod\s+-R\s+777\s+\//, // 递归 777 根目录
    /chown\s+-R.*\s+\//, // 递归 chown 根目录
    /shutdown|reboot|halt|poweroff/, // 系统关机
    /passwd\s+root/, // 修改 root 密码
    /curl.*\|\s*(ba)?sh/, // 管道执行远程脚本
    /wget.*\|\s*(ba)?sh/, // 管道执行远程脚本
];
// 提取 rm/rmdir 命令的目标路径，用于危险路径检测
function extractRemovalTarget(command) {
    const match = command.match(/\brm\s+(?:-[a-zA-Z]*\s+)*(.+)$/);
    if (match)
        return match[1].trim().split(/\s+/)[0];
    return null;
}
export const BashTool = {
    name: 'bash',
    description: '执行 shell 命令（当前平台：Linux/macOS bash/sh），返回 stdout 和 stderr。',
    inputSchema,
    readonly: false,
    describe(input) {
        return `执行命令: ${input.command}`;
    },
    getRuleContent(input) {
        return input.command;
    },
    async checkPermission(input) {
        // 危险命令黑名单
        for (const pattern of BLOCKED_PATTERNS) {
            if (pattern.test(input.command)) {
                return { granted: false, reason: `命令包含危险模式: ${pattern}` };
            }
        }
        // 危险删除路径检测
        const removalTarget = extractRemovalTarget(input.command);
        if (removalTarget && isDangerousRemovalPath(removalTarget)) {
            return { granted: false, reason: `危险的删除目标路径: ${removalTarget}` };
        }
        return { granted: true };
    },
    async execute(input, ctx) {
        // 记录 bash 执行审计日志
        auditLog({ action: 'bash_execute', resource: input.command.slice(0, 200), result: 'allowed' });
        const cwd = getGlobalCwd();
        log.info('执行命令', { command: input.command.slice(0, 200), cwd });
        const logLine = (line, isStderr = false) => {
            // server 模式下 stdout 是 JSON 通信通道，不能直接写明文
            // CLI 模式下由 Ink UI 的 tool_log 事件渲染，不直接写 stdout/stderr
            if (!process.env.AGENT_SERVER_MODE && !ctx) {
                // 仅在既非 server 模式、又没有 UI 上下文时（如 -p 非交互模式）才直接输出
                const out = isStderr ? process.stderr : process.stdout;
                out.write(line.endsWith('\n') ? line : line + '\n');
            }
            ctx?.onLog?.(line.trimEnd());
        };
        // 拦截纯 cd 命令，直接更新持久目录
        const cdMatch = input.command.trim().match(/^cd\s+(.+)$/);
        if (cdMatch) {
            const target = cdMatch[1].trim().replace(/^["']|["']$/g, '').trim();
            const newDir = path.resolve(cwd, target);
            if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
                setGlobalCwd(newDir);
                logLine(`[bash] 切换目录: ${newDir}`);
                return { type: 'success', output: newDir };
            }
            else {
                return { type: 'error', message: `目录不存在: ${newDir}` };
            }
        }
        const timeout = input.timeout ?? 60000;
        const startTime = Date.now();
        logLine(`[bash] 开始执行: ${input.command}`);
        logLine(`[bash] 工作目录: ${cwd}`);
        return new Promise((resolve) => {
            const child = spawn('/bin/sh', ['-c', input.command], {
                cwd,
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8',
                    PYTHONUTF8: '1',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const outputChunks = [];
            const stderrChunks = [];
            child.stdout.on('data', (chunk) => {
                const text = chunk.toString('utf-8');
                text.split('\n').filter(l => l).forEach(l => logLine(`[stdout] ${l}`));
                outputChunks.push(chunk);
            });
            child.stderr.on('data', (chunk) => {
                const text = chunk.toString('utf-8').trim();
                if (!text)
                    return;
                text.split('\n').filter(l => l).forEach(l => logLine(`[stderr] ${l}`, true));
                stderrChunks.push(Buffer.from(text, 'utf-8'));
            });
            const timer = setTimeout(() => {
                logLine(`[bash] 超时 (${timeout}ms)，强制终止`);
                child.kill();
                resolve({ type: 'error', message: `命令超时（${timeout}ms）` });
            }, timeout);
            child.on('close', (code) => {
                clearTimeout(timer);
                const elapsed = Date.now() - startTime;
                logLine(`[bash] 完成，退出码: ${code}，耗时: ${elapsed}ms`);
                const output = Buffer.concat(outputChunks).toString('utf-8');
                const stderrOutput = Buffer.concat(stderrChunks).toString('utf-8');
                if (code === 0) {
                    resolve({ type: 'success', output: output || '（命令执行成功，无输出）' });
                }
                else {
                    // 非零退出码时优先用 stderr 作为错误信息，stdout 作为补充
                    const errorMsg = stderrOutput || output || `命令退出码: ${code}`;
                    resolve({ type: 'error', message: errorMsg });
                }
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                logLine(`[bash] 启动失败: ${err.message}`);
                resolve({ type: 'error', message: `启动失败: ${err.message}` });
            });
        });
    },
};
