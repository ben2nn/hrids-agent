// MCP (Model Context Protocol) 工具集成
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
// 已连接的 MCP 客户端缓存
const connectedClients = new Map();
async function getOrConnectClient(config) {
    if (connectedClients.has(config.name)) {
        return connectedClients.get(config.name);
    }
    const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...process.env, ...config.env },
    });
    const client = new Client({ name: 'hrids-agent', version: '0.1.0' });
    await client.connect(transport);
    connectedClients.set(config.name, client);
    return client;
}
// 从 MCP 服务器动态生成工具列表
export async function loadMcpTools(configs) {
    const tools = [];
    for (const config of configs) {
        try {
            const client = await getOrConnectClient(config);
            const { tools: mcpTools } = await client.listTools();
            for (const mcpTool of mcpTools) {
                const toolName = `mcp__${config.name}__${mcpTool.name}`;
                const inputSchema = buildZodSchema(mcpTool.inputSchema);
                tools.push({
                    name: toolName,
                    description: `[MCP:${config.name}] ${mcpTool.description ?? mcpTool.name}`,
                    inputSchema,
                    readonly: false, // MCP 工具默认视为非只读
                    describe(input) {
                        return `MCP ${config.name}/${mcpTool.name}`;
                    },
                    async execute(input) {
                        try {
                            const client = await getOrConnectClient(config);
                            const result = await client.callTool({
                                name: mcpTool.name,
                                arguments: input,
                            });
                            const content = result.content;
                            if (Array.isArray(content)) {
                                const text = content
                                    .map((c) => c.type === 'text' ? c.text : JSON.stringify(c))
                                    .join('\n');
                                return { type: 'success', output: text };
                            }
                            return { type: 'success', output: JSON.stringify(result) };
                        }
                        catch (err) {
                            return { type: 'error', message: `MCP 调用失败: ${String(err)}` };
                        }
                    },
                });
            }
        }
        catch (err) {
            console.error(`MCP 服务器 ${config.name} 连接失败: ${err}`);
        }
    }
    return tools;
}
// 将 JSON Schema 转换为 Zod schema（简化版）
function buildZodSchema(jsonSchema) {
    if (!jsonSchema || jsonSchema.type !== 'object') {
        return z.record(z.unknown());
    }
    const properties = (jsonSchema.properties ?? {});
    const required = (jsonSchema.required ?? []);
    const shape = {};
    for (const [key, prop] of Object.entries(properties)) {
        let field;
        switch (prop.type) {
            case 'string':
                field = z.string();
                break;
            case 'number':
                field = z.number();
                break;
            case 'boolean':
                field = z.boolean();
                break;
            case 'array':
                field = z.array(z.unknown());
                break;
            default: field = z.unknown();
        }
        if (prop.description)
            field = field.describe(prop.description);
        if (!required.includes(key))
            field = field.optional();
        shape[key] = field;
    }
    return z.object(shape);
}
export async function disconnectAllMcp() {
    for (const [name, client] of connectedClients) {
        try {
            await client.close();
        }
        catch { /* 忽略关闭错误 */ }
        connectedClients.delete(name);
    }
}
