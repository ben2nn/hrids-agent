// Todo 列表工具 —— 帮助智能体追踪任务进度
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { z } from 'zod';
let currentSessionId = null;
let todosUpdatedCallback = null;
export function setTodoSessionId(id) {
    currentSessionId = id;
}
export function getTodoSessionId() {
    return currentSessionId;
}
export function setTodosUpdatedCallback(cb) {
    todosUpdatedCallback = cb;
}
function getTodoFile() {
    if (currentSessionId) {
        return join(homedir(), '.hrids-agent', 'sessions', currentSessionId, 'todos.json');
    }
    return join(homedir(), '.hrids-agent', 'todos.json');
}
function loadTodos() {
    const todoFile = getTodoFile();
    if (!existsSync(todoFile))
        return [];
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = JSON.parse(readFileSync(todoFile, 'utf-8'));
        // 兼容旧格式：{ task, status } → { id, content, status, priority }
        return raw.map((item, index) => ({
            id: item.id ?? String(index + 1),
            content: item.content ?? item.task ?? '',
            status: item.status ?? 'pending',
            priority: item.priority ?? 'medium',
        }));
    }
    catch {
        return [];
    }
}
function saveTodos(todos) {
    const todoFile = getTodoFile();
    mkdirSync(dirname(todoFile), { recursive: true });
    writeFileSync(todoFile, JSON.stringify(todos, null, 2), 'utf-8');
}
const inputSchema = z.object({
    todos: z.array(z.object({
        id: z.string().describe('唯一标识符，如 "1", "2"'),
        content: z.string().describe('任务内容'),
        status: z.enum(['pending', 'in_progress', 'completed']).describe('任务状态'),
        priority: z.enum(['high', 'medium', 'low']).describe('优先级'),
    })).describe('完整的 todo 列表（会替换现有列表）'),
});
export const TodoWriteTool = {
    name: 'todo_write',
    description: '创建和管理任务列表。用于追踪复杂任务的进度，每次调用会替换整个列表。',
    inputSchema,
    readonly: false,
    describe(input) {
        const count = Array.isArray(input.todos) ? input.todos.length : 0;
        return `更新任务列表（${count} 项）`;
    },
    async execute(input) {
        // 防御：LLM 有时会传字符串或非数组，做兼容处理
        let todos = input.todos;
        if (!Array.isArray(todos)) {
            try {
                todos = JSON.parse(todos);
            }
            catch {
                todos = [];
            }
        }
        if (!Array.isArray(todos))
            todos = [];
        input = { ...input, todos };
        saveTodos(input.todos);
        // 若有 sessionId 且有回调，触发 todos_updated 推送
        if (currentSessionId && todosUpdatedCallback) {
            todosUpdatedCallback(currentSessionId, input.todos);
        }
        const summary = input.todos.map(t => {
            const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○';
            return `${icon} [${t.priority}] ${t.content}`;
        }).join('\n');
        return { type: 'success', output: `任务列表已更新:\n${summary}` };
    },
};
// 只读的 todo 读取工具
const readSchema = z.object({});
export const TodoReadTool = {
    name: 'todo_read',
    description: '读取当前任务列表',
    inputSchema: readSchema,
    readonly: true,
    async execute() {
        const todos = loadTodos();
        if (todos.length === 0)
            return { type: 'success', output: '任务列表为空。' };
        const lines = todos.map(t => {
            const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○';
            return `${icon} [${t.id}] [${t.priority}] ${t.content} (${t.status})`;
        });
        return { type: 'success', output: lines.join('\n') };
    },
};
