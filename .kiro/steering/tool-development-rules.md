# 工具开发规范（src/tools/）

## 工作目录规则（最重要）

所有涉及文件系统路径的工具，**必须**使用 `getGlobalCwd()` 来解析相对路径，而不是依赖 `process.cwd()`。

### 必须遵守的模式

```typescript
import { resolve } from 'path'
import { getGlobalCwd } from './BashTool.js'

// ✅ 正确：相对路径基于 persistentCwd 解析
const filePath = resolve(getGlobalCwd(), input.path)

// ❌ 错误：直接使用 input.path，Node.js 会用 process.cwd() 解析相对路径
writeFileSync(input.path, content)
```

### 适用范围

以下操作**必须**先调用 `resolve(getGlobalCwd(), input.path)` 解析路径：
- `readFileSync` / `writeFileSync` / `appendFileSync`
- `existsSync` / `statSync` / `mkdirSync`
- `readdirSync` / `rmSync` / `renameSync`
- `glob()` 的 `cwd` 参数
- 任何接受文件路径的第三方库调用

### 例外情况

以下路径**不应**跟随工作目录，应使用固定的用户主目录路径：
- `~/.hrids-agent/` 下的持久化数据文件（todos.json、crons.json、memory 等）
- 这类路径使用 `join(homedir(), '.hrids-agent', ...)` 硬编码，不受 `cd` 影响

## 新工具文件模板

创建新工具时，使用以下结构：

```typescript
import { z } from 'zod'
import { resolve } from 'path'           // 如果涉及文件路径
import type { ToolDef } from '../core/Tool.js'
import { getGlobalCwd } from './BashTool.js'  // 如果涉及文件路径
import { auditLog } from '../core/audit.js'   // 如果有写操作

const inputSchema = z.object({
  path: z.string().describe('文件路径'),
  // ...
})

export const MyTool: ToolDef<typeof inputSchema> = {
  name: 'my_tool',
  description: '工具描述',
  inputSchema,
  readonly: false, // 只读工具设为 true

  describe(input) {
    return `操作描述: ${input.path}`
  },

  async execute(input) {
    // 路径解析：相对路径基于 persistentCwd，绝对路径保持不变
    const filePath = resolve(getGlobalCwd(), input.path)

    try {
      // ... 实际操作使用 filePath，不使用 input.path
      auditLog({ action: 'my_action', resource: filePath, result: 'allowed' })
      return { type: 'success', output: `操作完成: ${filePath}` }
    } catch (err) {
      auditLog({ action: 'my_action', resource: filePath, result: 'error', details: { error: String(err) } })
      return { type: 'error', message: `操作失败: ${String(err)}` }
    }
  },
}
```

## 注册新工具

新工具创建后，必须在 `src/tools/index.ts` 中注册：

1. 在顶部 import 区域添加导入
2. 在 `export { ... }` 中添加具名导出
3. 在 `ALL_TOOLS` 数组中添加工具实例

## 工具分类规范

- `readonly: true` — 只读操作（读文件、搜索、查询），不修改任何状态
- `readonly: false` — 写操作（写文件、执行命令、修改数据）

## 审计日志规范

所有写操作工具（`readonly: false`）必须调用 `auditLog()`：
- 操作成功时：`result: 'allowed'`
- 操作失败时：`result: 'error'`，并附带 `details: { error: String(err) }`
