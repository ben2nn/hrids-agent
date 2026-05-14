# hrids-agent CLI 重构设计文档

## 1. 现状分析

### 1.1 当前架构

```
src/
├── main.ts                    # 入口，Commander 定义 + 模式分发
├── bootstrap/
│   ├── setupProvider.ts       # LLM 提供商初始化
│   └── setupSession.ts        # 会话初始化
├── modes/
│   ├── interactiveMode.ts     # 交互模式（Ink TUI）
│   ├── printMode.ts           # 非交互模式（-p）
│   ├── serverMode.ts          # Server 模式（stdin NDJSON）
│   └── gatewayMode.ts         # Gateway 模式（HTTP/WS）
├── commands/
│   ├── init.ts                # init 子命令
│   └── WorkdirCommands.ts     # 工作目录斜杠命令
├── core/
│   ├── CommandRegistry.ts     # 斜杠命令注册
│   ├── QueryEngine.ts         # 核心查询引擎（1200+ 行）
│   └── ...
└── tui/
    ├── App.tsx                 # 主 TUI 组件
    ├── SplashScreen.tsx
    ├── CommandHint.tsx
    └── FileHint.tsx
```

### 1.2 当前问题

| 问题 | 描述 |
|---|---|
| **入口臃肿** | `main.ts` 350+ 行，所有选项和逻辑堆在一起 |
| **命令无懒加载** | 所有模块在启动时同步导入，增加启动时间 |
| **TUI 组件少** | 只有 App、SplashScreen、CommandHint、FileHint 4 个组件 |
| **无自定义输入处理** | 直接使用 Ink 内置输入，未处理 Windows ConPTY 兼容问题 |
| **斜杠命令分散** | 内置命令在 CommandRegistry，技能命令在 skills/，工作目录命令在 commands/ |
| **模式分发混乱** | 4 种模式的入口判断都在 main.ts 的 action 中 |

---

## 2. 参考架构（DeepSeek-Reasonix）

### 2.1 核心设计

```
┌─────────────────────────────────────────────────────────┐
│  Commander (参数解析)                                      │
│  - 全局选项定义                                            │
│  - 子命令定义（懒加载）                                     │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  命令实现 (commands/)                                     │
│  - 每个命令独立文件                                        │
│  - 动态 import() 懒加载                                   │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  Ink TUI (ui/)                                           │
│  - App: 主循环组件                                        │
│  - PromptInput: 自定义多行编辑器                           │
│  - StreamingCard: 流式渲染                                │
│  - ToolCard: 工具调用展示                                  │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  输入处理三层架构                                          │
│  1. StdinReader: 底层终端解析                              │
│  2. KeystrokeContext: React Context 封装                  │
│  3. useKeystroke: 组件级钩子                              │
└─────────────────────────────────────────────────────────┘
```

### 2.2 值得借鉴的设计

1. **懒加载命令**: 动态 `import()` 减少启动时间
2. **自定义 StdinReader**: 解决 Windows ConPTY 兼容问题
3. **斜杠命令统一**: 所有命令通过 CommandRegistry 统一注册
4. **TUI 组件化**: PromptInput、StreamingCard 等独立组件
5. **三层输入架构**: StdinReader → KeystrokeContext → useKeystroke

---

## 3. 重构目标

### 3.1 短期目标（v0.2.0）

- [ ] 拆分 main.ts，命令懒加载
- [ ] 统一斜杠命令注册
- [ ] 增加核心 TUI 组件（PromptInput、MessageCard、ToolCard）
- [ ] 自定义 StdinReader 解决 Windows 兼容问题

### 3.2 中期目标（v0.3.0）

- [ ] 完整的斜杠命令系统（/help、/model、/sessions 等）
- [ ] 流式渲染优化（StreamingCard）
- [ ] 外部编辑器集成
- [ ] 输入历史（上下键）

### 3.3 长期目标（v1.0.0）

- [ ] 完整的 TUI 框架（参考 Ink 生态）
- [ ] 插件系统
- [ ] 主题系统

---

## 4. 详细设计

### 4.1 目录结构重构

```
src/
├── cli/
│   ├── index.ts               # 新入口：Commander 定义 + 懒加载
│   └── commands/
│       ├── init.ts            # init 子命令
│       ├── chat.ts            # chat 子命令（交互模式）
│       ├── run.ts             # run 子命令（非交互模式）
│       ├── server.ts          # server 子命令
│       ├── gateway.ts         # gateway 子命令
│       ├── sessions.ts        # sessions 子命令
│       └── doctor.ts          # doctor 子命令（健康检查）
├── core/
│   ├── QueryEngine.ts         # 保持不变
│   ├── CommandRegistry.ts     # 统一斜杠命令注册
│   └── ...
├── tui/
│   ├── App.tsx                # 主 TUI 组件（重构）
│   ├── PromptInput.tsx        # 新增：自定义多行编辑器
│   ├── MessageCard.tsx        # 新增：消息卡片
│   ├── ToolCard.tsx           # 新增：工具调用卡片
│   ├── StreamingCard.tsx      # 新增：流式渲染卡片
│   ├── StdinReader.ts         # 新增：底层终端输入解析
│   ├── KeystrokeContext.tsx    # 新增：按键事件 Context
│   └── hooks/
│       └── useKeystroke.ts    # 新增：按键事件钩子
├── modes/
│   ├── interactiveMode.ts     # 重构：使用新 TUI 组件
│   ├── printMode.ts           # 保持不变
│   ├── serverMode.ts          # 保持不变
│   └── gatewayMode.ts         # 保持不变
└── main.ts                    # 废弃，入口移至 cli/index.ts
```

### 4.2 入口文件重构

#### 4.2.1 新入口 `src/cli/index.ts`

```typescript
import { Command } from 'commander'

const program = new Command()

program
  .name('hrids-agent')
  .description('原创智能体 CLI')
  .version('0.2.0')

// 子命令定义（懒加载）
program
  .command('init')
  .description('初始化配置文件')
  .option('--force', '强制覆盖已有配置文件')
  .action(async (opts) => {
    const { runInitCommand } = await import('./commands/init.js')
    await runInitCommand({ force: opts.force })
  })

program
  .command('chat')
  .description('交互模式（默认）')
  .option('-m, --model <model>', '模型名称')
  .option('--provider <provider>', '提供商')
  .option('--craft', '自主执行模式')
  .option('--plan', '计划模式')
  .action(async (opts) => {
    const { runChatCommand } = await import('./commands/chat.js')
    await runChatCommand(opts)
  })

program
  .command('run <message>')
  .description('非交互模式：执行一条消息后退出')
  .option('-m, --model <model>', '模型名称')
  .option('--max-chars <n>', '输出字符上限')
  .action(async (message, opts) => {
    const { runRunCommand } = await import('./commands/run.js')
    await runRunCommand(message, opts)
  })

program
  .command('server')
  .description('Server 模式：持续从 stdin 读取消息')
  .action(async (opts) => {
    const { runServerCommand } = await import('./commands/server.js')
    await runServerCommand(opts)
  })

program
  .command('gateway')
  .description('Gateway 模式：启动 HTTP + WebSocket 服务')
  .option('--port <port>', '监听端口')
  .option('--host <host>', '监听地址')
  .action(async (opts) => {
    const { runGatewayCommand } = await import('./commands/gateway.js')
    await runGatewayCommand(opts)
  })

program
  .command('sessions')
  .description('列出历史会话')
  .action(async () => {
    const { runSessionsCommand } = await import('./commands/sessions.js')
    await runSessionsCommand()
  })

program
  .command('doctor')
  .description('健康检查')
  .action(async () => {
    const { runDoctorCommand } = await import('./commands/doctor.js')
    await runDoctorCommand()
  })

// 默认命令（无子命令时）
program
  .option('-m, --model <model>', '模型名称')
  .option('--craft', '自主执行模式')
  .option('--plan', '计划模式')
  .option('-p, --print <message>', '非交互模式')
  .option('--resume <sessionId>', '恢复会话')
  .option('--new-session', '创建新会话')
  .action(async (opts) => {
    if (opts.print) {
      const { runRunCommand } = await import('./commands/run.js')
      await runRunCommand(opts.print, opts)
    } else {
      const { runChatCommand } = await import('./commands/chat.js')
      await runChatCommand(opts)
    }
  })

await program.parseAsync()
```

### 4.3 TUI 组件设计

#### 4.3.1 StdinReader

```typescript
// src/tui/StdinReader.ts
// 解决 Windows ConPTY 下 Ink useInput 的兼容问题

export interface KeyEvent {
  name: string           // 按键名称：enter, escape, up, down, left, right, backspace, delete, tab
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  sequence: string       // 原始字符序列
  paste?: boolean        // 是否为粘贴事件
  pasteContent?: string  // 粘贴内容
}

type KeyHandler = (key: KeyEvent) => void

export class StdinReader {
  private handlers: Set<KeyHandler> = new Set()
  private buffer: string = ''
  private escapeTimer: NodeJS.Timeout | null = null
  private pasteBuffer: string = ''
  private inPaste: boolean = false

  constructor() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf-8')
      process.stdin.on('data', this.handleData.bind(this))
    }
  }

  subscribe(handler: KeyHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private handleData(data: string) {
    // 处理 bracketed paste（ESC[200~ ... ESC[201~）
    if (data === '\x1b[200~') {
      this.inPaste = true
      this.pasteBuffer = ''
      return
    }
    if (data === '\x1b[201~') {
      this.inPaste = false
      this.emit({
        name: 'paste',
        ctrl: false, shift: false, alt: false, meta: false,
        sequence: this.pasteBuffer,
        paste: true,
        pasteContent: this.pasteBuffer,
      })
      return
    }
    if (this.inPaste) {
      this.pasteBuffer += data
      return
    }

    // 解析按键
    const key = this.parseKey(data)
    if (key) this.emit(key)
  }

  private parseKey(data: string): KeyEvent | null {
    // CSI 序列解析（方向键、功能键等）
    // 普通字符解析
    // ...
  }

  private emit(key: KeyEvent) {
    for (const handler of this.handlers) {
      handler(key)
    }
  }

  destroy() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
  }
}

let instance: StdinReader | null = null
export function getStdinReader(): StdinReader {
  if (!instance) instance = new StdinReader()
  return instance
}
```

#### 4.3.2 KeystrokeContext

```typescript
// src/tui/KeystrokeContext.tsx
import React, { createContext, useContext, useEffect, useRef } from 'react'
import { getStdinReader, type KeyEvent } from './StdinReader.js'

const KeystrokeContext = createContext<KeyEvent | null>(null)

export function KeystrokeProvider({ children }: { children: React.ReactNode }) {
  const [lastKey, setLastKey] = React.useState<KeyEvent | null>(null)

  useEffect(() => {
    const reader = getStdinReader()
    const unsubscribe = reader.subscribe((key) => {
      setLastKey(key)
    })
    return unsubscribe
  }, [])

  return (
    <KeystrokeContext.Provider value={lastKey}>
      {children}
    </KeystrokeContext.Provider>
  )
}

export function useKeystroke(handler: (key: KeyEvent) => void, isActive = true) {
  const lastKey = useContext(KeystrokeContext)
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (isActive && lastKey) {
      handlerRef.current(lastKey)
    }
  }, [lastKey, isActive])
}
```

#### 4.3.3 PromptInput

```typescript
// src/tui/PromptInput.tsx
import React, { useState, useCallback } from 'react'
import { Box, Text } from 'ink'
import { useKeystroke } from './KeystrokeContext.js'

interface PromptInputProps {
  onSubmit: (text: string) => void
  disabled?: boolean
}

export function PromptInput({ onSubmit, disabled }: PromptInputProps) {
  const [text, setText] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  useKeystroke((key) => {
    if (disabled) return

    if (key.name === 'enter' && !key.shift) {
      // 提交
      if (text.trim()) {
        onSubmit(text.trim())
        setHistory(prev => [...prev, text.trim()])
        setText('')
        setCursorPos(0)
        setHistoryIndex(-1)
      }
    } else if (key.name === 'backspace') {
      // 删除光标前字符
      if (cursorPos > 0) {
        setText(prev => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos))
        setCursorPos(prev => prev - 1)
      }
    } else if (key.name === 'delete') {
      // 删除光标后字符
      setText(prev => prev.slice(0, cursorPos) + prev.slice(cursorPos + 1))
    } else if (key.name === 'left') {
      setCursorPos(prev => Math.max(0, prev - 1))
    } else if (key.name === 'right') {
      setCursorPos(prev => Math.min(text.length, prev + 1))
    } else if (key.name === 'home') {
      setCursorPos(0)
    } else if (key.name === 'end') {
      setCursorPos(text.length)
    } else if (key.name === 'up') {
      // 历史上一条
      if (history.length > 0) {
        const newIndex = historyIndex === -1
          ? history.length - 1
          : Math.max(0, historyIndex - 1)
        setHistoryIndex(newIndex)
        setText(history[newIndex])
        setCursorPos(history[newIndex].length)
      }
    } else if (key.name === 'down') {
      // 历史下一条
      if (historyIndex !== -1) {
        const newIndex = historyIndex + 1
        if (newIndex >= history.length) {
          setHistoryIndex(-1)
          setText('')
          setCursorPos(0)
        } else {
          setHistoryIndex(newIndex)
          setText(history[newIndex])
          setCursorPos(history[newIndex].length)
        }
      }
    } else if (key.ctrl && key.name === 'c') {
      // Ctrl+C 中断
      setText('')
      setCursorPos(0)
    } else if (key.ctrl && key.name === 'u') {
      // Ctrl+U 清除当前行
      setText('')
      setCursorPos(0)
    } else if (key.paste) {
      // 粘贴
      const newText = text.slice(0, cursorPos) + key.pasteContent + text.slice(cursorPos)
      setText(newText)
      setCursorPos(cursorPos + key.pasteContent!.length)
    } else if (key.sequence && !key.ctrl && !key.alt && !key.meta) {
      // 普通字符输入
      const newText = text.slice(0, cursorPos) + key.sequence + text.slice(cursorPos)
      setText(newText)
      setCursorPos(cursorPos + key.sequence.length)
    }
  }, !disabled)

  // 渲染输入框
  const beforeCursor = text.slice(0, cursorPos)
  const atCursor = text[cursorPos] || ' '
  const afterCursor = text.slice(cursorPos + 1)

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{'> '}</Text>
        <Text>{beforeCursor}</Text>
        <Text inverse>{atCursor}</Text>
        <Text>{afterCursor}</Text>
      </Box>
    </Box>
  )
}
```

#### 4.3.4 MessageCard

```typescript
// src/tui/MessageCard.tsx
import React from 'react'
import { Box, Text } from 'ink'

interface MessageCardProps {
  role: 'user' | 'assistant' | 'system'
  content: string
  thinking?: string
}

export function MessageCard({ role, content, thinking }: MessageCardProps) {
  const roleColor = role === 'user' ? 'blue' : role === 'assistant' ? 'green' : 'yellow'
  const roleLabel = role === 'user' ? '你' : role === 'assistant' ? '助手' : '系统'

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={roleColor} bold>[{roleLabel}]</Text>
      </Box>
      {thinking && (
        <Box marginLeft={2} marginBottom={1}>
          <Text dimColor italic>💭 {thinking}</Text>
        </Box>
      )}
      <Box marginLeft={2}>
        <Text>{content}</Text>
      </Box>
    </Box>
  )
}
```

#### 4.3.5 ToolCard

```typescript
// src/tui/ToolCard.tsx
import React from 'react'
import { Box, Text } from 'ink'

interface ToolCardProps {
  name: string
  input: unknown
  result?: { type: 'success' | 'error'; output?: string; message?: string }
  status: 'running' | 'success' | 'error' | 'denied'
}

export function ToolCard({ name, input, result, status }: ToolCardProps) {
  const statusIcon = {
    running: '⏳',
    success: '✅',
    error: '❌',
    denied: '🚫',
  }[status]

  const statusColor = {
    running: 'yellow',
    success: 'green',
    error: 'red',
    denied: 'red',
  }[status]

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Box>
        <Text color={statusColor}>{statusIcon} </Text>
        <Text bold>{name}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{JSON.stringify(input, null, 2).slice(0, 200)}</Text>
      </Box>
      {result && (
        <Box marginLeft={2}>
          <Text color={result.type === 'success' ? 'green' : 'red'}>
            {result.type === 'success' ? result.output : result.message}
          </Text>
        </Box>
      )}
    </Box>
  )
}
```

### 4.4 斜杠命令统一

#### 4.4.1 统一注册

```typescript
// src/core/CommandRegistry.ts（重构）

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>()

  register(cmd: SlashCommand) {
    this.commands.set(cmd.name, cmd)
  }

  // 批量注册
  registerAll(cmds: SlashCommand[]) {
    for (const cmd of cmds) this.register(cmd)
  }

  // 从 SkillRegistry 注册
  registerSkills(skillRegistry: SkillRegistry) {
    // ... 保持不变
  }

  find(name: string): SlashCommand | undefined {
    return this.commands.get(name)
  }

  parse(input: string): { name: string; args: string } | null {
    if (!input.startsWith('/')) return null
    // ... 保持不变
  }

  getAll(): SlashCommand[] {
    return Array.from(this.commands.values())
  }

  // 获取帮助文本
  getHelpText(): string {
    const cmds = this.getAll()
    const lines = cmds.map(cmd => {
      const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : ''
      return `  /${cmd.name}${hint}  ${cmd.description}`
    })
    return `可用命令:\n${lines.join('\n')}`
  }
}
```

#### 4.4.2 内置命令扩展

```typescript
// src/commands/builtin.ts

export function createBuiltinCommands(ctx: CommandContext): SlashCommand[] {
  return [
    // 保持原有命令
    { name: 'clear', ... },
    { name: 'compact', ... },
    { name: 'cost', ... },
    { name: 'model', ... },
    { name: 'session', ... },
    { name: 'help', ... },
    { name: 'plan', ... },
    { name: 'commit', ... },
    { name: 'review', ... },
    { name: 'exit', ... },
    { name: 'history', ... },
    { name: 'new-session', ... },
    { name: 'new', ... },
    { name: 'sessions', ... },
    { name: 'resume', ... },

    // 新增命令
    {
      name: 'doctor',
      description: '运行健康检查',
      async execute() {
        return { type: 'inject', prompt: '请运行健康检查，验证配置、API 连接、MCP 服务器等是否正常。' }
      },
    },
    {
      name: 'config',
      description: '查看或修改配置',
      argumentHint: '[key] [value]',
      async execute(args, ctx) {
        // ...
      },
    },
  ]
}
```

### 4.5 交互模式重构

```typescript
// src/modes/interactiveMode.ts（重构）

import React from 'react'
import { render } from 'ink'
import { App } from '../tui/App.js'
import { KeystrokeProvider } from '../tui/KeystrokeContext.js'
import { CommandRegistry, createBuiltinCommands } from '../core/CommandRegistry.js'
// ...

export async function runInteractiveMode(
  engine: QueryEngine,
  provider: LLMProvider,
  opts: InteractiveModeOpts,
): Promise<void> {
  // 注册命令
  const registry = new CommandRegistry()
  registry.registerAll(createBuiltinCommands(/* ctx */))
  registry.registerAll(createWorkdirCommands())
  registry.registerSkills(skillRegistry)

  // 进入 alternate screen
  process.stdout.write('\x1b[?1049h\x1b[H')

  try {
    const { waitUntilExit } = render(
      <KeystrokeProvider>
        <App
          engine={engine}
          commands={registry}
          sessionId={opts.sessionId}
          // ...
        />
      </KeystrokeProvider>,
    )

    await waitUntilExit()
  } finally {
    // 退出 alternate screen
    process.stdout.write('\x1b[?1049l')
  }
}
```

### 4.6 App 组件重构

```typescript
// src/tui/App.tsx（重构）

import React, { useState, useCallback, useEffect } from 'react'
import { Box, Text, useApp } from 'ink'
import { PromptInput } from './PromptInput.js'
import { MessageCard } from './MessageCard.js'
import { ToolCard } from './ToolCard.js'
import { SplashScreen } from './SplashScreen.js'
import { CommandHint } from './CommandHint.js'
import type { QueryEngine, StreamEvent } from '../core/QueryEngine.js'
import type { CommandRegistry, CommandResult } from '../core/CommandRegistry.js'

interface AppProps {
  engine: QueryEngine
  commands: CommandRegistry
  sessionId: string
  currentModel: string
  providerName: string
}

export function App({ engine, commands, sessionId, currentModel, providerName }: AppProps) {
  const { exit } = useApp()
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [showSplash, setShowSplash] = useState(true)
  const [statusText, setStatusText] = useState('')

  // 处理用户输入
  const handleSubmit = useCallback(async (text: string) => {
    // 斜杠命令处理
    if (text.startsWith('/')) {
      const parsed = commands.parse(text)
      if (parsed) {
        const cmd = commands.find(parsed.name)
        if (cmd) {
          const result = await cmd.execute(parsed.args, commandContext)
          handleCommandResult(result)
          return
        }
      }
    }

    // 发送给 LLM
    setIsStreaming(true)
    setShowSplash(false)

    try {
      for await (const event of engine.send(text)) {
        handleStreamEvent(event)
      }
    } finally {
      setIsStreaming(false)
    }
  }, [engine, commands])

  // 处理流式事件
  const handleStreamEvent = useCallback((event: StreamEvent) => {
    switch (event.type) {
      case 'text_delta':
        // 更新流式文本
        break
      case 'tool_start':
        // 显示工具卡片
        break
      case 'tool_end':
        // 更新工具状态
        break
      case 'usage':
        // 更新成本信息
        break
      case 'done':
        // 完成
        break
      // ...
    }
  }, [])

  // 渲染
  return (
    <Box flexDirection="column" padding={1}>
      {/* 状态栏 */}
      <Box marginBottom={1}>
        <Text color="cyan">hrids-agent</Text>
        <Text dimColor> | {providerName}:{currentModel}</Text>
        <Text dimColor> | 会话: {sessionId.slice(0, 8)}</Text>
      </Box>

      {/* 消息列表 */}
      <Box flexDirection="column" flexGrow={1}>
        {showSplash && <SplashScreen />}
        {messages.map((msg, i) => (
          <MessageCard key={i} role={msg.role} content={msg.content} />
        ))}
      </Box>

      {/* 状态提示 */}
      {isStreaming && (
        <Box>
          <Text color="yellow">⏳ 思考中...</Text>
        </Box>
      )}

      {/* 命令提示 */}
      <CommandHint />

      {/* 输入框 */}
      <PromptInput onSubmit={handleSubmit} disabled={isStreaming} />
    </Box>
  )
}
```

---

## 5. 实施计划

### 5.1 Phase 1: 基础重构（1-2 天）

1. 创建 `src/cli/index.ts` 新入口
2. 拆分子命令到 `src/cli/commands/`
3. 实现懒加载
4. 更新 `package.json` 的 `bin` 和 `scripts`

### 5.2 Phase 2: TUI 组件（2-3 天）

1. 实现 `StdinReader`
2. 实现 `KeystrokeContext`
3. 实现 `PromptInput`
4. 实现 `MessageCard` 和 `ToolCard`

### 5.3 Phase 3: 命令系统（1-2 天）

1. 统一斜杠命令注册
2. 扩展内置命令
3. 实现 `/help` 命令

### 5.4 Phase 4: 测试和优化（1-2 天）

1. 单元测试
2. 集成测试
3. 性能优化
4. 文档更新

---

## 6. 兼容性考虑

### 6.1 向后兼容

- 保持现有 CLI 选项不变
- 保持现有配置文件格式不变
- 保持现有斜杠命令不变

### 6.2 Windows 兼容

- StdinReader 处理 Windows ConPTY 的 ESC 序列超时
- 处理 Windows 路径分隔符
- 处理 Windows 编码问题

### 6.3 终端兼容

- 支持基本 ANSI 转义序列
- 降级处理不支持的功能
- 检测终端能力

---

## 7. 风险和缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| StdinReader 兼容性问题 | 高 | 保留 Ink useInput 作为降级方案 |
| 性能回归 | 中 | 基准测试对比启动时间和响应速度 |
| 功能缺失 | 高 | 逐个迁移，保持功能完整 |
| 用户习惯改变 | 低 | 保持默认行为不变 |

---

## 8. 参考资源

- [DeepSeek-Reasonix 源码](https://github.com/...)
- [Ink 文档](https://github.com/vadimdemedes/ink)
- [Commander.js 文档](https://github.com/tj/commander.js)
- [ANSI 转义序列参考](https://en.wikipedia.org/wiki/ANSI_escape_code)
