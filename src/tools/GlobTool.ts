import { glob } from 'glob'
import { z } from 'zod'
import { buildTool } from '../core/Tool.js'
import { getGlobalCwd } from '../core/cwd.js'

const inputSchema = z.object({
  pattern: z.string().describe('glob 匹配模式，如 src/**/*.ts'),
  cwd: z.string().optional().describe('搜索根目录，默认为当前工作目录'),
})

export const GlobTool = buildTool({
  name: 'glob',
  description: `用 glob 模式搜索文件路径，返回匹配的文件列表。
适用场景：查找特定类型/名称的文件（如 *.py、src/**/*.ts）
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
      // 使用 persistentCwd（跟随 bash cd 命令），而非 process.cwd()
      const files = await glob(input.pattern, {
        cwd: input.cwd ?? getGlobalCwd(),
        nodir: true,
        absolute: false,
      })

      if (files.length === 0) {
        return { type: 'success', output: '未找到匹配的文件' }
      }

      return { type: 'success', output: files.sort().join('\n') }
    } catch (err) {
      return { type: 'error', message: `搜索失败: ${String(err)}` }
    }
  },
})
