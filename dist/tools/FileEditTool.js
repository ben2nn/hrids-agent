import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { auditLog } from '../core/audit.js';
import { checkWritePath } from '../core/pathSafety.js';
import { getGlobalCwd } from './BashTool.js';
const inputSchema = z.object({
    path: z.string().describe('要编辑的文件路径'),
    oldStr: z.string().describe('要替换的原始字符串（必须在文件中唯一存在）'),
    newStr: z.string().describe('替换后的新字符串'),
});
export const FileEditTool = {
    name: 'file_edit',
    description: '对文件做精确的字符串替换，oldStr 必须在文件中唯一',
    inputSchema,
    readonly: false,
    describe(input) {
        return `编辑文件: ${input.path}`;
    },
    getFilePath(input) {
        return input.path;
    },
    getRuleContent(input) {
        return input.path;
    },
    async execute(input) {
        const cwd = getGlobalCwd();
        // 路径安全检查
        const safety = checkWritePath(input.path, cwd);
        if (!safety.safe) {
            auditLog({ action: 'file_edit', resource: input.path, result: 'error', details: { error: safety.reason } });
            return { type: 'error', message: safety.reason };
        }
        // 相对路径基于当前工作目录（persistentCwd）解析，绝对路径保持不变
        const filePath = resolve(cwd, input.path);
        if (!existsSync(filePath)) {
            return { type: 'error', message: `文件不存在: ${filePath}` };
        }
        try {
            const content = readFileSync(filePath, 'utf-8');
            const count = content.split(input.oldStr).length - 1;
            if (count === 0) {
                return { type: 'error', message: '未找到要替换的字符串' };
            }
            if (count > 1) {
                return { type: 'error', message: `找到 ${count} 处匹配，oldStr 必须唯一` };
            }
            const updated = content.replace(input.oldStr, input.newStr);
            writeFileSync(filePath, updated, 'utf-8');
            auditLog({ action: 'file_edit', resource: filePath, result: 'allowed' });
            return { type: 'success', output: `文件已更新: ${filePath}` };
        }
        catch (err) {
            auditLog({ action: 'file_edit', resource: filePath, result: 'error', details: { error: String(err) } });
            return { type: 'error', message: `编辑失败: ${String(err)}` };
        }
    },
};
