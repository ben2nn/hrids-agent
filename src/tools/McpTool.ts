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

// ── 连接管理 ──────────────────────────────────────────────────────────────────
// CLI 模式：进程级全局缓存（单会话，生命周期与进程相同）
// Gateway 模式：会话级缓存（key = sessionId，destroySession 时精确清理）
//
// 结构：sessionId → serverName → Client
// CLI 模式使用固定 key '__cli__'，避免与 Gateway 会话 ID 冲突
const _clientsBySession = new Map<string, Map<string, Client>>()
const CLI_SESSION_KEY = '__cli__'

function getSessionClients(sessionId: string): Map<string, Client> {
  let map = _clientsBySession.get(sessionId)
  if (!map) {
    map = new Map()
    _clientsBySession.set(sessionId, map)
  }
  return map
}

async function getOrConnectClient(config: McpServerConfig, sessionId: string): Promise<Client> {
  const clients = getSessionClients(sessionId)
  if (clients.has(config.name)) {
    return clients.get(config.name)!
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env, ...config.env } as Record<string, string>,
  })

  const client = new Client({ name: 'hrids-agent', version: '0.1.0' })
  await client.connect(transport)
  clients.set(config.name, client)
  return client
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
          readonly: false, // MCP 工具默认视为非只读

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
 * 不传 sessionId 时断开 CLI 模式的全局连接（向后兼容）。
 */
export async function disconnectAllMcp(sessionId?: string): Promise<void> {
  const sid = sessionId ?? CLI_SESSION_KEY
  const clients = _clientsBySession.get(sid)
  if (!clients) return
  for (const [, client] of clients) {
    try { await client.close() } catch { /* 忽略关闭错误 */ }
  }
  _clientsBySession.delete(sid)
}

// 将 JSON Schema 转换为 Zod schema（简化版）
function buildZodSchema(jsonSchema: Record<string, unknown>): z.ZodTypeAny {
  if (!jsonSchema || jsonSchema.type !== 'object') {
    return z.record(z.unknown())
  }

  const properties = (jsonSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>
  const required = (jsonSchema.required ?? []) as string[]
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny
    switch (prop.type) {
      case 'string':  field = z.string(); break
      case 'number':  field = z.number(); break
      case 'boolean': field = z.boolean(); break
      case 'array':   field = z.array(z.unknown()); break
      default:        field = z.unknown()
    }
    if (prop.description) field = field.describe(prop.description)
    if (!required.includes(key)) field = field.optional() as z.ZodTypeAny
    shape[key] = field
  }

  return z.object(shape)
}
