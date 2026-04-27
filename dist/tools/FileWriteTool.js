import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { z } from 'zod';
import { auditLog } from '../core/audit.js';
import { checkWritePath } from '../core/pathSafety.js';
import { getGlobalCwd } from './BashTool.js';
const inputSchema = z.object({
    path: z.string().describe('要写入的文件路径'),
    content: z.string().describe('文件内容'),
});
export const FileWriteTool = {
    name: 'file_write',
    description: '创建或覆盖写入文件，自动创建父目录',
    inputSchema,
    readonly: false,
    isDestructive: true, // 覆盖写入是不可逆操作
    describe(input) {
        return `写入文件: ${input.path}`;
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
            auditLog({ action: 'file_write', resource: input.path, result: 'error', details: { error: safety.reason } });
            return { type: 'error', message: safety.reason };
        }
        const filePath = resolve(cwd, input.path);
        try {
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, input.content, 'utf-8');
            auditLog({ action: 'file_write', resource: filePath, result: 'allowed' });
            return { type: 'success', output: `文件已写入: ${filePath}` };
        }
        catch (err) {
            auditLog({ action: 'file_write', resource: filePath, result: 'error', details: { error: String(err) } });
            return { type: 'error', message: `写入失败: ${String(err)}` };
        }
    },
};
