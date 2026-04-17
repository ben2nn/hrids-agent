import { z } from 'zod';
// 将工具定义转换为 Anthropic API 所需的 tool 格式
export function toAnthropicTool(tool) {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: zodToJsonSchema(tool.inputSchema),
    };
}
// 简单的 Zod schema 转 JSON Schema（仅支持常用类型）
function zodToJsonSchema(schema) {
    if (schema instanceof z.ZodObject) {
        const shape = schema.shape;
        const properties = {};
        const required = [];
        for (const [key, val] of Object.entries(shape)) {
            properties[key] = zodFieldToJsonSchema(val);
            if (!(val instanceof z.ZodOptional)) {
                required.push(key);
            }
        }
        return { type: 'object', properties, required };
    }
    return { type: 'string' };
}
function zodFieldToJsonSchema(field) {
    if (field instanceof z.ZodString) {
        const base = { type: 'string' };
        const desc = field.description;
        if (desc)
            base.description = desc;
        return base;
    }
    if (field instanceof z.ZodNumber)
        return { type: 'number' };
    if (field instanceof z.ZodBoolean)
        return { type: 'boolean' };
    if (field instanceof z.ZodOptional)
        return zodFieldToJsonSchema(field.unwrap());
    if (field instanceof z.ZodArray) {
        return { type: 'array', items: zodFieldToJsonSchema(field.element) };
    }
    if (field instanceof z.ZodEnum) {
        return { type: 'string', enum: field.options };
    }
    return { type: 'string' };
}
