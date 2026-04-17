import { glob } from 'glob';
import { z } from 'zod';
import { getGlobalCwd } from './BashTool.js';
const inputSchema = z.object({
    pattern: z.string().describe('glob 匹配模式，如 src/**/*.ts'),
    cwd: z.string().optional().describe('搜索根目录，默认为当前工作目录'),
});
export const GlobTool = {
    name: 'glob',
    description: '用 glob 模式搜索文件路径',
    inputSchema,
    readonly: true,
    describe(input) {
        return `搜索文件: ${input.pattern}`;
    },
    async execute(input) {
        try {
            // 使用 persistentCwd（跟随 bash cd 命令），而非 process.cwd()
            const files = await glob(input.pattern, {
                cwd: input.cwd ?? getGlobalCwd(),
                nodir: true,
                absolute: false,
            });
            if (files.length === 0) {
                return { type: 'success', output: '未找到匹配的文件' };
            }
            return { type: 'success', output: files.sort().join('\n') };
        }
        catch (err) {
            return { type: 'error', message: `搜索失败: ${String(err)}` };
        }
    },
};
