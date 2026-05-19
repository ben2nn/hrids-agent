import { glob } from 'glob'
import { z } from 'zod'
import { buildTool } from '../core/Tool.js'
import { getGlobalCwd } from '../shared/cwd.js'

const inputSchema = z.object({
  pattern: z.string().describe('glob 匹配模式，如 src/**/*.ts'),
  cwd: z.string().optional().describe('搜索根目录，默认为当前工作目录'),
})

export const GlobTool = buildTool({
  name: 'glob',
  description: `用 glob 模式搜索文件路径，返回匹配的文件列表。

适用场景：查找特定类型/名称的文件（如 *.py、src/**/*.ts、**/config.json）
优势：比 bash find/ls 更快、更安全、跨平台兼容，是查找文件的首选工具

不适用场景：读取文件内容 → 用 file_read | 搜索文件内容 → 用 grep
             问候/闲聊 → 不需要任何工具`,
  inputSchema,
  readonly: true,
  stormExempt: true,  // 只读操作，豁免风暴检测
  capabilities: { parallelSafe: true },

  describe(input) {
    return `搜索文件: ${input.pattern}`
  },

  async execute(input) {
    try {
      const rootDir = input.cwd ?? getGlobalCwd()
      const files = await glob(input.pattern, {
        cwd: rootDir,
        nodir: true,
        absolute: true,  // 先用绝对路径做安全检查
      })

      // 路径遍历保护：过滤掉逃出 cwd 的结果
      const { resolve, relative } = await import('path')
      const resolvedRoot = resolve(rootDir) + (process.platform === 'win32' ? '\\' : '/')
      const safeFiles = files
        .filter(f => resolve(f).startsWith(resolvedRoot))
        .map(f => relative(rootDir, f).replace(/\\/g, '/'))  // 转回相对路径，统一用 /

      if (safeFiles.length === 0) {
        return { type: 'success', output: '未找到匹配的文件' }
      }

      return { type: 'success', output: safeFiles.sort().join('\n') }
    } catch (err) {
      return { type: 'error', message: `搜索失败: ${String(err)}` }
    }
  },
})
