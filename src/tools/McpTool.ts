// MCP (Model Context Protocol) 工具集成
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpToolInfo {
  name: string        // 格式: mcp__serverName__toolName
  description: string
  inputSchema: Record<string, unknown>
}

// ── 连接池管理 ────────────────────────────────────────────────────────────────
// CLI 模式：进程级全局缓存（单会话，生命周期与进程相同）
// Gateway 模式：会话级缓存（key = sessionId，destroySession 时精确清理）
//
// 结构：sessionId → serverName → PooledClient
// CLI 模式使用固定 key '__cli__'，避免与 Gateway 会话 ID 冲突

interface PooledClient {
  client: Client
  config: McpServerConfig
  createdAt: number
  lastUsedAt: number
  /** 标记连接是否可能已失效（调用失败后置 true，下次使用时重连） */
  unhealthy: boolean
}

const _clientsBySession = new Map<string, Map<string, PooledClient>>()
const CLI_SESSION_KEY = '__cli__'

/** 空闲超时：30 分钟未使用的连接自动关闭 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** 定期清理空闲连接的定时器（进程级单例） */
let _cleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureCleanupTimer(): void {
  if (_cleanupTimer) return
  _cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [sid, clients] of _clientsBySession) {
      for (const [name, pooled] of clients) {
        if (now - pooled.lastUsedAt > IDLE_TIMEOUT_MS) {
          pooled.client.close().catch(() => {})
          clients.delete(name)
        }
      }
      if (clients.size === 0) _clientsBySession.delete(sid)
    }
  }, 60_000)
  _cleanupTimer.unref()
}

function getSessionClients(sessionId: string): Map<string, PooledClient> {
  let map = _clientsBySession.get(sessionId)
  if (!map) {
    map = new Map()
    _clientsBySession.set(sessionId, map)
  }
  return map
}

/** 创建新连接并封装为 PooledClient */
async function createPooledClient(config: McpServerConfig): Promise<PooledClient> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env, ...config.env } as Record<string, string>,
  })

  const client = new Client({ name: 'hrids-agent', version: '0.1.0' })
  await client.connect(transport)
  return {
    client,
    config,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    unhealthy: false,
  }
}

/**
 * 获取或创建 MCP 连接（带健康检查 + 自动重连）。
 * 1. 缓存命中且健康 → 直接复用
 * 2. 缓存命中但标记为 unhealthy → 关闭旧连接，重新创建
 * 3. 缓存未命中 → 创建新连接
 */
async function getOrConnectClient(config: McpServerConfig, sessionId: string): Promise<Client> {
  ensureCleanupTimer()
  const clients = getSessionClients(sessionId)
  const existing = clients.get(config.name)

  if (existing) {
    if (existing.unhealthy) {
      // 连接已标记为不健康，关闭后重建
      existing.client.close().catch(() => {})
      clients.delete(config.name)
    } else {
      existing.lastUsedAt = Date.now()
      return existing.client
    }
  }

  const pooled = await createPooledClient(config)
  clients.set(config.name, pooled)
  return pooled.client
}

/** 将连接标记为不健康（调用失败时由 execute 调用） */
function markUnhealthy(sessionId: string, serverName: string): void {
  const clients = _clientsBySession.get(sessionId)
  const pooled = clients?.get(serverName)
  if (pooled) pooled.unhealthy = true
}

/**
 * 从 MCP 服务器动态生成工具列表。
 * sessionId 用于将连接绑定到当前会话（Gateway 模式传入，CLI 模式不传）。
 */
export async function loadMcpTools(configs: McpServerConfig[], sessionId?: string): Promise<ToolDef[]> {
  const sid = sessionId ?? CLI_SESSION_KEY
  const tools: ToolDef[] = []

  for (const config of configs) {
    try {
      const client = await getOrConnectClient(config, sid)
      const { tools: mcpTools } = await client.listTools()

      for (const mcpTool of mcpTools) {
        const toolName = `mcp__${config.name}__${mcpTool.name}`
        const inputSchema = buildZodSchema(mcpTool.inputSchema as Record<string, unknown>)

        tools.push({
          name: toolName,
          description: `[MCP:${config.name}] ${mcpTool.description ?? mcpTool.name}`,
          inputSchema,
          readonly: false,
          capabilities: { requiresNetwork: true, parallelSafe: false },

          describe() {
            return `MCP ${config.name}/${mcpTool.name}`
          },

          async execute(input) {
            try {
              const c = await getOrConnectClient(config, sid)
              const result = await c.callTool({
                name: mcpTool.name,
                arguments: input as Record<string, unknown>,
              })

              const content = result.content
              if (Array.isArray(content)) {
                const text = content
                  .map((item: { type: string; text?: string }) =>
                    item.type === 'text' ? item.text : JSON.stringify(item)
                  )
                  .join('\n')
                return { type: 'success', output: text }
              }
              return { type: 'success', output: JSON.stringify(result) }
            } catch (err) {
              // 调用失败 → 标记连接为不健康，下次使用时自动重连
              markUnhealthy(sid, config.name)
              return { type: 'error', message: `MCP 调用失败: ${String(err)}` }
            }
          },
        })
      }
    } catch (err) {
      console.error(`MCP 服务器 ${config.name} 连接失败: ${err}`)
    }
  }

  return tools
}

/**
 * 断开指定会话的所有 MCP 连接（Gateway 模式 destroySession 时调用）。
 * 不传 sessionId 时断开 CLI 模式的全局连接。
 */
export async function disconnectAllMcp(sessionId?: string): Promise<void> {
  const sid = sessionId ?? CLI_SESSION_KEY
  const clients = _clientsBySession.get(sid)
  if (!clients) return

  // 给每个 close 调用加超时，防止卡住
  const closeWithTimeout = async (client: { close: () => Promise<void> }) => {
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('MCP close timeout')), 3000)
    )
    await Promise.race([client.close(), timeout])
  }

  for (const [, pooled] of clients) {
    try { await closeWithTimeout(pooled.client) } catch { /* 忽略关闭错误/超时 */ }
  }
  _clientsBySession.delete(sid)

  // 所有会话都清理后，停止定时器
  if (_clientsBySession.size === 0 && _cleanupTimer) {
    clearInterval(_cleanupTimer)
    _cleanupTimer = null
  }
}

// 将 JSON Schema 转换为 Zod schema（简化版，支持嵌套对象和 enum）
function buildZodSchema(jsonSchema: Record<string, unknown>): z.ZodTypeAny {
  if (!jsonSchema || jsonSchema.type !== 'object') {
    return z.record(z.unknown())
  }

  const properties = (jsonSchema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = (jsonSchema.required ?? []) as string[]
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, prop] of Object.entries(properties)) {
    let field = buildFieldSchema(prop)
    if (prop.description) field = field.describe(prop.description as string)
    if (!required.includes(key)) field = field.optional() as z.ZodTypeAny
    shape[key] = field
  }

  return z.object(shape)
}

/** 将单个 JSON Schema 属性转换为 Zod 字段类型 */
function buildFieldSchema(prop: Record<string, unknown>): z.ZodTypeAny {
  // enum 优先于 type
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]])
  }

  switch (prop.type) {
    case 'string':  return z.string()
    case 'number':
    case 'integer': return z.number()
    case 'boolean': return z.boolean()
    case 'array': {
      const items = prop.items as Record<string, unknown> | undefined
      const itemSchema = items ? buildFieldSchema(items) : z.unknown()
      return z.array(itemSchema)
    }
    case 'object': {
      const nested = buildZodSchema(prop as Record<string, unknown>)
      return nested
    }
    default:        return z.unknown()
  }
}
